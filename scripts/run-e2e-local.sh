#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Run Brev E2E tests locally with tokens extracted from existing local auth.
#
# This script mirrors the CI workflow (e2e-brev.yaml) but sources credentials
# from your local brev and gh CLI auth instead of GitHub secrets.
#
# Prerequisites:
#   - brev login (creates ~/.brev/credentials.json)
#   - gh auth login (authenticates gh CLI)
#   - NVIDIA_API_KEY exported in environment
#
# Usage:
#   ./scripts/run-e2e-local.sh [test-suite] [instance-name]
#
# Examples:
#   ./scripts/run-e2e-local.sh telegram-injection
#   ./scripts/run-e2e-local.sh credential-sanitization
#   ./scripts/run-e2e-local.sh full
#   ./scripts/run-e2e-local.sh all
#   ./scripts/run-e2e-local.sh telegram-injection my-test-instance
#
# Environment variables:
#   KEEP_ALIVE      — set to false to delete instance after test (default: true)

set -euo pipefail

# --- Extract tokens from local auth ---

if [[ ! -f ~/.brev/credentials.json ]]; then
  echo "ERROR: ~/.brev/credentials.json not found. Run 'brev login' first."
  exit 1
fi

if ! command -v gh &>/dev/null; then
  echo "ERROR: gh CLI not found. Install it and run 'gh auth login'."
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "ERROR: gh CLI not authenticated. Run 'gh auth login' first."
  exit 1
fi

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  echo "ERROR: NVIDIA_API_KEY not set in environment."
  exit 1
fi

BREV_API_TOKEN=$(jq -r .refresh_token ~/.brev/credentials.json)
export BREV_API_TOKEN
GITHUB_TOKEN=$(gh auth token)
export GITHUB_TOKEN

if [[ -z "$BREV_API_TOKEN" || "$BREV_API_TOKEN" == "null" ]]; then
  echo "ERROR: Could not extract refresh_token from ~/.brev/credentials.json"
  exit 1
fi

if [[ -z "$GITHUB_TOKEN" ]]; then
  echo "ERROR: Could not get token from gh CLI"
  exit 1
fi

# --- Configure test run ---

export TEST_SUITE="${1:-telegram-injection}"
export INSTANCE_NAME="${2:-local-e2e-$(date +%s)}"
export KEEP_ALIVE="${KEEP_ALIVE:-true}"

echo "=== Running Brev E2E locally ==="
echo "  TEST_SUITE:    $TEST_SUITE"
echo "  INSTANCE_NAME: $INSTANCE_NAME"
echo "  KEEP_ALIVE:    $KEEP_ALIVE"
echo ""

# --- Run the test ---

cd "$(dirname "$0")/.."
npx vitest run --project e2e-brev --reporter=verbose

# --- Cleanup reminder ---

if [[ "$KEEP_ALIVE" == "true" ]]; then
  echo ""
  echo "=== Instance kept alive for debugging ==="
  echo "  To connect: brev refresh && ssh $INSTANCE_NAME"
  echo "  To delete:  brev delete $INSTANCE_NAME"
fi
