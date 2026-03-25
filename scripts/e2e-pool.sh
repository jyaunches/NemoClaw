#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Warm pool management for Brev E2E test instances.
#
# Requires Brev CLI v0.6.322+ (--type, --startup-script, brev exec).
#
# Subcommands:
#   status             — Full pool dashboard (instances, age, health, claims)
#   list               — List warm instances (name, status, build)
#   count              — Count available warm instances
#   claim              — Claim the first available warm instance
#   health-check NAME  — Verify instance is healthy
#   warm [COUNT]       — Create and bootstrap warm instances to reach target
#   cycle              — Destroy instances older than $INSTANCE_MAX_AGE_HOURS
#   deploy NAME DIR    — Deploy branch code to a claimed instance
#
# Required:
#   brev CLI v0.6.322+ on PATH, authenticated (brev login --token ...)
#
# Environment:
#   BREV_ORG                — Brev org for all operations (default: Nemoclaw CI/CD)
#   WARM_POOL_SIZE          — Target number of warm instances (default: 3)
#   WARM_POOL_PREFIX        — Instance name prefix (default: e2e-warm-)
#   BREV_INSTANCE_TYPE      — Instance type (default: n2d-standard-4, CPU @ $0.13/hr)
#   INSTANCE_MAX_AGE_HOURS  — Max instance age before cycling (default: 24)
#   GITHUB_RUN_ID           — CI run ID (used by claim)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BREV_ORG="${BREV_ORG:-Nemoclaw CI/CD}"
WARM_POOL_SIZE="${WARM_POOL_SIZE:-3}"
WARM_POOL_PREFIX="${WARM_POOL_PREFIX:-e2e-warm-}"
BREV_INSTANCE_TYPE="${BREV_INSTANCE_TYPE:-n2d-standard-4}"
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

# Ensure the active org is set. Required before brev create/delete which
# don't support --org. Without this, instances land in the wrong org.
ensure_org() {
  info "Setting active org to '$BREV_ORG'"
  brev set "$BREV_ORG" >/dev/null 2>&1 || fail "Failed to set org to '$BREV_ORG'"
}

# Parse 'brev ls' output for warm pool instances.
# v0.6.322 output format:
#   NAME                     STATUS   BUILD      SHELL  ID         MACHINE          GPU
#   e2e-warm-1774467060-001  RUNNING  COMPLETED  READY  4o7ci8dk7  n2d-standard-4   -
#
# Output: NAME STATUS BUILD (one per line)
brev_ls_warm() {
  brev ls --org "$BREV_ORG" 2>/dev/null \
    | grep -E "^\s*${WARM_POOL_PREFIX}" \
    | awk '{print $1, $2, $3}' \
    || true
}

