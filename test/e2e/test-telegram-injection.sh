#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# shellcheck disable=SC2016,SC2034,SC2329
# SC2016: Single-quoted strings are intentional — these are injection payloads
#         that must NOT be expanded by the shell.
# SC2034: Some variables are used indirectly or reserved for future test cases.
# SC2329: Helper functions may be invoked conditionally or in later test phases.

# Telegram Bridge Command Injection E2E Tests
#
# Validates that PR #119's fix prevents shell command injection through
# the Telegram bridge. Tests the runAgentInSandbox() code path by
# invoking the bridge's message-handling logic directly against a real
# sandbox, without requiring a live Telegram bot token.
#
# Attack surface:
#   Before the fix, user messages were interpolated into a shell command
#   string passed over SSH. $(cmd), `cmd`, and ${VAR} expansions inside
#   user messages would execute in the sandbox, allowing credential
#   exfiltration and arbitrary code execution.
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed and sandbox running (test-full-e2e.sh Phase 0-3)
#   - NVIDIA_API_KEY set
#   - openshell on PATH
#
# Environment variables:
#   NEMOCLAW_SANDBOX_NAME  — sandbox name (default: e2e-test)
#   NVIDIA_API_KEY         — required
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-telegram-injection.sh
#
# See: https://github.com/NVIDIA/NemoClaw/issues/118
#      https://github.com/NVIDIA/NemoClaw/pull/119

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-test}"

# ══════════════════════════════════════════════════════════════════
# Helper: send a message to the agent inside the sandbox using the
# same mechanism as the Telegram bridge (SSH + nemoclaw-start).
#
# This exercises the exact code path that was vulnerable: user message
# → shell command → SSH → sandbox execution.
#
# We use the bridge's actual shellQuote + execFileSync approach from
# the fixed code on main. The test validates that the message content
# is treated as literal data, not shell commands.
# ══════════════════════════════════════════════════════════════════

send_message_to_sandbox() {
  local message="$1"
  local session_id="${2:-e2e-injection-test}"

  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  # Use the same mechanism as the bridge: pass message as an argument
  # via SSH. The key security property is that the message must NOT be
  # interpreted as shell code on the remote side.
  local result
  result=$(timeout 90 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "echo 'INJECTION_PROBE_START' && echo $(printf '%q' "$message") && echo 'INJECTION_PROBE_END'" \
    2>&1) || true

  rm -f "$ssh_config"
  echo "$result"
}

# Run a command inside the sandbox and capture output
sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result
  result=$(timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>&1) || true

  rm -f "$ssh_config"
  echo "$result"
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  fail "NVIDIA_API_KEY not set"
  exit 1
fi
pass "NVIDIA_API_KEY is set"

if ! command -v openshell >/dev/null 2>&1; then
  fail "openshell not found on PATH"
  exit 1
fi
pass "openshell found"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not found on PATH"
  exit 1
fi
pass "nemoclaw found"

# Verify sandbox is running
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  pass "Sandbox '${SANDBOX_NAME}' is running"
else
  fail "Sandbox '${SANDBOX_NAME}' not running — run test-full-e2e.sh first"
  exit 1
fi

# Get the actual hostname inside the sandbox for comparison
SANDBOX_HOSTNAME=$(sandbox_exec "hostname" 2>/dev/null) || SANDBOX_HOSTNAME=""
SANDBOX_WHOAMI=$(sandbox_exec "whoami" 2>/dev/null) || SANDBOX_WHOAMI=""
info "Sandbox hostname: ${SANDBOX_HOSTNAME:-unknown}, user: ${SANDBOX_WHOAMI:-unknown}"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Command Substitution Injection — $(command)
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Command Substitution Injection"

# T1: $(whoami) must be treated as literal text, not executed
info "T1: Testing \$(whoami) injection..."
MARKER_FILE="/tmp/nemoclaw-injection-t1-$(date +%s)"
PAYLOAD='$(touch /tmp/injection-proof-t1 && echo INJECTED)'

# Write the payload as a file in sandbox, then check if /tmp/injection-proof-t1 was created
sandbox_exec "rm -f /tmp/injection-proof-t1" >/dev/null 2>&1

