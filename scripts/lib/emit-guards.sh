#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# emit-guards.sh — (re-)emits the NODE_OPTIONS preload guard chain to /tmp.
#
# Called by:
#   1. nemoclaw-start.sh (entrypoint) — initial guard installation
#   2. Guard recovery path (TypeScript via kubectl exec) — re-emission after
#      pod recreate wipes /tmp (#2701)
#
# Must run as root in root-mode sandboxes (files are root:root 444).
# In non-root mode, files are sandbox:sandbox 444 (best-effort).
#
# Environment variables read:
#   NEMOCLAW_PROXY_HOST   — proxy host (default: 10.200.0.1)
#   NEMOCLAW_PROXY_PORT   — proxy port (default: 3128)
#   NODE_USE_ENV_PROXY    — set to "1" to include http-proxy-fix preload
#   GIT_SSL_CAINFO        — if set, included in proxy-env.sh
#
# Guard source files expected at:
#   /usr/local/lib/nemoclaw/guards/*.js
#
# Output:
#   /tmp/nemoclaw-sandbox-safety-net.js
#   /tmp/nemoclaw-ciao-network-guard.js
#   /tmp/nemoclaw-http-proxy-fix.js       (always installed; conditional in proxy-env)
#   /tmp/nemoclaw-nemotron-inference-fix.js
#   /tmp/nemoclaw-slack-channel-guard.js
#   /tmp/nemoclaw-slack-token-rewriter.js
#   /tmp/nemoclaw-proxy-env.sh            (aggregator — sources all via NODE_OPTIONS)

set -euo pipefail

# ── Source shared sandbox initialisation library ─────────────────
_SANDBOX_INIT="/usr/local/lib/nemoclaw/sandbox-init.sh"
if [ ! -f "$_SANDBOX_INIT" ]; then
  _SANDBOX_INIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-init.sh"
fi
# shellcheck source=scripts/lib/sandbox-init.sh
source "$_SANDBOX_INIT"

# ── Guard source directory ───────────────────────────────────────
_GUARD_SRC="/usr/local/lib/nemoclaw/guards"
if [ ! -d "$_GUARD_SRC" ]; then
  # Dev fallback: relative to this script
  _GUARD_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guards"
fi

if [ ! -d "$_GUARD_SRC" ]; then
  echo "[emit-guards] ERROR: guard source directory not found" >&2
  exit 1
fi

# ── Install static JS guards ────────────────────────────────────
_SANDBOX_SAFETY_NET="/tmp/nemoclaw-sandbox-safety-net.js"
_CIAO_GUARD_SCRIPT="/tmp/nemoclaw-ciao-network-guard.js"
_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"
_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"
_SLACK_GUARD_SCRIPT="/tmp/nemoclaw-slack-channel-guard.js"
_SLACK_REWRITER_SCRIPT="/tmp/nemoclaw-slack-token-rewriter.js"

emit_sandbox_sourced_file "$_SANDBOX_SAFETY_NET" < "$_GUARD_SRC/nemoclaw-sandbox-safety-net.js"
emit_sandbox_sourced_file "$_CIAO_GUARD_SCRIPT" < "$_GUARD_SRC/nemoclaw-ciao-network-guard.js"
emit_sandbox_sourced_file "$_PROXY_FIX_SCRIPT" < "$_GUARD_SRC/nemoclaw-http-proxy-fix.js"
emit_sandbox_sourced_file "$_NEMOTRON_FIX_SCRIPT" < "$_GUARD_SRC/nemoclaw-nemotron-inference-fix.js"
emit_sandbox_sourced_file "$_SLACK_GUARD_SCRIPT" < "$_GUARD_SRC/nemoclaw-slack-channel-guard.js"
emit_sandbox_sourced_file "$_SLACK_REWRITER_SCRIPT" < "$_GUARD_SRC/nemoclaw-slack-token-rewriter.js"

