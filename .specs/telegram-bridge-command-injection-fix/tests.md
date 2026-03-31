# Test Specification: Telegram Bridge Command Injection Fix

This test guide supports TDD implementation of the command injection fix for `scripts/telegram-bridge.js`.

## Test File

**New file:** `test/telegram-bridge.test.js`

## Test Patterns

Following existing project conventions:

- Use Vitest with `describe`, `it`, `expect`
- ESM imports
- Source file reading for static analysis tests
- Mock external dependencies (SSH, child_process)

---

## Phase 1: Input Validation Hardening - Test Guide

**Existing Tests to Modify:** None

**New Tests to Create:**

### 1.1 SANDBOX_NAME Validation

```javascript
describe("SANDBOX_NAME validation", () => {
  it("should accept valid alphanumeric names", () => {
    // Input: "nemoclaw", "my_sandbox", "test-123"
    // Expected: No error thrown
    // Covers: Valid SANDBOX_NAME patterns
  });

  it("should reject names with shell metacharacters", () => {
    // Input: "foo;rm -rf /", "test$(whoami)", "sandbox`id`"
    // Expected: validateName throws or returns error
    // Covers: SANDBOX_NAME with metacharacters causes startup to exit with error
  });

  it("should reject names starting with hyphen (option injection)", () => {
    // Input: "-v", "--help", "-rf"
    // Expected: validateName throws or returns error
    // Covers: SANDBOX_NAME starting with hyphen causes startup to exit with error
  });

  it("should reject empty names", () => {
    // Input: "", null, undefined
    // Expected: validateName throws or returns error
    // Covers: Edge case handling
  });
});
```

### 1.2 sessionId Sanitization

```javascript
describe("sessionId sanitization", () => {
  it("should preserve alphanumeric characters", () => {
    // Input: "12345678", "abc123"
    // Expected: Same value returned
    // Covers: Valid sessionId passes through
  });

  it("should strip special characters", () => {
    // Input: "123;rm -rf", "abc$(whoami)", "test`id`"
    // Expected: "123rmrf", "abcwhoami", "testid"
    // Covers: sessionId containing special characters gets sanitized
  });

  it("should handle empty result after sanitization", () => {
    // Input: ";;;", "$()", "``"
    // Expected: Error returned or default value used
    // Covers: Empty sessionId after sanitization returns error response
  });
});
```

### 1.3 Message Length Validation

```javascript
describe("message length validation", () => {
  it("should accept messages within limit", () => {
    // Input: "Hello", "A".repeat(4096)
    // Expected: Message processed normally
    // Covers: Normal messages work
  });

  it("should reject messages exceeding 4096 characters", () => {
    // Input: "A".repeat(4097)
    // Expected: Error response returned
    // Covers: Messages longer than 4096 characters rejected with user-friendly error
  });
});
```

**Test Implementation Notes:**

- Extract validation functions from telegram-bridge.js for unit testing
- Or use source code scanning similar to credential-exposure.test.js

---

## Phase 2: Stdin-Based Credential and Message Passing - Test Guide

**Existing Tests to Modify:** None

**New Tests to Create:**

### 2.1 Stdin Protocol

```javascript
describe("stdin-based message passing", () => {
  it("should write API key as first line of stdin", () => {
    // Setup: Mock spawn, capture stdin writes
    // Input: API_KEY="test-key", message="hello"
    // Expected: First write is "test-key\n"
    // Covers: API key written to stdin
  });

  it("should write message after API key", () => {
    // Setup: Mock spawn, capture stdin writes
    // Input: API_KEY="test-key", message="hello world"
    // Expected: Second write is "hello world", then stdin.end()
    // Covers: Message written to stdin
  });

  it("should close stdin after writing", () => {
    // Setup: Mock spawn, track stdin.end() call
    // Expected: stdin.end() called after writes
    // Covers: Proper stdin lifecycle
  });
});
```

### 2.2 Command Injection Prevention

```javascript
describe("command injection prevention", () => {
  it("should treat $() as literal text", () => {
    // Setup: Mock SSH that echoes stdin back
    // Input: message="$(whoami)"
    // Expected: Message appears literally, no command execution
    // Covers: Message containing $(whoami) is treated as literal text
  });

  it("should treat backticks as literal text", () => {
    // Setup: Mock SSH that echoes stdin back
    // Input: message="`id`"
    // Expected: Message appears literally, no command execution
    // Covers: Message containing backticks is treated as literal text
  });

  it("should treat single quotes as literal text", () => {
    // Setup: Mock SSH that echoes stdin back
    // Input: message="'; curl evil.com #"
    // Expected: Message appears literally, no command execution
    // Covers: Message containing single quotes is treated as literal text
  });
});
```