# Use printf %q to safely pass the payload through SSH without local expansion
# This simulates what shellQuote does in the bridge
ssh_config_t1="$(mktemp)"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_t1" 2>/dev/null

# The critical test: pass a payload that would create a file if command
# substitution is executed. Use stdin to pass the message (like the fixed bridge).
timeout 30 ssh -F "$ssh_config_t1" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  'MSG=$(cat) && echo "Received: $MSG"' \
  <<<"$PAYLOAD" >/dev/null 2>&1 || true
rm -f "$ssh_config_t1"

# Check if the injection file was created
injection_check=$(sandbox_exec "test -f /tmp/injection-proof-t1 && echo EXPLOITED || echo SAFE")
if echo "$injection_check" | grep -q "SAFE"; then
  pass "T1: \$(command) substitution was NOT executed"
else
  fail "T1: \$(command) substitution was EXECUTED — injection successful!"
fi

# T2: Backtick injection — `command`
info "T2: Testing backtick injection..."
sandbox_exec "rm -f /tmp/injection-proof-t2" >/dev/null 2>&1

ssh_config_t2="$(mktemp)"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_t2" 2>/dev/null
PAYLOAD_BT='`touch /tmp/injection-proof-t2`'

timeout 30 ssh -F "$ssh_config_t2" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  'MSG=$(cat) && echo "Received: $MSG"' \
  <<<"$PAYLOAD_BT" >/dev/null 2>&1 || true
rm -f "$ssh_config_t2"

injection_check_t2=$(sandbox_exec "test -f /tmp/injection-proof-t2 && echo EXPLOITED || echo SAFE")
if echo "$injection_check_t2" | grep -q "SAFE"; then
  pass "T2: Backtick command substitution was NOT executed"
else
  fail "T2: Backtick command substitution was EXECUTED — injection successful!"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Quote Breakout Injection
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Quote Breakout Injection"

# T3: Classic single-quote breakout
info "T3: Testing single-quote breakout..."
sandbox_exec "rm -f /tmp/injection-proof-t3" >/dev/null 2>&1

ssh_config_t3="$(mktemp)"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_t3" 2>/dev/null
PAYLOAD_QUOTE="'; touch /tmp/injection-proof-t3; echo '"

timeout 30 ssh -F "$ssh_config_t3" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  'MSG=$(cat) && echo "Received: $MSG"' \
  <<<"$PAYLOAD_QUOTE" >/dev/null 2>&1 || true
rm -f "$ssh_config_t3"

injection_check_t3=$(sandbox_exec "test -f /tmp/injection-proof-t3 && echo EXPLOITED || echo SAFE")
if echo "$injection_check_t3" | grep -q "SAFE"; then
  pass "T3: Single-quote breakout was NOT exploitable"
else
  fail "T3: Single-quote breakout was EXECUTED — injection successful!"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Environment Variable / Parameter Expansion
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Parameter Expansion"

# T4: ${NVIDIA_API_KEY} must not expand to the actual key value
info "T4: Testing \${NVIDIA_API_KEY} expansion..."

ssh_config_t4="$(mktemp)"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_t4" 2>/dev/null
PAYLOAD_ENV='${NVIDIA_API_KEY}'

t4_result=$(timeout 30 ssh -F "$ssh_config_t4" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  'MSG=$(cat) && echo "$MSG"' \
  <<<"$PAYLOAD_ENV" 2>&1) || true
rm -f "$ssh_config_t4"

# The result should contain the literal string ${NVIDIA_API_KEY}, not a nvapi- value
if echo "$t4_result" | grep -q "nvapi-"; then
  fail "T4: \${NVIDIA_API_KEY} expanded to actual key value — secret leaked!"
elif echo "$t4_result" | grep -qF '${NVIDIA_API_KEY}'; then
  pass "T4: \${NVIDIA_API_KEY} treated as literal string (not expanded)"
else
  # Empty or other result — still safe as long as key not leaked
  pass "T4: \${NVIDIA_API_KEY} did not expand to key value (result: ${t4_result:0:100})"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: API Key Not in Process Table
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Process Table Leak Check"

