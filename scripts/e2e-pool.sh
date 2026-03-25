#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Warm pool management for Brev E2E test instances.
#
# Subcommands:
#   status             — Full pool dashboard (instances, age, health, claims)
#   list               — List warm instances (name, status, age)
#   count              — Count available warm instances
#   claim              — Claim the first available warm instance
#   health-check NAME  — Verify instance is healthy
#   warm [COUNT]       — Start new warm instances to reach target pool size
#   bootstrap NAME     — Bootstrap a created instance (Docker, Node, openshell, sandbox)
#   cycle              — Destroy instances older than $INSTANCE_MAX_AGE_HOURS
#   deploy NAME DIR    — Deploy branch code to a claimed instance
#
# Required:
#   brev CLI on PATH, authenticated (brev login --token ...)
#
# Environment:
#   BREV_ORG                — Brev org for all operations (default: Nemoclaw CI/CD)
#   WARM_POOL_SIZE          — Target number of warm instances (default: 3)
#   WARM_POOL_PREFIX        — Instance name prefix (default: e2e-warm-)
#   BREV_CPU                — Instance CPU spec (default: 4x16)
#   INSTANCE_MAX_AGE_HOURS  — Max instance age before cycling (default: 24)
#   GITHUB_RUN_ID           — CI run ID (used by claim)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BREV_ORG="${BREV_ORG:-Nemoclaw CI/CD}"
WARM_POOL_SIZE="${WARM_POOL_SIZE:-3}"
WARM_POOL_PREFIX="${WARM_POOL_PREFIX:-e2e-warm-}"
BREV_CPU="${BREV_CPU:-4x16}"
INSTANCE_MAX_AGE_HOURS="${INSTANCE_MAX_AGE_HOURS:-24}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[pool]${NC} $1" >&2; }
warn() { echo -e "${YELLOW}[pool]${NC} $1" >&2; }
error() { echo -e "${RED}[pool]${NC} $1" >&2; }
fail() {
  error "$1"
  exit 1
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Ensure the active org is set before commands that don't support --org
# (brev create, brev delete). This is critical — without it, instances
# land in the wrong org as GPU instances at $0.72/hr instead of CPU at $0.13/hr.
ensure_org() {
  info "Setting active org to '$BREV_ORG'"
  brev set "$BREV_ORG" >/dev/null 2>&1 || fail "Failed to set org to '$BREV_ORG'"
}

# Parse 'brev ls' output into structured lines.
# brev ls output format (observed):
#   NAME              STATUS   BUILD      SHELL  ID         MACHINE
#   nemoclaw-e5db8f   RUNNING  COMPLETED  READY  3qthuu0ey  n2d-standard-4 (gpu)
#
# We filter to warm pool instances and output: NAME STATUS BUILD
brev_ls_warm() {
  brev ls --org "$BREV_ORG" 2>/dev/null \
    | grep -E "^\s*${WARM_POOL_PREFIX}" \
    | awk '{print $1, $2, $3}' \
    || true
}

# SSH to a Brev instance with standard options.
# Brev configures SSH via ~/.ssh/config with ProxyCommand, so we can
# ssh directly by instance name after 'brev refresh'.
pool_ssh() {
  local name="$1"
  shift
  ssh -o StrictHostKeyChecking=no \
    -o LogLevel=ERROR \
    -o ConnectTimeout=15 \
    "$name" "$@"
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

# list — List warm instances: NAME STATUS BUILD
cmd_list() {
  brev_ls_warm
}

# status — Full dashboard: all org instances + warm pool enrichment
#
# Shows every instance in the Brev org, then for warm pool instances
# adds age, claim status, and health. This is the "what's going on?"
# command you run to understand pool state at a glance.
cmd_status() {
  local now
  now=$(date +%s)

  echo ""
  echo "  Warm Pool Status  ·  org: $BREV_ORG  ·  target: $WARM_POOL_SIZE"
  echo "  $(printf '─%.0s' {1..60})"
  echo ""

  # Get all instances in the org (not just warm-prefixed)
  local all_instances
  all_instances=$(brev ls --org "$BREV_ORG" 2>/dev/null | grep -E '^\s+\S+\s+(RUNNING|STARTING|STOPPING|STOPPED|DEPLOYING)' || true)

  if [ -z "$all_instances" ]; then
    echo "  No instances in org."
    echo ""
    printf "  %-12s %s\n" "Available:" "0 / $WARM_POOL_SIZE"
    echo ""
    return 0
  fi

  # Refresh SSH config for health/claim checks
  brev refresh >/dev/null 2>&1 || true

  local warm_ready=0
  local warm_building=0
  local warm_claimed=0
  local other_count=0

  # Print header
  printf "  %-28s %-10s %-12s %-8s %-10s %s\n" "NAME" "STATUS" "BUILD" "AGE" "POOL" "DETAIL"
  echo "  $(printf '─%.0s' {1..60})"

  while IFS= read -r line; do
    local name status build
    name=$(echo "$line" | awk '{print $1}')
    status=$(echo "$line" | awk '{print $2}')
    build=$(echo "$line" | awk '{print $3}')

    # Is this a warm pool instance?
    if [[ "$name" == ${WARM_POOL_PREFIX}* ]]; then
      # Parse age from timestamp in name
      local ts age_str=""
      ts=$(echo "$name" | sed -n "s/^${WARM_POOL_PREFIX}\([0-9]*\)-.*/\1/p")
      if [ -n "$ts" ]; then
        local age_seconds=$((now - ts))
        local age_h=$((age_seconds / 3600))
        local age_m=$(((age_seconds % 3600) / 60))
        age_str="${age_h}h${age_m}m"
      else
        age_str="?"
      fi

      # Determine pool state
      local pool_state="—"
      local detail=""

      if [ "$status" != "RUNNING" ] || [ "$build" != "COMPLETED" ]; then
        pool_state="BUILDING"
        detail="$status/$build"
        warm_building=$((warm_building + 1))
      else
        # Check if claimed (try SSH, with short timeout)
        local claimed_by=""
        claimed_by=$(pool_ssh "$name" "cat /tmp/.e2e-claimed 2>/dev/null" 2>/dev/null) || true

        if [ -n "$claimed_by" ]; then
          pool_state="CLAIMED"
          detail="run: $claimed_by"
          warm_claimed=$((warm_claimed + 1))
        else
          pool_state="READY"
          warm_ready=$((warm_ready + 1))
        fi
      fi

      printf "  %-28s %-10s %-12s %-8s %-10s %s\n" "$name" "$status" "$build" "$age_str" "$pool_state" "$detail"
    else
      # Non-pool instance
      other_count=$((other_count + 1))
      printf "  %-28s %-10s %-12s %-8s %-10s %s\n" "$name" "$status" "$build" "—" "(other)" ""
    fi
  done <<<"$all_instances"

  echo ""
  echo "  $(printf '─%.0s' {1..60})"
  printf "  %-12s %s\n" "Ready:" "$warm_ready / $WARM_POOL_SIZE"
  printf "  %-12s %s\n" "Building:" "$warm_building"
  printf "  %-12s %s\n" "Claimed:" "$warm_claimed"
  if [ "$other_count" -gt 0 ]; then
    printf "  %-12s %s\n" "Other:" "$other_count (not managed by pool)"
  fi

  local deficit=$((WARM_POOL_SIZE - warm_ready))
  if [ "$deficit" -gt 0 ] && [ "$warm_building" -eq 0 ]; then
    echo ""
    echo "  ⚠  Pool below target. Run: e2e-pool.sh warm"
  fi
  echo ""
}

# count — Count available (RUNNING + COMPLETED build) warm instances
cmd_count() {
  local count
  count=$(brev_ls_warm | awk '$2 == "RUNNING" && $3 == "COMPLETED"' | wc -l)
  echo "$((count))"
}

# claim — Claim the first available warm instance
#
# 1. Lists warm instances with RUNNING status and COMPLETED build
# 2. SSH into each, attempt to write claim file
# 3. If file already exists (race), try next instance
# 4. Output instance name on success, exit 1 if none available
cmd_claim() {
  local run_id="${GITHUB_RUN_ID:-local-$$}"
  local instances
  instances=$(brev_ls_warm | awk '$2 == "RUNNING" && $3 == "COMPLETED" {print $1}')

  if [ -z "$instances" ]; then
    error "No warm instances available"
    exit 1
  fi

  # Refresh SSH config so instance names resolve
  brev refresh >/dev/null 2>&1 || true

  for name in $instances; do
    info "Attempting to claim $name ..."

    # Atomic claim: write only if file doesn't exist (bash noclobber).
    # Use bash explicitly — default shell may be sh which handles noclobber differently.
    local claim_cmd
    claim_cmd="bash -c 'set -C; echo \"${run_id}\" > /tmp/.e2e-claimed 2>/dev/null && echo CLAIMED'"

    local result
    result=$(pool_ssh "$name" "$claim_cmd" 2>/dev/null) || true

    if [ "$result" = "CLAIMED" ]; then
      # Verify by reading back
      local verify
      verify=$(pool_ssh "$name" "cat /tmp/.e2e-claimed 2>/dev/null") || true
      if [ "$verify" = "$run_id" ]; then
        info "Claimed $name for run $run_id"
        echo "$name"
        return 0
      else
        warn "$name: claim verification failed (got '$verify', expected '$run_id')"
      fi
    else
      warn "$name: already claimed or SSH failed, trying next..."
    fi
  done

  error "Failed to claim any warm instance"
  exit 1
}

# health-check NAME — Verify instance is healthy
cmd_health_check() {
  local name="${1:?Usage: e2e-pool.sh health-check <name>}"

  # Refresh SSH config
  brev refresh >/dev/null 2>&1 || true

  # Check 1: SSH connectivity
  if ! pool_ssh "$name" "echo ok" >/dev/null 2>&1; then
    echo "UNHEALTHY: SSH connection failed"
    return 1
  fi

  # Check 2: Docker running
  if ! pool_ssh "$name" "docker info >/dev/null 2>&1" 2>/dev/null; then
    echo "UNHEALTHY: Docker not running"
    return 1
  fi

  # Check 3: openshell responds
  if ! pool_ssh "$name" "command -v openshell >/dev/null 2>&1" 2>/dev/null; then
    echo "UNHEALTHY: openshell not found"
    return 1
  fi

  # Check 4: Node.js present
  if ! pool_ssh "$name" "node --version >/dev/null 2>&1" 2>/dev/null; then
    echo "UNHEALTHY: Node.js not found"
    return 1
  fi

  echo "HEALTHY"
  return 0
}

# warm [COUNT] — Start new warm instances to reach target pool size
#
# Uses brev create + SSH bootstrap (not brev start --setup-script, which
# was validated as non-functional for deploying launchables).
#
# Instance bootstrap happens asynchronously — this command starts the
# creation and returns immediately. The pool warmer workflow is responsible
# for polling until instances are ready.
cmd_warm() {
  local target="${1:-$WARM_POOL_SIZE}"
  local current
  current=$(cmd_count)

  local needed=$((target - current))
  if [ "$needed" -le 0 ]; then
    info "Pool already at target size ($current/$target)"
    return 0
  fi

  info "Pool has $current instances, target is $target — warming $needed more"

  # Must set org before brev create (no --org flag on create)
  ensure_org

  local timestamp
  timestamp=$(date +%s)

  for i in $(seq 1 "$needed"); do
    local name
    name="${WARM_POOL_PREFIX}${timestamp}-$(printf '%03d' "$i")"
    info "Creating instance $name (cpu: $BREV_CPU) ..."

    if brev create "$name" --cpu "$BREV_CPU" --detached 2>&1; then
      info "Created $name — building in background"
      echo "$name"
    else
      warn "Failed to create $name — continuing with remaining"
    fi
  done

  info "Warm-up initiated. Instances will take ~40 min to build."
  info "Bootstrap via SSH must be run separately once instances reach RUNNING state."
}

# cycle — Destroy instances older than $INSTANCE_MAX_AGE_HOURS
#
# Brev ls doesn't expose creation timestamps directly, so we use instance
# name encoding: e2e-warm-<unix_timestamp>-NNN. If timestamp is older
# than threshold, destroy it.
cmd_cycle() {
  local max_age_seconds=$((INSTANCE_MAX_AGE_HOURS * 3600))
  local now
  now=$(date +%s)
  local instances
  instances=$(brev_ls_warm | awk '{print $1}')

  if [ -z "$instances" ]; then
    info "No warm instances to cycle"
    return 0
  fi

  ensure_org

  for name in $instances; do
    # Extract timestamp from name: e2e-warm-<timestamp>-NNN
    local ts
    ts=$(echo "$name" | sed -n "s/^${WARM_POOL_PREFIX}\([0-9]*\)-.*/\1/p")

    if [ -z "$ts" ]; then
      warn "Cannot parse timestamp from $name — skipping"
      continue
    fi

    local age_seconds=$((now - ts))
    local age_hours=$((age_seconds / 3600))

    if [ "$age_seconds" -gt "$max_age_seconds" ]; then
      info "Destroying $name (age: ${age_hours}h, threshold: ${INSTANCE_MAX_AGE_HOURS}h)"
      if brev delete "$name" 2>&1; then
        echo "$name"
      else
        warn "Failed to delete $name"
      fi
    else
      info "Keeping $name (age: ${age_hours}h, threshold: ${INSTANCE_MAX_AGE_HOURS}h)"
    fi
  done
}

# bootstrap NAME — Bootstrap a newly created instance via SSH
#
# Once brev create finishes and the instance reaches RUNNING state,
# this command SSHs in and runs brev-setup.sh to install Docker, Node.js,
# openshell, and build the NemoClaw sandbox image.
#
# This is the slow step (~40 min) that warm pooling amortizes. The warmer
# workflow calls this asynchronously after instance creation.
#
# Requires NVIDIA_API_KEY and GITHUB_TOKEN in the environment.
cmd_bootstrap() {
  local name="${1:?Usage: e2e-pool.sh bootstrap <name>}"

  [ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY not set — required for bootstrap"
  [ -n "${GITHUB_TOKEN:-}" ] || fail "GITHUB_TOKEN not set — required for bootstrap"

  # Refresh SSH config
  brev refresh >/dev/null 2>&1 || true

  # Wait for SSH to become available (instance may still be provisioning)
  info "Waiting for SSH on $name ..."
  local max_attempts=60
  local attempt=0
  while [ "$attempt" -lt "$max_attempts" ]; do
    if pool_ssh "$name" "echo ok" >/dev/null 2>&1; then
      info "SSH ready on $name"
      break
    fi
    attempt=$((attempt + 1))
    if [ "$((attempt % 10))" -eq 0 ]; then
      info "Still waiting for SSH on $name (attempt $attempt/$max_attempts) ..."
      brev refresh >/dev/null 2>&1 || true
    fi
    sleep 5
  done

  if [ "$attempt" -ge "$max_attempts" ]; then
    fail "SSH never became available on $name after $max_attempts attempts"
  fi

  local remote_home
  remote_home=$(pool_ssh "$name" "echo \$HOME" 2>/dev/null) || fail "SSH failed for $name"
  local remote_dir="${remote_home}/nemoclaw"

  # Sync the repo (for brev-setup.sh and setup.sh)
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repo_dir
  repo_dir="$(cd "$script_dir/.." && pwd)"

  info "Rsyncing repo to $name:$remote_dir ..."
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude .venv \
    "$repo_dir/" "$name:$remote_dir/" \
    || fail "rsync failed"

  # Run brev-setup.sh with secrets passed via stdin (not CLI args)
  info "Running brev-setup.sh on $name (this takes ~40 min) ..."
  local secret_preamble
  secret_preamble="export NVIDIA_API_KEY='${NVIDIA_API_KEY}'; export GITHUB_TOKEN='${GITHUB_TOKEN}'; export NEMOCLAW_NON_INTERACTIVE=1; export NEMOCLAW_SANDBOX_NAME=e2e-test"

  pool_ssh "$name" "eval '$secret_preamble' && cd $remote_dir && bash scripts/brev-setup.sh" \
    || fail "Bootstrap failed on $name"

  info "Bootstrap complete for $name"
}

# deploy NAME DIR — Deploy branch code to a claimed instance
#
# Steps:
#   1. Wipe existing repo (clean slate)
#   2. Rsync fresh code (exclude .git, node_modules, dist)
#   3. Run npm ci (deterministic from lockfile)
#   4. Verify deployment
cmd_deploy() {
  local name="${1:?Usage: e2e-pool.sh deploy <name> <repo-dir>}"
  local repo_dir="${2:?Usage: e2e-pool.sh deploy <name> <repo-dir>}"

  if [ ! -d "$repo_dir" ]; then
    fail "Repository directory not found: $repo_dir"
  fi

  # Refresh SSH config
  brev refresh >/dev/null 2>&1 || true

  local remote_home
  remote_home=$(pool_ssh "$name" "echo \$HOME" 2>/dev/null) || fail "SSH failed for $name"
  local remote_dir="${remote_home}/nemoclaw"

  # Step 1: Wipe existing repo
  info "Wiping $remote_dir on $name ..."
  pool_ssh "$name" "rm -rf $remote_dir" || fail "Failed to wipe $remote_dir"

  # Step 2: Rsync fresh code
  info "Rsyncing code from $repo_dir to $name:$remote_dir ..."
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude .venv \
    "$repo_dir/" "$name:$remote_dir/" \
    || fail "rsync failed"

  # Step 3: Install dependencies
  info "Running npm ci on $name ..."
  pool_ssh "$name" "cd $remote_dir && npm ci" \
    || fail "npm ci failed on $name"

  # Step 4: Verify deployment
  info "Verifying deployment on $name ..."
  pool_ssh "$name" "cd $remote_dir && node -e 'require(\"./package.json\")'" \
    || fail "Deployment verification failed on $name"

  info "Code deployed to $name:$remote_dir"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
usage() {
  cat >&2 <<EOF
Usage: e2e-pool.sh <command> [args...]

Commands:
  status                 Full pool dashboard (instances, age, health, claims)
  list                   List warm instances (NAME STATUS BUILD)
  count                  Count available warm instances
  claim                  Claim the first available warm instance
  health-check <name>    Verify instance is healthy
  warm [count]           Start new warm instances to reach target pool size
  bootstrap <name>       Bootstrap a created instance (Docker, Node, openshell, sandbox)
  cycle                  Destroy instances older than threshold
  deploy <name> <dir>    Deploy branch code to a claimed instance

Environment:
  BREV_ORG                Brev org (default: Nemoclaw CI/CD)
  WARM_POOL_SIZE          Target pool size (default: 3)
  WARM_POOL_PREFIX        Instance name prefix (default: e2e-warm-)
  BREV_CPU                CPU spec (default: 4x16)
  INSTANCE_MAX_AGE_HOURS  Max age in hours (default: 24)
  GITHUB_RUN_ID           CI run ID (used by claim)
EOF
  exit 1
}

command="${1:-}"
shift || true

case "$command" in
  status) cmd_status ;;
  list) cmd_list ;;
  count) cmd_count ;;
  claim) cmd_claim ;;
  health-check) cmd_health_check "$@" ;;
  warm) cmd_warm "$@" ;;
  bootstrap) cmd_bootstrap "$@" ;;
  cycle) cmd_cycle ;;
  deploy) cmd_deploy "$@" ;;
  -h | --help) usage ;;
  *)
    error "Unknown command: $command"
    usage
    ;;
esac
