#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Warm pool finalization — runs via brev exec after the startup script completes.
#
# This handles the secret-dependent Phase 2 of warm instance creation:
#   1. Log into GHCR and pull base images (sandbox base + openshell gateway)
#   2. Run setup.sh (starts gateway, creates providers, builds sandbox)
#
# Expects environment variables:
#   NVIDIA_API_KEY   — inference config during sandbox setup
#   GITHUB_TOKEN     — GHCR auth for image pulls
#
# Usage (from CI):
#   brev exec <instance> "export NVIDIA_API_KEY=... GITHUB_TOKEN=... && bash ~/nemoclaw/scripts/e2e-warm-finalize.sh"

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[finalize]${NC} $1"; }
warn() { echo -e "${YELLOW}[finalize]${NC} $1"; }
fail() {
  echo -e "${RED}[finalize]${NC} $1"
  exit 1
}

REPO_DIR="$HOME/nemoclaw"
BASE_IMAGE="ghcr.io/nvidia/nemoclaw/sandbox-base:latest"

[ -d "$REPO_DIR" ] || fail "Repo not found at $REPO_DIR — did the startup script run?"
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY not set"

# --- 1. GHCR login + image pulls ---
if [ -n "${GITHUB_TOKEN:-}" ]; then
  info "Logging into GHCR..."
  echo "${GITHUB_TOKEN}" | docker login ghcr.io -u nemoclaw-ci --password-stdin 2>/dev/null || warn "GHCR login failed"

  info "Pulling sandbox base image..."
  docker pull "$BASE_IMAGE" 2>&1 || warn "Base image pull failed"

  # Pull openshell gateway image (version from installed CLI)
  OS_VERSION=$(openshell -V 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' || echo "0.0.16")
  GATEWAY_IMAGE="ghcr.io/nvidia/openshell/cluster:${OS_VERSION}"
  info "Pulling gateway image ($GATEWAY_IMAGE)..."
  docker pull "$GATEWAY_IMAGE" 2>&1 || warn "Gateway image pull failed"
else
  warn "GITHUB_TOKEN not set — skipping GHCR pulls"
fi

# --- 2. Run setup.sh ---
info "Running setup.sh (gateway + sandbox)..."
cd "$REPO_DIR"
export NVIDIA_API_KEY
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_SANDBOX_NAME=e2e-test
bash scripts/setup.sh

info "Finalization complete — instance is warm and ready!"
