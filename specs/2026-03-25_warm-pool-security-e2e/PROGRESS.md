# Warm Pool E2E — Implementation Progress

## Status: Blocked on openshell gateway startup timeout

All infrastructure is built and tested. The single remaining blocker is
that `openshell gateway start` times out on Brev CPU instances before the
embedded k3s cluster becomes healthy.

## What's Built (Phases 1-4)

### scripts/e2e-pool.sh — Pool Management CLI
9 subcommands: `status`, `list`, `count`, `claim`, `health-check`, `warm`,
`cycle`, `deploy`. Uses `brev exec` (v0.6.322) instead of SSH config.
Atomic instance claiming via bash noclobber. Tested locally and in CI.

### .github/workflows/e2e-brev.yaml — Test Runner
3-job pipeline: `build-matrix` → `run-tests` (parallel matrix) → `report`.
Warm pool mode claims instances and deploys code. Ephemeral fallback creates
fresh instances if pool is empty. PR status reporting via check runs and
comments.

### .github/workflows/e2e-brev-trigger.yaml — PR Comment Trigger
`/test-brev injection creds` parses suite aliases, dispatches parallel
test runs. Maintainer allowlist. Adds 👀 reaction and confirmation comment.

### .github/workflows/e2e-pool-warmer.yaml — Pool Maintenance
Two-phase creation:
- Phase 1 (startup-script): `e2e-warm-startup.sh` clones repo, installs
  Node.js, openshell, cloudflared, npm deps. Runs automatically during
  Brev's BUILD phase.
- Phase 2 (finalize via brev exec): uploads `e2e-warm-finalize.sh` and
  `setup.sh`, pulls GHCR images (sandbox base + gateway), runs setup.sh.
  Parallel matrix — one job per instance.

### scripts/e2e-warm-startup.sh — Self-Contained Startup Script
Runs on bare VM via `brev create --startup-script`. Handles everything
that doesn't need CI secrets: git clone, tool installation, npm ci.

### scripts/e2e-warm-finalize.sh — Secret-Dependent Finalization
Runs via `brev exec` from CI. Handles GHCR login, image pulls, setup.sh.

### test/e2e/brev-e2e.test.js — Vitest Harness
`WARM_INSTANCE` env var support: skips create+bootstrap in warm pool mode.
Added `telegram-injection` test suite. `--type` for ephemeral fallback.

## Brev CLI Upgrade: v0.6.310 → v0.6.322

The original pin on v0.6.310 was because "v0.6.322 removed --cpu flag."
Investigation revealed v0.6.322 actually replaced the broken `--cpu` flag
with a proper `--type` system:

| Feature | v0.6.310 | v0.6.322 |
|---------|----------|----------|
| CPU instances | `--cpu 4x16` silently ignored → GPU at $0.72/hr | `--type n2d-standard-8` → CPU at $0.27/hr |
| Batch create | Loop one at a time | `--count N --parallel N` |
| Bootstrap on boot | Not available | `--startup-script @file` |
| Run remote commands | `brev refresh` + SSH config | `brev exec NAME "cmd"` |
| Find instance types | Guesswork | `brev search cpu --min-vcpu 8` |

## PR #914 Base Image Integration

PR #914 (merged to main) split the Dockerfile into:
- `Dockerfile.base` → pushed to `ghcr.io/nvidia/nemoclaw/sandbox-base:latest`
- `Dockerfile` → `FROM ${BASE_IMAGE}`, only builds thin top layers

With the base image pre-pulled, Docker build should go from ~40 min to
~2-3 min. Validated: GHCR pull works on Brev instances with token auth.

## The Gateway Blocker

### Root Cause
`openshell gateway start` runs a k3s cluster inside a Docker container.
The CLI polls the container's Docker healthcheck. On CPU instances (both
4-vCPU and 8-vCPU), k3s takes ~70+ seconds to become healthy (TLS cert
generation, secret mounting, pod scheduling). The openshell CLI's internal
timeout is shorter than this, so it reports failure and **destroys the
container** before k3s finishes starting.

### Evidence
- **Debug logging** (`RUST_LOG=debug`) slowed the CLI enough for k3s to
  pass the healthcheck → gateway started successfully.
- **Interactive testing** on a warm instance (prior k3s volume cached)
  → gateway started on first try.
- **Fresh instances in CI** → gateway fails consistently on all 3 retry
  attempts with both n2d-standard-4 and n2d-standard-8.

### Key Constraint
The openshell CLI generates TLS certificates and injects k8s secrets as
part of `gateway start`. These certs are required for the healthcheck to
pass. We cannot pre-start the k3s container manually because without the
CLI's cert injection, the healthcheck never succeeds.

### Attempted Fixes
1. ✅ Retry loop (3 attempts, 30s delay) — retries work but each attempt
   starts cold because the CLI destroys the container on failure.
2. ✅ `n2d-standard-8` (8 vCPU) — faster k3s startup but still not fast
   enough for the CLI's timeout.
3. ❌ Manual k3s pre-start — can't bypass CLI's cert injection.
4. ❌ Piping through grep — masked exit codes, preventing retries. Fixed.
5. ✅ Gateway reuse — setup.sh now skips destroy if gateway is already
   connected. Prevents re-runs from killing a working gateway.

### Options to Unblock
1. **Larger instance** (e.g., n2d-standard-16, 16 vCPU, $0.54/hr) — may
   push k3s startup below the CLI timeout.
2. **Upstream openshell fix** — configurable health-check timeout or
   longer default wait.
3. **Brev launchable** — the web UI launchable deploys with the gateway
   pre-built, but this isn't available via CLI.
4. **Environment variable** — check if openshell respects an env var for
   health-check timeout (undocumented).

## Cost Summary

| Period | What | Cost |
|--------|------|------|
| Mar 25 early testing | 9 GPU instances × ~1hr | ~$6.50 |
| Mar 25-27 scheduled warmer | ~40 failed runs × 3 instances × ~8min | ~$2.50 |
| Mar 27 debugging | 3-4 debug instances × ~1hr | ~$1.00 |
| **Total** | | **~$10-15** |
| **Current burn rate** | 0 running instances | **$0.00/hr** |

## File Inventory

| File | Status | Purpose |
|------|--------|---------|
| `scripts/e2e-pool.sh` | ✅ New | Pool management CLI |
| `scripts/e2e-warm-startup.sh` | ✅ New | Self-contained startup for `--startup-script` |
| `scripts/e2e-warm-finalize.sh` | ✅ New | Secret-dependent finalization |
| `scripts/setup.sh` | ✅ Modified | Gateway retry logic, reuse healthy gateway |
| `scripts/brev-setup.sh` | ✅ Modified | Renumbered steps (no functional change) |
| `.github/workflows/e2e-brev.yaml` | ✅ Modified | Warm pool mode, parallel matrix, v0.6.322 |
| `.github/workflows/e2e-brev-trigger.yaml` | ✅ New | `/test-brev` PR comment trigger |
| `.github/workflows/e2e-pool-warmer.yaml` | ✅ New | Two-phase pool maintenance |
| `test/e2e/brev-e2e.test.js` | ✅ Modified | `WARM_INSTANCE` support, `--type` |
