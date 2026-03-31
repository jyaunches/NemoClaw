---
name: running-e2e-locally
description: Run Brev E2E tests locally that mirror the CI workflow. Use when debugging e2e-brev tests, running telegram-injection or credential-sanitization tests locally, or when CI tests fail and need local reproduction.
allowed-tools: Bash, Read
argument-hint: "[test-suite]"
---

# Running Brev E2E Tests Locally

Run the same E2E tests that run in CI (via `.github/workflows/e2e-brev.yaml`) on your local machine with a real Brev instance.

## When to Use

- Debugging failing CI e2e-brev tests
- Testing changes to `test/e2e/test-telegram-injection.sh` or other E2E scripts
- Testing changes to `test/e2e/brev-e2e.test.js` (the test harness)
- Reproducing CI failures locally for closer monitoring

## Prerequisites

1. **Brev CLI authenticated:**

   ```bash
   brev login
   ```

   This creates `~/.brev/credentials.json` with a refresh token.

2. **GitHub CLI authenticated:**

   ```bash
   gh auth login
   ```

   Used to download OpenShell binaries from private repos.

3. **NVIDIA_API_KEY exported:**

   ```bash
   export NVIDIA_API_KEY=nvapi-...
   ```

## Quick Start

```bash
# Run telegram-injection tests (default)
./scripts/run-e2e-local.sh

# Run a specific test suite
./scripts/run-e2e-local.sh telegram-injection
./scripts/run-e2e-local.sh credential-sanitization
./scripts/run-e2e-local.sh full
./scripts/run-e2e-local.sh all

# Run with a custom instance name
./scripts/run-e2e-local.sh telegram-injection my-debug-instance
```

## What It Does

The script (`scripts/run-e2e-local.sh`):

1. Extracts `BREV_API_TOKEN` from `~/.brev/credentials.json`
2. Extracts `GITHUB_TOKEN` from `gh auth token`
3. Sets `INSTANCE_NAME` to `local-e2e-<timestamp>` (or custom name)
4. Sets `KEEP_ALIVE=true` so the instance stays up for debugging
5. Runs `npx vitest run --project e2e-brev --reporter=verbose`

This mirrors exactly what `.github/workflows/e2e-brev.yaml` does.

## Test Suites

| Suite | Description |
|-------|-------------|
| `full` | Complete user journey: install → onboard → sandbox verify → live inference. Destroys and rebuilds sandbox. |
| `credential-sanitization` | 24 tests for credential stripping, auth-profiles deletion, blueprint digest verification. |
| `telegram-injection` | 18 tests for command injection prevention through various attack vectors. |
| `all` | Runs credential-sanitization + telegram-injection (not full). |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KEEP_ALIVE` | `true` | Set to `false` to auto-delete instance after test |

## After the Test

With `KEEP_ALIVE=true` (default), the Brev instance stays running:

```bash
# SSH into the instance for debugging
brev refresh && ssh local-e2e-<timestamp>

# Check sandbox status
ssh local-e2e-<timestamp> "openshell sandbox list"

# View test logs
ssh local-e2e-<timestamp> "cat /tmp/test-output.log"

# Clean up when done
brev delete local-e2e-<timestamp>
```

## Troubleshooting

**Tests skipped (0 tests ran):**

- Check that all env vars are set: `BREV_API_TOKEN`, `GITHUB_TOKEN`, `NVIDIA_API_KEY`, `INSTANCE_NAME`
- The test uses `describe.runIf(hasRequiredVars)` which skips if any are missing

**Brev token expired:**

- Run `brev login` to refresh credentials

**GitHub token issues:**

- Run `gh auth status` to verify authentication
- Run `gh auth refresh` if token is stale

**SSH connection fails:**

- Run `brev refresh` to update SSH config
- Check instance status: `brev ls`

## Related Files

- `scripts/run-e2e-local.sh` — The wrapper script
- `test/e2e/brev-e2e.test.js` — Vitest test harness that provisions Brev instances
- `.github/workflows/e2e-brev.yaml` — CI workflow this mirrors
- `test/e2e/test-telegram-injection.sh` — Telegram injection test script
- `test/e2e/test-credential-sanitization.sh` — Credential sanitization test script
- `scripts/brev-setup.sh` — Bootstrap script that installs Docker, Node.js, OpenShell, and creates the sandbox