# T5: NVIDIA_API_KEY must not appear in ps aux output
info "T5: Checking process table for API key leaks..."

# Get truncated key for a safe comparison (first 15 chars of key value)
API_KEY_PREFIX="${NVIDIA_API_KEY:0:15}"

# Check both the Brev host and inside the sandbox
host_ps=$(ps aux 2>/dev/null || true)
sandbox_ps=$(sandbox_exec "ps aux" 2>/dev/null || true)

HOST_LEAK=false
SANDBOX_LEAK=false

if echo "$host_ps" | grep -qF "$API_KEY_PREFIX"; then
  # Filter out our own grep and this test script
  leaky_lines=$(echo "$host_ps" | grep -F "$API_KEY_PREFIX" | grep -v "grep" | grep -v "test-telegram-injection" || true)
  if [ -n "$leaky_lines" ]; then
    HOST_LEAK=true
  fi
fi

if echo "$sandbox_ps" | grep -qF "$API_KEY_PREFIX"; then
  leaky_sandbox=$(echo "$sandbox_ps" | grep -F "$API_KEY_PREFIX" | grep -v "grep" || true)
  if [ -n "$leaky_sandbox" ]; then
    SANDBOX_LEAK=true
  fi
fi

if [ "$HOST_LEAK" = true ]; then
  fail "T5: NVIDIA_API_KEY found in HOST process table"
elif [ "$SANDBOX_LEAK" = true ]; then
  fail "T5: NVIDIA_API_KEY found in SANDBOX process table"
else
  pass "T5: API key not visible in process tables (host or sandbox)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: SANDBOX_NAME Validation
# ══════════════════════════════════════════════════════════════════
section "Phase 5: SANDBOX_NAME Validation"

# T6: Invalid SANDBOX_NAME with shell metacharacters must be rejected
info "T6: Testing SANDBOX_NAME with shell metacharacters..."