# Run a command on a remote instance via brev exec.
# Unlike SSH, brev exec auto-resolves instances and waits for readiness.
brev_exec() {
  local name="$1"
  shift
  brev exec "$name" "$@"
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

# list — List warm instances: NAME STATUS BUILD
cmd_list() {
  brev_ls_warm
}

# status — Full dashboard: all org instances + warm pool enrichment
cmd_status() {
  local now
  now=$(date +%s)

  echo ""
  echo "  Warm Pool Status  ·  org: $BREV_ORG  ·  target: $WARM_POOL_SIZE  ·  type: $BREV_INSTANCE_TYPE"
  echo "  $(printf '─%.0s' {1..68})"
  echo ""

  # Get all instances in the org
  local all_instances
  all_instances=$(brev ls --org "$BREV_ORG" 2>/dev/null | grep -E '^\s+\S+\s+(RUNNING|STARTING|STOPPING|STOPPED|DEPLOYING)' || true)

  if [ -z "$all_instances" ]; then
    echo "  No instances in org."
    echo ""
    printf "  %-12s %s\n" "Available:" "0 / $WARM_POOL_SIZE"
    echo ""
    return 0
  fi

  local warm_ready=0
  local warm_building=0
  local warm_claimed=0
  local other_count=0

  printf "  %-28s %-10s %-12s %-8s %-10s %s\n" "NAME" "STATUS" "BUILD" "AGE" "POOL" "DETAIL"
  echo "  $(printf '─%.0s' {1..68})"

  while IFS= read -r line; do
    local name status build
    name=$(echo "$line" | awk '{print $1}')
    status=$(echo "$line" | awk '{print $2}')
    build=$(echo "$line" | awk '{print $3}')

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

      local pool_state="—"
      local detail=""

      if [ "$status" != "RUNNING" ] || [ "$build" != "COMPLETED" ]; then
        pool_state="BUILDING"
        detail="$status/$build"
        warm_building=$((warm_building + 1))
      else
        # Check if claimed via brev exec (stdin redirected to avoid eating heredoc)
        local claimed_by=""
        claimed_by=$(brev_exec "$name" "cat /tmp/.e2e-claimed 2>/dev/null" </dev/null 2>/dev/null) || true
        # brev exec appends the instance name as the last line — strip it
        claimed_by=$(echo "$claimed_by" | head -1)
        if [ -n "$claimed_by" ] && [ "$claimed_by" != "$name" ]; then
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
      other_count=$((other_count + 1))
      printf "  %-28s %-10s %-12s %-8s %-10s %s\n" "$name" "$status" "$build" "—" "(other)" ""
    fi
  done <<<"$all_instances"

  echo ""
  echo "  $(printf '─%.0s' {1..68})"
  printf "  %-12s %s\n" "Ready:" "$warm_ready / $WARM_POOL_SIZE"
  printf "  %-12s %s\n" "Building:" "$warm_building"
  printf "  %-12s %s\n" "Claimed:" "$warm_claimed"
  if [ "$other_count" -gt 0 ]; then
    printf "  %-12s %s\n" "Other:" "$other_count (not managed by pool)"
  fi

  local deficit=$((WARM_POOL_SIZE - warm_ready - warm_building))
  if [ "$deficit" -gt 0 ]; then
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
# Uses brev exec for atomic claim via bash noclobber.
# Output: instance name on stdout, or exit 1 if none available.
cmd_claim() {
  local run_id="${GITHUB_RUN_ID:-local-$$}"
  local instances
  instances=$(brev_ls_warm | awk '$2 == "RUNNING" && $3 == "COMPLETED" {print $1}')

  if [ -z "$instances" ]; then
    error "No warm instances available"
    exit 1
  fi

  for name in $instances; do
    info "Attempting to claim $name ..."

    # Atomic claim via noclobber — brev exec handles SSH resolution automatically
    local result
    result=$(brev_exec "$name" "bash -c 'set -C; echo \"${run_id}\" > /tmp/.e2e-claimed 2>/dev/null && echo CLAIMED'" 2>/dev/null) || true

    # brev exec appends instance name as last line
    local claim_status
    claim_status=$(echo "$result" | head -1)

    if [ "$claim_status" = "CLAIMED" ]; then
      local verify
      verify=$(brev_exec "$name" "cat /tmp/.e2e-claimed" 2>/dev/null | head -1) || true
      if [ "$verify" = "$run_id" ]; then
        info "Claimed $name for run $run_id"
        echo "$name"
        return 0
      else
        warn "$name: claim verification failed (got '$verify', expected '$run_id')"
      fi
    else
      warn "$name: already claimed or exec failed, trying next..."
    fi
  done

  error "Failed to claim any warm instance"
  exit 1
}

# health-check NAME — Verify instance is healthy
cmd_health_check() {
  local name="${1:?Usage: e2e-pool.sh health-check <name>}"

  # All checks via brev exec — no SSH config needed
  if ! brev_exec "$name" "echo ok" >/dev/null 2>&1; then
    echo "UNHEALTHY: brev exec connection failed"
    return 1
  fi

  if ! brev_exec "$name" "docker info >/dev/null 2>&1" 2>/dev/null; then
    echo "UNHEALTHY: Docker not running"
    return 1
  fi

  if ! brev_exec "$name" "command -v openshell >/dev/null 2>&1" 2>/dev/null; then
    echo "UNHEALTHY: openshell not found"
    return 1
  fi

  if ! brev_exec "$name" "node --version >/dev/null 2>&1" 2>/dev/null; then
    echo "UNHEALTHY: Node.js not found"
    return 1
  fi

  echo "HEALTHY"
  return 0
}

# warm [COUNT] — Create and bootstrap warm instances to reach target pool size.
#
# Uses brev create v0.6.322 with:
#   --type n2d-standard-4   CPU instance at $0.13/hr (not GPU at $0.72/hr)
#   --startup-script        Runs brev-setup.sh automatically after platform build
#   --detached              Returns immediately; instances build in background
#
# The startup script handles the full bootstrap: Node.js, openshell, Docker
# image build, sandbox creation. No separate bootstrap step needed.
cmd_warm() {
  local target="${1:-$WARM_POOL_SIZE}"
  local current
  current=$(cmd_count)

  # Also count instances still building (don't double-create)
  local building
  building=$(brev_ls_warm | awk '$2 == "RUNNING" && $3 != "COMPLETED"' | wc -l)
  building=$((building))

  local available=$((current + building))
  local needed=$((target - available))
  if [ "$needed" -le 0 ]; then
    info "Pool at target ($current ready + $building building = $available / $target)"
    return 0
  fi

  info "Pool has $current ready + $building building. Need $needed more to reach $target."

  ensure_org

  # Locate the self-contained startup script.
  # This script clones the repo, pre-pulls the GHCR base image, and runs
  # brev-setup.sh — all without needing the repo to be pre-rsynced.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local setup_script="$script_dir/e2e-warm-startup.sh"

  if [ ! -f "$setup_script" ]; then
    fail "Startup script not found: $setup_script"
  fi

  local timestamp
  timestamp=$(date +%s)

  for i in $(seq 1 "$needed"); do
    local name
    name="${WARM_POOL_PREFIX}${timestamp}-$(printf '%03d' "$i")"
    info "Creating $name (type: $BREV_INSTANCE_TYPE, startup-script: e2e-warm-startup.sh) ..."

    if brev create "$name" \
      --type "$BREV_INSTANCE_TYPE" \
      --startup-script "@${setup_script}" \
      --detached 2>&1 | grep -v "^$"; then
      info "Created $name — bootstrapping in background"
      echo "$name"
    else
      warn "Failed to create $name — continuing with remaining"
    fi
  done

  info "Warm-up initiated. Instances will be fully ready when BUILD reaches COMPLETED."
}

# cycle — Destroy instances older than $INSTANCE_MAX_AGE_HOURS
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
      if brev delete "$name" >/dev/null 2>&1; then
        echo "$name"
      else
        warn "Failed to delete $name"
      fi
    else
      info "Keeping $name (age: ${age_hours}h, threshold: ${INSTANCE_MAX_AGE_HOURS}h)"
    fi
  done
}

# deploy NAME DIR — Deploy branch code to a claimed instance
#
# Uses brev exec + brev copy (rsync via SSH as fallback).
cmd_deploy() {
  local name="${1:?Usage: e2e-pool.sh deploy <name> <repo-dir>}"
  local repo_dir="${2:?Usage: e2e-pool.sh deploy <name> <repo-dir>}"

  if [ ! -d "$repo_dir" ]; then
    fail "Repository directory not found: $repo_dir"
  fi

  local remote_home
  remote_home=$(brev_exec "$name" "echo \$HOME" 2>/dev/null | head -1) || fail "brev exec failed for $name"
  local remote_dir="${remote_home}/nemoclaw"

  # Step 1: Wipe existing repo
  info "Wiping $remote_dir on $name ..."
  brev_exec "$name" "rm -rf $remote_dir" >/dev/null 2>&1 || fail "Failed to wipe $remote_dir"

  # Step 2: Rsync fresh code (brev exec doesn't support file transfer,
  # so we use brev refresh + rsync as before)
  info "Syncing code from $repo_dir to $name:$remote_dir ..."
  brev refresh >/dev/null 2>&1 || true
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude .venv \
    -e "ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR" \
    "$repo_dir/" "$name:$remote_dir/" \
    || fail "rsync failed"

  # Step 3: Install dependencies
  info "Running npm ci on $name ..."
  brev_exec "$name" "cd $remote_dir && npm ci" >/dev/null 2>&1 \
    || fail "npm ci failed on $name"

  # Step 4: Verify deployment
  info "Verifying deployment on $name ..."
  brev_exec "$name" "cd $remote_dir && node -e 'require(\"./package.json\")'" >/dev/null 2>&1 \
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
  warm [count]           Create and bootstrap instances to reach target pool size
  cycle                  Destroy instances older than threshold
  deploy <name> <dir>    Deploy branch code to a claimed instance

Environment:
  BREV_ORG                Brev org (default: Nemoclaw CI/CD)
  WARM_POOL_SIZE          Target pool size (default: 3)
  WARM_POOL_PREFIX        Instance name prefix (default: e2e-warm-)
  BREV_INSTANCE_TYPE      Instance type (default: n2d-standard-4)
  INSTANCE_MAX_AGE_HOURS  Max age in hours (default: 24)
  GITHUB_RUN_ID           CI run ID (used by claim)

Requires Brev CLI v0.6.322+ (brev create --type, --startup-script, brev exec)
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
  cycle) cmd_cycle ;;
  deploy) cmd_deploy "$@" ;;
  -h | --help) usage ;;
  *)
    error "Unknown command: $command"
    usage
    ;;
esac