### 2.3 API Key Not in Process Arguments

```javascript
describe("API key protection", () => {
  it("should not include API key in spawn arguments", () => {
    // Setup: Mock spawn, capture arguments
    // Input: API_KEY="nvapi-secret-key"
    // Expected: "nvapi-secret-key" not in any spawn argument
    // Covers: NVIDIA_API_KEY no longer appears in process arguments
  });

  it("should construct remote script without embedded credentials", () => {
    // Setup: Inspect the cmd string passed to spawn
    // Expected: cmd contains 'read -r NVIDIA_API_KEY' not the actual key
    // Covers: Defense in depth
  });
});
```

**Test Implementation Notes:**

- Mock `spawn` from `child_process` to capture stdin writes
- Use `vi.spyOn` or manual mock replacement
- Consider creating a mock SSH helper

---

## Phase 3: Additional Security Hardening - Test Guide

**Existing Tests to Modify:** None

**New Tests to Create:**

### 3.1 execFileSync Usage

```javascript
describe("execFileSync for ssh-config", () => {
  it("should use execFileSync instead of execSync", () => {
    // Method: Source code scanning
    // Expected: No execSync calls with string interpolation
    // Covers: execFileSync used for all external command calls
    const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
    expect(src).not.toMatch(/execSync\s*\(/);
    expect(src).toMatch(/execFileSync\s*\(\s*OPENSHELL/);
  });

  it("should use resolved OPENSHELL path", () => {
    // Method: Source code scanning
    // Expected: OPENSHELL variable used, not bare "openshell" string
    // Covers: Resolved OPENSHELL path used consistently throughout
    const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
    expect(src).not.toMatch(/execFileSync\s*\(\s*["']openshell["']/);
  });
});
```

### 3.2 Temp File Security

```javascript
describe("temp file security", () => {
  it("should use mkdtempSync for unpredictable paths", () => {
    // Method: Source code scanning
    // Expected: fs.mkdtempSync used for temp directory
    // Covers: Temp SSH config files use unpredictable paths
    const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
    expect(src).toMatch(/mkdtempSync\s*\(/);
  });

  it("should not use predictable temp file names", () => {
    // Method: Source code scanning
    // Expected: No /tmp/nemoclaw-tg-ssh-${sessionId} pattern
    // Covers: No symlink race vulnerability
    const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
    expect(src).not.toMatch(/\/tmp\/nemoclaw-tg-ssh-\$\{/);
  });

  it("should set restrictive permissions on temp files", () => {
    // Method: Source code scanning
    // Expected: mode: 0o600 in writeFileSync options
    // Covers: Temp files created with restrictive permissions
    const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
    expect(src).toMatch(/mode:\s*0o600/);
  });

  it("should clean up temp files after use", () => {
    // Method: Source code scanning
    // Expected: unlinkSync and rmdirSync calls in finally/cleanup
    // Covers: Temp files cleaned up after use
    const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
    expect(src).toMatch(/unlinkSync\s*\(\s*confPath\s*\)/);
    expect(src).toMatch(/rmdirSync\s*\(\s*confDir\s*\)/);
  });
});
```

**Test Implementation Notes:**

- Use source code scanning pattern from credential-exposure.test.js
- Static analysis catches patterns without needing runtime mocks

---

## Phase 4: Test Coverage - Test Guide

This phase implements the tests defined above.

**Acceptance Criteria Verification:**

```javascript
describe("security fix verification", () => {
  it("all validation unit tests pass", () => {
    // Meta-test: Run Phase 1 tests
  });

  it("injection payloads treated as literal text", () => {
    // Meta-test: Run Phase 2 injection tests
  });

  it("API key not in process arguments", () => {
    // Meta-test: Run Phase 2 API key tests
  });

  it("temp files cleaned up", () => {
    // Meta-test: Run Phase 3 temp file tests
  });

  it("existing tests still pass", () => {
    // Run: npm test
    // Expected: All tests pass including new ones
  });
});
```

---

## Integration Test (Optional)

If end-to-end testing is needed:

```javascript
describe("telegram-bridge integration", () => {
  it("should process normal message through mock SSH", async () => {
    // Setup:
    // - Mock Telegram API responses
    // - Mock SSH that captures stdin and returns response
    // - Start bridge in test mode
    // Input: Simulated Telegram message "Hello"
    // Expected: Response returned without injection
  });
});
```

**Note:** Integration tests may be deferred to manual testing given the complexity of mocking Telegram + SSH.
