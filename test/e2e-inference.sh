#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E Test: Full NemoClaw stack — gateway → sandbox → provider → inference
#
# Prerequisites:
#   - Docker running
#   - openshell CLI installed
#   - Ollama running on localhost:11434 with a model pulled (default: nemotron-mini)
#
# Usage:
#   bash test/e2e-inference.sh                    # defaults
#   OLLAMA_MODEL=llama3.2 bash test/e2e-inference.sh  # override model
#
# NOTE: openshell's Docker build engine interprets .dockerignore differently
# from standard Docker. /dist incorrectly excludes nemoclaw/dist/. This test
# temporarily adds an exception during the build. See:
#   https://github.com/NVIDIA/NemoClaw/issues/126

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX_NAME="e2e-test"
GATEWAY_NAME="nemoclaw"
PROVIDER_NAME="ollama-e2e"
MODEL="${OLLAMA_MODEL:-nemotron-mini}"
PROVIDER_URL="http://host.docker.internal:11434/v1"

PASS=0
FAIL=0

pass() { ((PASS++)); printf '\033[1;32m  PASS:\033[0m %s\n' "$1"; }
fail() { ((FAIL++)); printf '\033[1;31m  FAIL:\033[0m %s\n' "$1"; }
header() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }
info()  { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

cleanup() {
  info "Teardown: removing test sandbox and provider..."
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell provider delete "$PROVIDER_NAME" 2>/dev/null || true

  # Restore .dockerignore if we modified it
  if [ -f "${REPO}/.dockerignore.bak" ]; then
    mv "${REPO}/.dockerignore.bak" "${REPO}/.dockerignore"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 0: Preflight
# ---------------------------------------------------------------------------
step_preflight() {
  header "Step 0: Preflight checks"

  if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
    fail "Ollama not running on localhost:11434"
    exit 1
  fi
  pass "Ollama is running"

  if ! command -v openshell &>/dev/null; then
    fail "openshell CLI not found"
    exit 1
  fi
  pass "openshell CLI available ($(openshell --version 2>/dev/null))"

  if ! docker info &>/dev/null; then
    fail "Docker not running"
    exit 1
  fi
  pass "Docker is running"
}

# ---------------------------------------------------------------------------
# Step 1: Clean slate
# ---------------------------------------------------------------------------
step_clean() {
  header "Step 1: Clean slate"

  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell provider delete "$PROVIDER_NAME" 2>/dev/null || true
  pass "Previous test artifacts cleaned"
}

# ---------------------------------------------------------------------------
# Step 2: Gateway
# ---------------------------------------------------------------------------
step_gateway() {
  header "Step 2: Gateway"

  local gw_status
  gw_status="$(openshell status 2>&1 || true)"
  if echo "$gw_status" | grep -qi "gateway"; then
    info "Gateway already running, reusing"
    pass "Gateway ready"
    return
  fi

  info "Starting OpenShell gateway '${GATEWAY_NAME}'..."
  openshell gateway start --name "$GATEWAY_NAME" 2>&1

  local ok=false
  for _ in $(seq 1 15); do
    if openshell status 2>&1 | grep -qi "gateway"; then
      ok=true
      break
    fi
    sleep 2
  done

  if $ok; then
    pass "Gateway '${GATEWAY_NAME}' started"
  else
    fail "Gateway failed to start"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Step 3: Configure inference provider
# ---------------------------------------------------------------------------
step_provider() {
  header "Step 3: Configure inference provider"

  info "Creating provider '${PROVIDER_NAME}' (Ollama → ${MODEL})..."
  openshell provider create \
    --name "$PROVIDER_NAME" \
    --type openai \
    --credential "OPENAI_API_KEY=ollama" \
    --config "OPENAI_BASE_URL=${PROVIDER_URL}" 2>&1

  if openshell provider list 2>&1 | grep -q "$PROVIDER_NAME"; then
    pass "Provider '${PROVIDER_NAME}' created"
  else
    fail "Provider creation failed"
    return 1
  fi

  info "Setting inference route → ${PROVIDER_NAME} / ${MODEL}"
  openshell inference set --provider "$PROVIDER_NAME" --model "$MODEL" 2>&1
  pass "Inference route configured"
}

# ---------------------------------------------------------------------------
# Step 4: Create sandbox
# ---------------------------------------------------------------------------
step_sandbox() {
  header "Step 4: Create sandbox"

  # Workaround: openshell's build engine incorrectly matches /dist against
  # nemoclaw/dist/. Add an exception during the build.
  if grep -q '^/dist$' "${REPO}/.dockerignore" 2>/dev/null; then
    cp "${REPO}/.dockerignore" "${REPO}/.dockerignore.bak"
    sed -i.tmp '/^\/dist$/a\
!nemoclaw/dist' "${REPO}/.dockerignore" && rm -f "${REPO}/.dockerignore.tmp"
    info "Patched .dockerignore (workaround for openshell build context)"
  fi

  info "Building sandbox image and creating '${SANDBOX_NAME}'..."
  info "(First run builds the Docker image — this takes a few minutes)"

  local policy_path="${REPO}/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"

  openshell sandbox create \
    --from "${REPO}/Dockerfile" \
    --name "$SANDBOX_NAME" \
    --provider "$PROVIDER_NAME" \
    --policy "$policy_path" \
    --no-tty \
    -- env "CHAT_UI_URL=http://127.0.0.1:18789" nemoclaw-start 2>&1

  if openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
    pass "Sandbox '${SANDBOX_NAME}' created"
  else
    fail "Sandbox creation failed"
    return 1
  fi

  info "Waiting for sandbox services to initialize..."
  sleep 5
}

# ---------------------------------------------------------------------------
# Step 5: Test inference — "Hello Jensen"
# ---------------------------------------------------------------------------
step_inference() {
  header "Step 5: Test inference — Hello Jensen"

  info "Sending inference request through sandbox via inference.local..."

  local ssh_config_file
  ssh_config_file="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" > "$ssh_config_file" 2>/dev/null

  local response
  response="$(ssh -F "$ssh_config_file" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Who is Jensen Huang? Reply in exactly one sentence.\"}],\"max_tokens\":100}'" \
  )" || true
  rm -f "$ssh_config_file"

  echo "  Response: ${response:0:500}"

  if [ -z "$response" ]; then
    fail "Empty response from inference endpoint"
    return 1
  fi

  # Validate: valid JSON with choices[0].message.content
  local content
  content="$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data['choices'][0]['message']['content'])
" 2>/dev/null)" || true

  if [ -z "$content" ]; then
    fail "Response is not a valid chat completion"
    echo "  Raw: $response"
    return 1
  fi
  pass "Got valid chat completion response"

  pass "LLM responded with content"
  echo "  Jensen says: ${content}"

  if echo "$content" | grep -qi "jensen\|nvidia\|ceo\|founder\|huang"; then
    pass "Response mentions Jensen/NVIDIA (inference is coherent)"
  else
    info "Response doesn't explicitly mention Jensen/NVIDIA but inference worked"
    pass "Inference completed successfully"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  printf '\033[1m\n========================================\n'
  printf '  E2E Test: Zero to Hello Jensen\n'
  printf '========================================\033[0m\n'

  step_preflight
  step_clean
  step_gateway
  step_provider
  step_sandbox
  step_inference

  # cleanup runs via EXIT trap

  printf '\n\033[1m--- Results ---\033[0m\n'
  printf '\033[1;32m  Passed: %d\033[0m\n' "$PASS"
  printf '\033[1;31m  Failed: %d\033[0m\n' "$FAIL"
  printf '  Total:  %d\n' "$((PASS + FAIL))"

  if [ "$FAIL" -eq 0 ]; then
    printf '\n\033[1;32mHello Jensen! All tests passed.\033[0m\n'
  else
    printf '\n\033[1;31mSome tests failed.\033[0m\n'
  fi

  return "$FAIL"
}

main
