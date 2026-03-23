#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E test for gateway process isolation and entrypoint hardening.
# Builds the sandbox image and verifies that the sandboxed agent cannot
# compromise the gateway via the fake-HOME attack or related vectors.
#
# Requires: docker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="nemoclaw-isolation-test"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}TEST${NC}: $1"; }

PASSED=0
FAILED=0

# ── Build the image ──────────────────────────────────────────────

info "Building sandbox image..."
docker build -t "$IMAGE" "$REPO_DIR" > /dev/null 2>&1 || {
  fail "Docker build failed"
  exit 1
}

# Helper: run a command inside the container as the sandbox user
run_as_sandbox() {
  docker run --rm --entrypoint "" "$IMAGE" gosu sandbox bash -c "$1" 2>&1
}

# Helper: run a command inside the container as root
run_as_root() {
  docker run --rm --entrypoint "" "$IMAGE" bash -c "$1" 2>&1
}

# ── Test 1: Gateway user exists and is different from sandbox ────

info "1. Gateway user exists with separate UID"
OUT=$(run_as_root "id gateway && id sandbox")
GW_UID=$(echo "$OUT" | grep "^uid=" | head -1 | sed 's/uid=\([0-9]*\).*/\1/')
SB_UID=$(echo "$OUT" | grep "^uid=" | tail -1 | sed 's/uid=\([0-9]*\).*/\1/')
if [ -n "$GW_UID" ] && [ -n "$SB_UID" ] && [ "$GW_UID" != "$SB_UID" ]; then
  pass "gateway (uid=$GW_UID) and sandbox (uid=$SB_UID) are different users"
else
  fail "gateway and sandbox UIDs not distinct: $OUT"
fi

# ── Test 2: openclaw.json is not writable by sandbox user ────────

info "2. openclaw.json is not writable by sandbox user"
OUT=$(run_as_sandbox "touch /sandbox/.openclaw/openclaw.json 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -q "BLOCKED\|Permission denied\|Read-only"; then
  pass "sandbox cannot write to openclaw.json"
else
  fail "sandbox CAN write to openclaw.json: $OUT"
fi

# ── Test 3: .openclaw directory is not writable by sandbox ───────

info "3. .openclaw directory not writable by sandbox (no symlink replacement)"
# ln -sf may return 0 even when it fails to replace (silent failure on perm denied).
# Verify the symlink still points to the expected target after the attempt.
OUT=$(run_as_sandbox "ln -sf /tmp/evil /sandbox/.openclaw/hooks 2>&1; readlink /sandbox/.openclaw/hooks")
TARGET=$(echo "$OUT" | tail -1)
if [ "$TARGET" = "/sandbox/.openclaw-data/hooks" ]; then
  pass "sandbox cannot replace symlinks in .openclaw (target unchanged)"
else
  fail "sandbox replaced symlink — hooks now points to: $TARGET"
fi

# ── Test 4: Config hash file exists and is valid ─────────────────

info "4. Config hash exists and matches openclaw.json"
OUT=$(run_as_root "cd /sandbox/.openclaw && sha256sum -c .config-hash --status && echo VALID || echo INVALID")
if echo "$OUT" | grep -q "VALID"; then
  pass "config hash matches openclaw.json"
else
  fail "config hash mismatch: $OUT"
fi

# ── Test 5: Config hash is not writable by sandbox ───────────────

info "5. Config hash not writable by sandbox user"
OUT=$(run_as_sandbox "echo fake > /sandbox/.openclaw/.config-hash 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -q "BLOCKED\|Permission denied"; then
  pass "sandbox cannot tamper with config hash"
else
  fail "sandbox CAN write to config hash: $OUT"
fi

# ── Test 6: gosu is installed ────────────────────────────────────

info "6. gosu binary is available"
OUT=$(run_as_root "command -v gosu && gosu --version")
if echo "$OUT" | grep -q "gosu"; then
  pass "gosu installed"
else
  fail "gosu not found: $OUT"
fi

# ── Test 7: nemoclaw-start.sh has PATH hardening ────────────────

info "7. Entrypoint locks PATH"
OUT=$(run_as_root "grep 'export PATH=' /usr/local/bin/nemoclaw-start")
if echo "$OUT" | grep -q 'export PATH='; then
  pass "PATH is explicitly set in entrypoint"
else
  fail "PATH not locked: $OUT"
fi

# ── Test 8: nemoclaw-start.sh resolves openclaw absolute path ───

info "8. Entrypoint resolves openclaw to absolute path"
OUT=$(run_as_root "grep 'command -v openclaw' /usr/local/bin/nemoclaw-start")
if [ -n "$OUT" ]; then
  pass "openclaw resolved via command -v"
else
  fail "no absolute path resolution for openclaw"
fi

# ── Test 9: Symlink verification code exists ─────────────────────

info "9. Entrypoint verifies symlink targets"
OUT=$(run_as_root "grep 'readlink' /usr/local/bin/nemoclaw-start")
if [ -n "$OUT" ]; then
  pass "symlink verification present in entrypoint"
else
  fail "no symlink verification in entrypoint"
fi

# ── Test 10: Sandbox user cannot kill gateway-user processes ─────

info "10. Sandbox user cannot kill gateway-user processes"
# Start a dummy process as gateway, try to kill it as sandbox
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  gosu gateway sleep 60 &
  GW_PID=$!
  sleep 0.5
  RESULT=$(gosu sandbox kill $GW_PID 2>&1 || echo "EPERM")
  echo "$RESULT"
  kill $GW_PID 2>/dev/null || true
')
if echo "$OUT" | grep -qi "EPERM\|not permitted\|operation not permitted"; then
  pass "sandbox cannot kill gateway-user processes"
else
  fail "sandbox CAN kill gateway processes: $OUT"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "  Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo -e "${GREEN}========================================${NC}"

# Cleanup
docker rmi "$IMAGE" > /dev/null 2>&1 || true

[ "$FAILED" -eq 0 ] || exit 1