# ── Generate proxy-env.sh (dynamic — depends on runtime config) ──
_PROXY_HOST="${NEMOCLAW_PROXY_HOST:-10.200.0.1}"
_PROXY_PORT="${NEMOCLAW_PROXY_PORT:-3128}"
_PROXY_URL="http://${_PROXY_HOST}:${_PROXY_PORT}"
_NO_PROXY_VAL="localhost,127.0.0.1,::1,${_PROXY_HOST}"

_WS_FIX_SCRIPT="/opt/nemoclaw-blueprint/scripts/ws-proxy-fix.js"

_PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
{
  cat <<PROXYEOF
# Proxy configuration (overrides narrow OpenShell defaults on connect)
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"
PROXYEOF
  # Global sandbox safety net for connect sessions — must be first.
  echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SANDBOX_SAFETY_NET\""
  # HTTP library double-proxy fix: also expose NODE_OPTIONS in connect
  # sessions so interactive shells and user commands started via
  # `openshell sandbox connect` benefit from the preload. (NemoClaw#2109)
  if [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_PROXY_FIX_SCRIPT\""
  fi
  # WebSocket CONNECT tunnel fix for connect sessions. (NemoClaw#1570)
  if [ -f "$_WS_FIX_SCRIPT" ]; then
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_WS_FIX_SCRIPT\""
  fi
  # Git TLS CA bundle for connect sessions (NemoClaw#2270)
  if [ -n "${GIT_SSL_CAINFO:-}" ]; then
    printf 'export GIT_SSL_CAINFO=%q\n' "$GIT_SSL_CAINFO"
  fi
  # Nemotron inference fix for connect sessions. (NemoClaw#1193, #2051)
  echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_NEMOTRON_FIX_SCRIPT\""
  # ciao network guard for connect sessions.
  echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_CIAO_GUARD_SCRIPT\""
  # Slack channel guard for connect sessions. Conditional on the file existing.
  echo "[ -f \"$_SLACK_GUARD_SCRIPT\" ] && export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SLACK_GUARD_SCRIPT\""
  # Slack token rewriter for connect sessions. Conditional on the file existing.
  echo "[ -f \"$_SLACK_REWRITER_SCRIPT\" ] && export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SLACK_REWRITER_SCRIPT\""
  # Tool cache redirects — /sandbox is Landlock read-only (#804)
  echo '# Tool cache redirects — /sandbox is Landlock read-only (#804)'
  echo 'export npm_config_cache=/tmp/.npm-cache'
  echo 'export XDG_CACHE_HOME=/tmp/.cache'
  echo 'export XDG_CONFIG_HOME=/tmp/.config'
  echo 'export XDG_DATA_HOME=/tmp/.local/share'
  echo 'export XDG_STATE_HOME=/tmp/.local/state'
  echo 'export XDG_RUNTIME_DIR=/tmp/.runtime'
  echo 'export NODE_REPL_HISTORY=/tmp/.node_repl_history'
  echo 'export HISTFILE=/tmp/.bash_history'
  echo 'export GIT_CONFIG_GLOBAL=/tmp/.gitconfig'
  echo 'export GNUPGHOME=/tmp/.gnupg'
  echo 'export PYTHONUSERBASE=/tmp/.local'
  echo 'export PYTHON_HISTORY=/tmp/.python_history'
  echo 'export CLAUDE_CONFIG_DIR=/tmp/.claude'
  echo 'export npm_config_prefix=/tmp/npm-global'
} | emit_sandbox_sourced_file "$_PROXY_ENV_FILE"

# ── Validate permissions ─────────────────────────────────────────
validate_tmp_permissions \
  "$_SANDBOX_SAFETY_NET" \
  "$_PROXY_FIX_SCRIPT" \
  "$_NEMOTRON_FIX_SCRIPT" \
  "$_CIAO_GUARD_SCRIPT" \
  "$_SLACK_GUARD_SCRIPT" \
  "$_SLACK_REWRITER_SCRIPT"

echo "[emit-guards] Guard chain installed successfully" >&2