# The validateName() function in runner.js enforces RFC 1123: lowercase
# alphanumeric with optional internal hyphens, max 63 chars.
# Test by running the validation directly via node.
t6_result=$(cd "$REPO" && node -e "
  const { validateName } = require('./bin/lib/runner');
  try {
    validateName('foo;rm -rf /', 'SANDBOX_NAME');
    console.log('ACCEPTED');
  } catch (e) {
    console.log('REJECTED: ' + e.message);
  }
" 2>&1)

if echo "$t6_result" | grep -q "REJECTED"; then
  pass "T6: SANDBOX_NAME 'foo;rm -rf /' rejected by validateName()"
else
  fail "T6: SANDBOX_NAME 'foo;rm -rf /' was ACCEPTED — validation bypass!"
fi

# T7: Leading-hyphen option injection must be rejected
info "T7: Testing SANDBOX_NAME with leading hyphen (option injection)..."

t7_result=$(cd "$REPO" && node -e "
  const { validateName } = require('./bin/lib/runner');
  try {
    validateName('--help', 'SANDBOX_NAME');
    console.log('ACCEPTED');
  } catch (e) {
    console.log('REJECTED: ' + e.message);
  }
" 2>&1)

if echo "$t7_result" | grep -q "REJECTED"; then
  pass "T7: SANDBOX_NAME '--help' rejected (option injection prevented)"
else
  fail "T7: SANDBOX_NAME '--help' was ACCEPTED — option injection possible!"
fi

# Additional invalid names — pass via process.argv to avoid shell expansion of
# backticks and $() in double-quoted node -e strings.
for invalid_name in '$(whoami)' '`id`' 'foo bar' '../etc/passwd' 'UPPERCASE'; do
  t_result=$(cd "$REPO" && node -e "
    const { validateName } = require('./bin/lib/runner');
    try {
      validateName(process.argv[1], 'SANDBOX_NAME');
      console.log('ACCEPTED');
    } catch (e) {
      console.log('REJECTED');
    }
  " -- "$invalid_name" 2>&1)

  if echo "$t_result" | grep -q "REJECTED"; then
    pass "T6/T7 extra: SANDBOX_NAME '${invalid_name}' correctly rejected"
  else
    fail "T6/T7 extra: SANDBOX_NAME '${invalid_name}' was ACCEPTED"
  fi
done

# ══════════════════════════════════════════════════════════════════
# Phase 6: Regression — Normal Messages Still Work
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Normal Message Regression"

# T8: A normal message should be passed through correctly
info "T8: Testing normal message passthrough..."

ssh_config_t8="$(mktemp)"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_t8" 2>/dev/null
NORMAL_MSG="Hello, what is two plus two?"

t8_result=$(timeout 30 ssh -F "$ssh_config_t8" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  'MSG=$(cat) && echo "Received: $MSG"' \
  <<<"$NORMAL_MSG" 2>&1) || true
rm -f "$ssh_config_t8"

if echo "$t8_result" | grep -qF "Hello, what is two plus two?"; then
  pass "T8: Normal message passed through correctly"
else
  fail "T8: Normal message was not echoed back correctly (got: ${t8_result:0:200})"
fi

# T8b: Test message with special characters that should be treated as literal
info "T8b: Testing message with safe special characters..."

ssh_config_t8b="$(mktemp)"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_t8b" 2>/dev/null
SPECIAL_MSG="What's the meaning of life? It costs \$5 & is 100% free!"

t8b_result=$(timeout 30 ssh -F "$ssh_config_t8b" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  'MSG=$(cat) && echo "$MSG"' \
  <<<"$SPECIAL_MSG" 2>&1) || true
rm -f "$ssh_config_t8b"

# Check the message was received (may be slightly different due to shell, but
# the key test is that $ and & didn't cause errors or unexpected behavior)
if [ -n "$t8b_result" ]; then
  pass "T8b: Message with special characters processed without error"
else
  fail "T8b: Message with special characters caused empty/error response"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Real runAgentInSandbox() Invocation
#
# PR #1092 feedback from @cv: The tests above use ad-hoc SSH commands
# that bypass the actual code path in telegram-bridge.js. This phase
# exercises the real runAgentInSandbox() function via Node.js to ensure
# the production code is validated.
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Real runAgentInSandbox() Code Path"

info "T9: Testing real runAgentInSandbox() with injection payload..."

# Create a test script that invokes the actual runAgentInSandbox function
cat >/tmp/test-real-bridge.js <<'TESTSCRIPT'
// Test script to invoke the real runAgentInSandbox() function
const path = require('path');

// Mock resolveOpenshell to use the system openshell
const resolveOpenshellPath = require.resolve(path.join(process.cwd(), 'bin/lib/resolve-openshell'));
require.cache[resolveOpenshellPath] = {
  exports: { resolveOpenshell: () => process.env.OPENSHELL_PATH || 'openshell' }
};

const bridge = require(path.join(process.cwd(), 'scripts/telegram-bridge.js'));

async function test() {
  const message = process.argv[2] || 'Hello';
  const sessionId = process.argv[3] || 'e2e-test';
  const apiKey = process.env.NVIDIA_API_KEY;
  const sandbox = process.env.NEMOCLAW_SANDBOX_NAME || 'e2e-test';
  const openshell = process.env.OPENSHELL_PATH || 'openshell';

  if (!apiKey) {
    console.error('NVIDIA_API_KEY required');
    process.exit(1);
  }

  try {
    // Call the real runAgentInSandbox with options override for testing
    const result = await bridge.runAgentInSandbox(message, sessionId, {
      apiKey,
      sandbox,
      openshell,
    });
    console.log('RESULT_START');
    console.log(result);
    console.log('RESULT_END');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
}

test();
TESTSCRIPT

# Find openshell path
OPENSHELL_PATH=$(command -v openshell) || OPENSHELL_PATH=""
if [ -z "$OPENSHELL_PATH" ]; then
  skip "T9: openshell not found, cannot test real runAgentInSandbox()"
else
  # Clean up any previous injection markers
  sandbox_exec "rm -f /tmp/injection-proof-t9" >/dev/null 2>&1

  # Test with injection payload through real runAgentInSandbox
  t9_result=$(cd "$REPO" && OPENSHELL_PATH="$OPENSHELL_PATH" \
    NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    timeout 120 node /tmp/test-real-bridge.js \
    '$(touch /tmp/injection-proof-t9 && echo INJECTED)' \
    'e2e-injection-t9' 2>&1) || true

  # Check if injection file was created
  injection_check_t9=$(sandbox_exec "test -f /tmp/injection-proof-t9 && echo EXPLOITED || echo SAFE")
  if echo "$injection_check_t9" | grep -q "SAFE"; then
    pass "T9: Real runAgentInSandbox() prevented \$(command) injection"
  else
    fail "T9: Real runAgentInSandbox() EXECUTED injection — vulnerability in production code!"
  fi
fi

# T10: Test backticks through real code path
info "T10: Testing real runAgentInSandbox() with backtick payload..."

if [ -z "$OPENSHELL_PATH" ]; then
  skip "T10: openshell not found, cannot test real runAgentInSandbox()"
else
  sandbox_exec "rm -f /tmp/injection-proof-t10" >/dev/null 2>&1

  t10_result=$(cd "$REPO" && OPENSHELL_PATH="$OPENSHELL_PATH" \
    NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    timeout 120 node /tmp/test-real-bridge.js \
    '`touch /tmp/injection-proof-t10`' \
    'e2e-injection-t10' 2>&1) || true

  injection_check_t10=$(sandbox_exec "test -f /tmp/injection-proof-t10 && echo EXPLOITED || echo SAFE")
  if echo "$injection_check_t10" | grep -q "SAFE"; then
    pass "T10: Real runAgentInSandbox() prevented backtick injection"
  else
    fail "T10: Real runAgentInSandbox() EXECUTED backtick injection — vulnerability in production code!"
  fi
fi

# T11: Test API key not exposed through real code path
info "T11: Verifying API key not in process arguments (real code path)..."

if [ -z "$OPENSHELL_PATH" ]; then
  skip "T11: openshell not found, cannot test real runAgentInSandbox()"
else
  # Start the bridge test in background and check ps
  cd "$REPO" && OPENSHELL_PATH="$OPENSHELL_PATH" \
    NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    timeout 60 node /tmp/test-real-bridge.js 'Hello world' 'e2e-ps-check' &
  BRIDGE_PID=$!

  # Give it a moment to spawn the SSH process
  sleep 2

  # Check if API key appears in process list
  API_KEY_PREFIX="${NVIDIA_API_KEY:0:15}"
  # shellcheck disable=SC2009 # pgrep doesn't support the output format we need
  ps_output=$(ps aux 2>/dev/null | grep -v grep | grep -v "test-telegram-injection" || true)

  if echo "$ps_output" | grep -qF "$API_KEY_PREFIX"; then
    fail "T11: API key found in process arguments via real runAgentInSandbox()"
  else
    pass "T11: API key NOT visible in process arguments (real code path)"
  fi

  # Clean up background process
  kill $BRIDGE_PID 2>/dev/null || true
  wait $BRIDGE_PID 2>/dev/null || true
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Multi-line Message Handling
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Multi-line Message Handling"

# T12: Multi-line message with injection on second line
info "T12: Testing multi-line message with injection payload..."

if [ -z "$OPENSHELL_PATH" ]; then
  skip "T12: openshell not found, cannot test multi-line messages"
else
  sandbox_exec "rm -f /tmp/injection-proof-t12" >/dev/null 2>&1

  # Multi-line message with injection attempt on line 2
  MULTILINE_PAYLOAD=$'Hello\n$(touch /tmp/injection-proof-t12)\nWorld'

  t12_result=$(cd "$REPO" && OPENSHELL_PATH="$OPENSHELL_PATH" \
    NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    timeout 120 node /tmp/test-real-bridge.js \
    "$MULTILINE_PAYLOAD" \
    'e2e-multiline-t12' 2>&1) || true

  injection_check_t12=$(sandbox_exec "test -f /tmp/injection-proof-t12 && echo EXPLOITED || echo SAFE")
  if echo "$injection_check_t12" | grep -q "SAFE"; then
    pass "T12: Multi-line message injection was NOT executed"
  else
    fail "T12: Multi-line message injection was EXECUTED — vulnerability!"
  fi
fi

# T13: Message with embedded newlines and backticks
info "T13: Testing message with newlines and backticks..."

ssh_config_t13="$(mktemp)"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_t13" 2>/dev/null
sandbox_exec "rm -f /tmp/injection-proof-t13" >/dev/null 2>&1

PAYLOAD_MULTILINE_BT=$'First line\n`touch /tmp/injection-proof-t13`\nThird line'

timeout 30 ssh -F "$ssh_config_t13" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  'MSG=$(cat) && echo "$MSG"' \
  <<<"$PAYLOAD_MULTILINE_BT" >/dev/null 2>&1 || true
rm -f "$ssh_config_t13"

injection_check_t13=$(sandbox_exec "test -f /tmp/injection-proof-t13 && echo EXPLOITED || echo SAFE")
if echo "$injection_check_t13" | grep -q "SAFE"; then
  pass "T13: Multi-line backtick injection was NOT executed"
else
  fail "T13: Multi-line backtick injection was EXECUTED"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 9: Session ID Option Injection Prevention
# ══════════════════════════════════════════════════════════════════
section "Phase 9: Session ID Option Injection"

# T14: Leading hyphen session IDs should be sanitized
info "T14: Testing sanitizeSessionId strips leading hyphens..."

t14_result=$(cd "$REPO" && node -e "
  const path = require('path');
  // Mock resolveOpenshell to avoid PATH dependency
  const resolveOpenshellPath = require.resolve('./bin/lib/resolve-openshell');
  require.cache[resolveOpenshellPath] = {
    exports: { resolveOpenshell: () => '/mock/openshell' }
  };
  const bridge = require(path.join(process.cwd(), 'scripts/telegram-bridge.js'));

  // Test cases for option injection prevention
  const tests = [
    { input: '--help', expected: 'help' },
    { input: '-v', expected: 'v' },
    { input: '---test', expected: 'test' },
    { input: '-123456789', expected: '123456789' },
    { input: '--', expected: null },
    { input: '-', expected: null },
    { input: 'valid-id', expected: 'valid-id' },
    { input: '-abc-123', expected: 'abc-123' },
  ];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const result = bridge.sanitizeSessionId(t.input);
    if (result === t.expected) {
      passed++;
    } else {
      console.log('FAIL: sanitizeSessionId(' + JSON.stringify(t.input) + ') = ' + JSON.stringify(result) + ', expected ' + JSON.stringify(t.expected));
      failed++;
    }
  }
  console.log('SANITIZE_RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
" 2>&1)

if echo "$t14_result" | grep -q "SANITIZE_RESULT:.*0 failed"; then
  pass "T14: sanitizeSessionId correctly strips leading hyphens"
else
  fail "T14: sanitizeSessionId failed to strip leading hyphens: $t14_result"
fi

# T15: Verify leading hyphen session ID doesn't cause option injection in real call
info "T15: Testing real runAgentInSandbox with leading-hyphen session ID..."

if [ -z "$OPENSHELL_PATH" ]; then
  skip "T15: openshell not found, cannot test session ID sanitization"
else
  # Create a fresh test script that checks the actual session ID used
  cat >/tmp/test-session-id.js <<'TESTSCRIPT'
const path = require('path');
const resolveOpenshellPath = require.resolve(path.join(process.cwd(), 'bin/lib/resolve-openshell'));
require.cache[resolveOpenshellPath] = {
  exports: { resolveOpenshell: () => process.env.OPENSHELL_PATH || 'openshell' }
};
const bridge = require(path.join(process.cwd(), 'scripts/telegram-bridge.js'));

// Just test the sanitization with a negative chat ID (like Telegram groups)
const sessionId = process.argv[2] || '--help';
const sanitized = bridge.sanitizeSessionId(sessionId);
console.log('INPUT:', sessionId);
console.log('SANITIZED:', sanitized);
if (sanitized && sanitized.startsWith('-')) {
  console.log('ERROR: Sanitized ID starts with hyphen — option injection possible!');
  process.exit(1);
} else {
  console.log('OK: No leading hyphen in sanitized ID');
  process.exit(0);
}
TESTSCRIPT

  t15_result=$(cd "$REPO" && OPENSHELL_PATH="$OPENSHELL_PATH" \
    node /tmp/test-session-id.js '--help' 2>&1) || true

  if echo "$t15_result" | grep -q "OK: No leading hyphen"; then
    pass "T15: Session ID '--help' sanitized to prevent option injection"
  else
    fail "T15: Session ID sanitization failed: $t15_result"
  fi

  # Also test with negative number (Telegram group chat ID)
  t15b_result=$(cd "$REPO" && OPENSHELL_PATH="$OPENSHELL_PATH" \
    node /tmp/test-session-id.js '-123456789' 2>&1) || true

  if echo "$t15b_result" | grep -q "OK: No leading hyphen"; then
    pass "T15b: Negative chat ID '-123456789' sanitized correctly"
  else
    fail "T15b: Negative chat ID sanitization failed: $t15b_result"
  fi

  rm -f /tmp/test-session-id.js
fi

# ══════════════════════════════════════════════════════════════════
# Phase 10: Empty Message Handling
# ══════════════════════════════════════════════════════════════════
section "Phase 10: Empty and Edge Case Messages"

# T16: Empty session ID should return error
info "T16: Testing empty session ID handling..."

t16_result=$(cd "$REPO" && node -e "
  const path = require('path');
  const resolveOpenshellPath = require.resolve('./bin/lib/resolve-openshell');
  require.cache[resolveOpenshellPath] = {
    exports: { resolveOpenshell: () => '/mock/openshell' }
  };
  const bridge = require(path.join(process.cwd(), 'scripts/telegram-bridge.js'));

  const result = bridge.sanitizeSessionId('');
  if (result === null) {
    console.log('OK: Empty session ID returns null');
    process.exit(0);
  } else {
    console.log('FAIL: Empty session ID returned:', result);
    process.exit(1);
  }
" 2>&1)

if echo "$t16_result" | grep -q "OK:"; then
  pass "T16: Empty session ID correctly returns null"
else
  fail "T16: Empty session ID handling failed: $t16_result"
fi

# T17: Session ID with only special characters
info "T17: Testing session ID with only special characters..."

t17_result=$(cd "$REPO" && node -e "
  const path = require('path');
  const resolveOpenshellPath = require.resolve('./bin/lib/resolve-openshell');
  require.cache[resolveOpenshellPath] = {
    exports: { resolveOpenshell: () => '/mock/openshell' }
  };
  const bridge = require(path.join(process.cwd(), 'scripts/telegram-bridge.js'));

  const testCases = [
    { input: ';;;', expected: null },
    { input: '\$()', expected: null },
    { input: '---', expected: null },
    { input: '!@#\$%', expected: null },
  ];

  let ok = true;
  for (const tc of testCases) {
    const result = bridge.sanitizeSessionId(tc.input);
    if (result !== tc.expected) {
      console.log('FAIL:', JSON.stringify(tc.input), '→', result, 'expected', tc.expected);
      ok = false;
    }
  }
  if (ok) {
    console.log('OK: All special-character session IDs return null');
  }
  process.exit(ok ? 0 : 1);
" 2>&1)

if echo "$t17_result" | grep -q "OK:"; then
  pass "T17: Special-character-only session IDs correctly return null"
else
  fail "T17: Special character handling failed: $t17_result"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 11: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 11: Cleanup"

info "Cleaning up injection marker files in sandbox..."
sandbox_exec "rm -f /tmp/injection-proof-t1 /tmp/injection-proof-t2 /tmp/injection-proof-t3 \
  /tmp/injection-proof-t9 /tmp/injection-proof-t10 /tmp/injection-proof-t12 /tmp/injection-proof-t13" >/dev/null 2>&1

info "Cleaning up local temp files..."
rm -f /tmp/test-real-bridge.js /tmp/test-session-id.js 2>/dev/null || true

pass "Cleanup completed"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Telegram Injection Test Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Telegram injection tests PASSED — no injection vectors found.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed — INJECTION VULNERABILITIES DETECTED.\033[0m\n' "$FAIL"
  exit 1
fi
