# Validation Plan: Telegram Bridge Command Injection Fix

Generated from: `.specs/telegram-bridge-command-injection-fix/spec.md`
Test Spec: `.specs/telegram-bridge-command-injection-fix/tests.md`

## Overview

**Feature**: Fix command injection vulnerability in Telegram bridge by passing user messages via stdin instead of shell interpolation, plus defense-in-depth hardening.

**Primary Validation**: Run `test/e2e/test-telegram-injection.sh` via brev-e2e test suite

## Validation Strategy

The existing E2E test `test/e2e/test-telegram-injection.sh` provides comprehensive validation of the security fix. This test:

1. Creates a real sandbox environment on Brev
2. Tests actual SSH + stdin message passing
3. Verifies injection payloads are treated as literal text
4. Confirms API key doesn't leak to process table
5. Validates SANDBOX_NAME input validation

### Test Coverage Mapping

| E2E Test | Spec Phase | Acceptance Criteria |
|----------|------------|---------------------|
| T1: `$(command)` substitution | Phase 2 | Message containing `$(whoami)` treated as literal |
| T2: Backtick injection | Phase 2 | Message containing backticks treated as literal |
| T3: Single-quote breakout | Phase 2 | Message containing single quotes treated as literal |
| T4: `${NVIDIA_API_KEY}` expansion | Phase 2 | API key not expanded in message |
| T5: Process table leak check | Phase 2 | API key not in process arguments |
| T6: SANDBOX_NAME metacharacters | Phase 1 | SANDBOX_NAME with metacharacters rejected |
| T7: Leading-hyphen option injection | Phase 1 | SANDBOX_NAME starting with hyphen rejected |
| T8: Normal message regression | Phase 2 | Normal messages work correctly |

---

## Validation Execution

### Prerequisites

```bash
# Required environment variables
export BREV_API_TOKEN="<refresh_token from ~/.brev/credentials.json>"
export NVIDIA_API_KEY="<your nvidia api key>"
export GITHUB_TOKEN="<your github token>"
export INSTANCE_NAME="telegram-injection-fix-$(date +%s)"
export TEST_SUITE="telegram-injection"
```

### Run Validation

```bash
# Run the telegram-injection E2E test via brev
npx vitest run --project e2e-brev
```

### Expected Output

```text
✓ telegram bridge injection suite passes on remote VM

  Telegram Injection Test Results:
    Passed:  12+
    Failed:  0
    Skipped: 0
```

---

## Validation Scenarios (from test-telegram-injection.sh)

### Phase 0: Prerequisites [STATUS: pending]

**Validates**: Test environment is ready

- NVIDIA_API_KEY is set
- openshell found on PATH
- nemoclaw found on PATH
- Sandbox is running

---

### Phase 1: Command Substitution Injection [STATUS: pending]

#### Scenario T1: $(command) Not Executed

**Given**: A message containing `$(touch /tmp/injection-proof-t1 && echo INJECTED)`
**When**: Message is passed via stdin to sandbox
**Then**: `/tmp/injection-proof-t1` is NOT created (command not executed)

#### Scenario T2: Backtick Command Not Executed

**Given**: A message containing `` `touch /tmp/injection-proof-t2` ``
**When**: Message is passed via stdin to sandbox
**Then**: `/tmp/injection-proof-t2` is NOT created (command not executed)

---

### Phase 2: Quote Breakout Injection [STATUS: pending]

#### Scenario T3: Single-Quote Breakout Prevented

**Given**: A message containing `'; touch /tmp/injection-proof-t3; echo '`
**When**: Message is passed via stdin to sandbox
**Then**: `/tmp/injection-proof-t3` is NOT created (breakout prevented)

---

### Phase 3: Parameter Expansion [STATUS: pending]

#### Scenario T4: ${NVIDIA_API_KEY} Not Expanded

**Given**: A message containing `${NVIDIA_API_KEY}`
**When**: Message is echoed back from sandbox
**Then**: Result contains literal `${NVIDIA_API_KEY}`, NOT the actual key value

---

### Phase 4: Process Table Leak Check [STATUS: pending]

#### Scenario T5: API Key Not in Process Table

**Given**: NVIDIA_API_KEY is set in environment
**When**: Checking `ps aux` on host and sandbox
**Then**: API key value does not appear in any process arguments

---

### Phase 5: SANDBOX_NAME Validation [STATUS: pending]

#### Scenario T6: Metacharacters Rejected

**Given**: SANDBOX_NAME set to `foo;rm -rf /`
**When**: validateName() is called
**Then**: Validation throws error, name rejected

#### Scenario T7: Leading Hyphen Rejected

**Given**: SANDBOX_NAME set to `--help`
**When**: validateName() is called
**Then**: Validation throws error, option injection prevented

#### Additional Invalid Names Tested

- `$(whoami)` → rejected
- `` `id` `` → rejected
- `foo bar` → rejected
- `../etc/passwd` → rejected
- `UPPERCASE` → rejected

---

### Phase 6: Normal Message Regression [STATUS: pending]

#### Scenario T8: Normal Message Works

**Given**: A normal message "Hello, what is two plus two?"
**When**: Message is passed via stdin to sandbox
**Then**: Message is echoed back correctly

#### Scenario T8b: Special Characters Handled

**Given**: A message with safe special chars "What's the meaning of life? It costs $5 & is 100% free!"
**When**: Message is processed
**Then**: No errors, message processed successfully

---

## Summary

| Phase | Tests | Status |
|-------|-------|--------|
| Phase 0: Prerequisites | 4 | pending |
| Phase 1: Command Substitution | 2 | pending |
| Phase 2: Quote Breakout | 1 | pending |
| Phase 3: Parameter Expansion | 1 | pending |
| Phase 4: Process Table | 1 | pending |
| Phase 5: SANDBOX_NAME Validation | 7 | pending |
| Phase 6: Normal Message Regression | 2 | pending |
| **Total** | **18** | **pending** |

---

## Post-Validation

After E2E tests pass:

1. Run unit tests: `npm test`
2. Run linters: `make check`
3. Verify no regressions in existing tests
