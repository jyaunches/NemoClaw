#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Warm pool instance startup script — runs via brev create --startup-script.
#
# This is a SELF-CONTAINED script injected into a bare Brev VM. It handles
# everything that does NOT require CI secrets:
#   1. Clone the NemoClaw repo
#   2. Install Node.js, openshell CLI, cloudflared
#
# The secret-dependent steps (GHCR base image pull, setup.sh which needs
# NVIDIA_API_KEY) are handled by the warmer workflow via brev exec after
# this script completes (BUILD reaches COMPLETED).
#
# After startup-script + finalization, the instance is fully warm:
# Docker + Node.js + openshell + sandbox ready to claim.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[warm]${NC} $1"; }
warn() { echo -e "${YELLOW}[warm]${NC} $1"; }
fail() {
  echo -e "${RED}[warm]${NC} $1"
  exit 1
}

REPO_URL="https://github.com/NVIDIA/NemoClaw.git"
REPO_BRANCH="${NEMOCLAW_BRANCH:-main}"
REPO_DIR="$HOME/nemoclaw"

# Suppress apt noise
export NEEDRESTART_MODE=a
export DEBIAN_FRONTEND=noninteractive

# --- 1. Install git (Brev platform may not include it) ---
if ! command -v git >/dev/null 2>&1; then
  info "Installing git..."
  sudo apt-get update -qq >/dev/null 2>&1
  sudo apt-get install -y -qq git >/dev/null 2>&1
fi

# --- 2. Clone the repo ---
info "Cloning NemoClaw ($REPO_BRANCH) ..."
rm -rf "$REPO_DIR"
git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR" 2>&1
info "Repo cloned to $REPO_DIR"

# --- 3. Install Node.js ---
if ! command -v node >/dev/null 2>&1; then
  info "Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs >/dev/null 2>&1
  info "Node.js $(node --version) installed"
else
  info "Node.js already installed: $(node --version)"
fi

# --- 4. Install openshell CLI ---
if ! command -v openshell >/dev/null 2>&1; then
  info "Installing openshell CLI..."
  if ! command -v gh >/dev/null 2>&1; then
    sudo apt-get update -qq >/dev/null 2>&1
    sudo apt-get install -y -qq gh >/dev/null 2>&1
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64 | amd64) ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
    aarch64 | arm64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac
  tmpdir="$(mktemp -d)"
  # Try unauthenticated first (public repo), fall back to gh
  if curl -fsSL -o "$tmpdir/$ASSET" \
    "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" 2>/dev/null; then
    info "Downloaded openshell via curl"
  else
    GH_TOKEN="${GITHUB_TOKEN:-}" gh release download --repo NVIDIA/OpenShell \
      --pattern "$ASSET" --dir "$tmpdir"
  fi
  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"
  sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  rm -rf "$tmpdir"
  info "openshell $(openshell --version) installed"
else
  info "openshell already installed: $(openshell --version)"
fi

# --- 5. Install cloudflared ---
if ! command -v cloudflared >/dev/null 2>&1; then
  info "Installing cloudflared..."
  CF_ARCH="$(uname -m)"
  case "$CF_ARCH" in
    x86_64 | amd64) CF_ARCH="amd64" ;;
    aarch64 | arm64) CF_ARCH="arm64" ;;
    *) fail "Unsupported architecture for cloudflared: $CF_ARCH" ;;
  esac
  tmpdir=$(mktemp -d)
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o "$tmpdir/cloudflared"
  sudo install -m 755 "$tmpdir/cloudflared" /usr/local/bin/cloudflared
  rm -rf "$tmpdir"
  info "cloudflared $(cloudflared --version 2>&1 | head -1) installed"
else
  info "cloudflared already installed"
fi

# --- 6. Install npm dependencies ---
info "Installing npm dependencies..."
cd "$REPO_DIR"
npm ci >/dev/null 2>&1
info "npm dependencies installed"

info "Startup script complete. Instance ready for finalization via brev exec."
info "Finalization will: pull GHCR base image + run setup.sh (needs secrets)."
