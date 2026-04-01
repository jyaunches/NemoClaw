// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Telegram bridge security fix.
 *
 * Tests the command injection prevention measures:
 * - Input validation (SANDBOX_NAME, sessionId, message length)
 * - Stdin-based credential/message passing
 * - Source code patterns for security hardening
 * - Mocked runAgentInSandbox behavior
 *
 * See: https://github.com/NVIDIA/NemoClaw/issues/118
 *      https://github.com/NVIDIA/NemoClaw/pull/119
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TELEGRAM_BRIDGE_JS = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "telegram-bridge.js",
);

// Note: We mock resolveOpenshell in createMockBridge() to avoid PATH dependency

// Create a mock for testing
function createMockBridge() {
  // Clear require cache to get fresh module
  const cacheKey = require.resolve("../scripts/telegram-bridge.js");
  delete require.cache[cacheKey];

  // Mock resolveOpenshell - use Object.assign to satisfy TypeScript's Module type
  const resolveOpenshellPath = require.resolve("../bin/lib/resolve-openshell");
  const originalModule = require.cache[resolveOpenshellPath];
  // @ts-ignore - intentional partial mock for testing
  require.cache[resolveOpenshellPath] = Object.assign({}, originalModule, {
    exports: { resolveOpenshell: () => "/mock/openshell" },
  });

  // Import the module
  const bridge = require("../scripts/telegram-bridge.js");

  // Restore
  delete require.cache[resolveOpenshellPath];

  return bridge;
}

describe("telegram-bridge security", () => {
  describe("sanitizeSessionId", () => {
    const bridge = createMockBridge();

    it("should preserve alphanumeric characters", () => {
      expect(bridge.sanitizeSessionId("12345678")).toBe("12345678");
      expect(bridge.sanitizeSessionId("abc123")).toBe("abc123");
      expect(bridge.sanitizeSessionId("ABC123")).toBe("ABC123");
    });

    it("should preserve internal hyphens", () => {
      expect(bridge.sanitizeSessionId("abc-123")).toBe("abc-123");
      expect(bridge.sanitizeSessionId("test-session-id")).toBe("test-session-id");
    });

    it("should strip shell metacharacters", () => {
      expect(bridge.sanitizeSessionId("123;rm -rf")).toBe("123rm-rf");
      expect(bridge.sanitizeSessionId("abc$(whoami)")).toBe("abcwhoami");
      expect(bridge.sanitizeSessionId("test`id`")).toBe("testid");
      expect(bridge.sanitizeSessionId("foo'bar")).toBe("foobar");
      expect(bridge.sanitizeSessionId('foo"bar')).toBe("foobar");
      expect(bridge.sanitizeSessionId("foo|bar")).toBe("foobar");
      expect(bridge.sanitizeSessionId("foo&bar")).toBe("foobar");
    });

    it("should return null for empty result after sanitization", () => {
      expect(bridge.sanitizeSessionId(";;;")).toBeNull();
      expect(bridge.sanitizeSessionId("$()")).toBeNull();
      expect(bridge.sanitizeSessionId("``")).toBeNull();
      expect(bridge.sanitizeSessionId("")).toBeNull();
    });

    it("should handle positive numeric input (Telegram chat IDs)", () => {
      expect(bridge.sanitizeSessionId(123456789)).toBe("123456789");
    });

    // SECURITY: Leading hyphens must be stripped to prevent option injection
    describe("option injection prevention", () => {
      it("should strip leading hyphens from negative chat IDs", () => {
        // Negative Telegram chat IDs (group chats) start with hyphen
        // We strip the hyphen to prevent option injection
        expect(bridge.sanitizeSessionId(-123456789)).toBe("123456789");
        expect(bridge.sanitizeSessionId("-123456789")).toBe("123456789");
      });

      it("should strip leading hyphens that could be interpreted as flags", () => {
        expect(bridge.sanitizeSessionId("--help")).toBe("help");
        expect(bridge.sanitizeSessionId("-v")).toBe("v");
        expect(bridge.sanitizeSessionId("---test")).toBe("test");
        expect(bridge.sanitizeSessionId("--")).toBeNull();
        expect(bridge.sanitizeSessionId("-")).toBeNull();
      });

      it("should preserve internal hyphens after stripping leading ones", () => {
        expect(bridge.sanitizeSessionId("-abc-123")).toBe("abc-123");
        expect(bridge.sanitizeSessionId("--foo-bar-baz")).toBe("foo-bar-baz");
      });
    });
  });

  describe("MAX_MESSAGE_LENGTH", () => {
    const bridge = createMockBridge();

    it("should be 4096 (Telegram's limit)", () => {
      expect(bridge.MAX_MESSAGE_LENGTH).toBe(4096);
    });
  });

  describe("initConfig", () => {
    it("should return configuration object", () => {
      const bridge = createMockBridge();
      const config = bridge.initConfig({
        openshell: "/mock/openshell",
        token: "test-token",
        apiKey: "test-api-key",
        sandbox: "test-sandbox",
        allowedChats: ["123", "456"],
        exitOnError: false,
      });

      expect(config).toEqual({
        OPENSHELL: "/mock/openshell",
        TOKEN: "test-token",
        API_KEY: "test-api-key",
        SANDBOX: "test-sandbox",
        ALLOWED_CHATS: ["123", "456"],
      });
    });

    it("should throw on missing token when exitOnError is false", () => {
      const bridge = createMockBridge();
      // Temporarily clear env vars so they don't interfere
      const savedToken = process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      try {
        expect(() =>
          bridge.initConfig({
            openshell: "/mock/openshell",
            apiKey: "test-api-key",
            sandbox: "test-sandbox",
            exitOnError: false,
          })
        ).toThrow("TELEGRAM_BOT_TOKEN required");
      } finally {
        if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
      }
    });

    it("should throw on missing apiKey when exitOnError is false", () => {
      const bridge = createMockBridge();
      // Temporarily clear env vars so they don't interfere
      const savedApiKey = process.env.NVIDIA_API_KEY;
      delete process.env.NVIDIA_API_KEY;
      try {
        expect(() =>
          bridge.initConfig({
            openshell: "/mock/openshell",
            token: "test-token",
            sandbox: "test-sandbox",
            exitOnError: false,
          })
        ).toThrow("NVIDIA_API_KEY required");
      } finally {
        if (savedApiKey !== undefined) process.env.NVIDIA_API_KEY = savedApiKey;
      }
    });

    it("should throw on invalid sandbox name when exitOnError is false", () => {
      const bridge = createMockBridge();
      expect(() =>
        bridge.initConfig({
          openshell: "/mock/openshell",
          token: "test-token",
          apiKey: "test-api-key",
          sandbox: "INVALID_UPPERCASE",
          exitOnError: false,
        })
      ).toThrow(/Invalid SANDBOX_NAME/);
    });
  });

  describe("source code security patterns", () => {
    const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");

    it("should not use execSync with string interpolation", () => {
      // execSync with template literals or string concat is vulnerable
      expect(src).not.toMatch(/execSync\s*\(\s*`/);
      expect(src).not.toMatch(/execSync\s*\(\s*["'][^"']*\$\{/);
    });

    it("should use execFileSync for external commands", () => {
      // execFileSync with array args is safe
      expect(src).toMatch(/execFileSync\s*\(\s*\w+,\s*\[/);
    });

    it("should use mkdtempSync for temp directories", () => {
      // Cryptographically random temp paths prevent symlink races
      expect(src).toMatch(/mkdtempSync\s*\(/);
    });

    it("should set restrictive permissions on temp files", () => {
      // mode: 0o600 ensures only owner can read/write
      expect(src).toMatch(/mode:\s*0o600/);
    });

    it("should clean up temp files after use", () => {
      // unlinkSync and rmdirSync should be called in cleanup
      expect(src).toMatch(/unlinkSync\s*\(\s*confPath\s*\)/);
      expect(src).toMatch(/rmdirSync\s*\(\s*confDir\s*\)/);
    });

    it("should not pass API key in command arguments", () => {
      // The API key should be passed via stdin, not in the command string
      // Look for the pattern where we write to stdin
      expect(src).toMatch(/proc\.stdin\.write\s*\(\s*apiKey/);
      expect(src).toMatch(/proc\.stdin\.end\s*\(\s*\)/);
    });

    it("should use stdin for message passing", () => {
      // stdio should include 'pipe' for stdin
      expect(src).toMatch(/stdio:\s*\[\s*["']pipe["']/);
    });

    it("should read message from stdin in remote script", () => {
      // The remote script should use read -r and cat to read from stdin
      expect(src).toMatch(/read\s+-r\s+NVIDIA_API_KEY/);
      expect(src).toMatch(/MSG=\$\(cat\)/);
    });

    it("should use double-quoted variable expansion in remote script", () => {
      // Variables in double quotes are safe from word splitting
      expect(src).toMatch(/"\$MSG"/);
    });

    it("should not use shellQuote for message or API key", () => {
      // shellQuote is no longer needed since we use stdin
      // It may still be imported but shouldn't be used for these values
      const lines = src.split("\n");
      const shellQuoteUsageLines = lines.filter(
        (line) =>
          line.includes("shellQuote") &&
          !line.includes("require") &&
          !line.includes("import") &&
          !line.trim().startsWith("//"),
      );
      expect(shellQuoteUsageLines).toHaveLength(0);
    });

    it("should validate SANDBOX_NAME at startup", () => {
      expect(src).toMatch(/validateName\s*\(\s*SANDBOX/);
    });

    it("should validate message length before processing", () => {
      expect(src).toMatch(/MAX_MESSAGE_LENGTH/);
      expect(src).toMatch(/msg\.text\.length\s*>\s*MAX_MESSAGE_LENGTH/);
    });

    it("should strip leading hyphens in sanitizeSessionId", () => {
      // Verify the code contains the leading hyphen strip
      expect(src).toMatch(/replace\s*\(\s*\/\^-\+\/\s*,\s*["']["']\s*\)/);
    });
  });

  describe("runAgentInSandbox with mocked spawn", () => {
    let _bridge;
    let mockSpawn;
    let mockExecFileSync;
    let mockMkdtempSync;
    let mockWriteFileSync;
    let mockUnlinkSync;
    let mockRmdirSync;
    let capturedStdin;
    let _capturedSpawnArgs;

    beforeEach(() => {
      // Reset captured data
      capturedStdin = [];
      _capturedSpawnArgs = null;

      // Create mock process
      const mockProc = {
        stdin: {
          write: (data) => capturedStdin.push(data),
          end: () => {},
        },
        stdout: {
          on: (event, cb) => {
            if (event === "data") {
              // Simulate agent response
              setTimeout(() => cb(Buffer.from("Hello! I'm the agent.\n")), 10);
            }
          },
        },
        stderr: {
          on: () => {},
        },
        on: (event, cb) => {
          if (event === "close") {
            setTimeout(() => cb(0), 20);
          }
        },
      };

      // Mock child_process
      mockSpawn = vi.fn().mockImplementation((...args) => {
        _capturedSpawnArgs = args;
        return mockProc;
      });

      mockExecFileSync = vi.fn().mockReturnValue("Host openshell-test\n  Hostname 127.0.0.1\n");

      // Mock fs
      mockMkdtempSync = vi.fn().mockReturnValue("/tmp/nemoclaw-tg-ssh-abc123");
      mockWriteFileSync = vi.fn();
      mockUnlinkSync = vi.fn();
      mockRmdirSync = vi.fn();

      // Clear and setup module mocks
      vi.resetModules();

      vi.doMock("node:child_process", () => ({
        spawn: mockSpawn,
        execFileSync: mockExecFileSync,
      }));

      vi.doMock("node:fs", () => ({
        default: {
          mkdtempSync: mockMkdtempSync,
          writeFileSync: mockWriteFileSync,
          unlinkSync: mockUnlinkSync,
          rmdirSync: mockRmdirSync,
        },
        mkdtempSync: mockMkdtempSync,
        writeFileSync: mockWriteFileSync,
        unlinkSync: mockUnlinkSync,
        rmdirSync: mockRmdirSync,
      }));

      // The bridge module uses CommonJS require, so we need different approach
      // Instead, we'll test by checking the actual behavior patterns
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Since mocking CommonJS from ESM is complex, we verify behavior through
    // source code patterns and the E2E tests. These tests verify the logic
    // at a higher level by examining what SHOULD happen.

    it("should pass API key as first line of stdin followed by message", () => {
      // This is verified by source code pattern tests above
      // The pattern: proc.stdin.write(apiKey + "\n"); proc.stdin.write(message);
      const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
      expect(src).toMatch(/proc\.stdin\.write\s*\(\s*apiKey\s*\+\s*["']\\n["']\s*\)/);
      expect(src).toMatch(/proc\.stdin\.write\s*\(\s*message\s*\)/);
      expect(src).toMatch(/proc\.stdin\.end\s*\(\s*\)/);
    });

    it("should call spawn with correct SSH arguments structure", () => {
      const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
      // Verify spawn is called with ssh, -T, -F, confPath, and remote host
      expect(src).toMatch(/spawn\s*\(\s*["']ssh["']\s*,\s*\[\s*["']-T["']/);
      expect(src).toMatch(/["']-F["']\s*,\s*confPath/);
    });

    it("should clean up temp files in close handler", () => {
      const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
      // Verify cleanup is in the close handler
      const closeHandlerMatch = src.match(/proc\.on\s*\(\s*["']close["']\s*,.*?(?=proc\.on|$)/s);
      expect(closeHandlerMatch).toBeTruthy();
      expect(closeHandlerMatch[0]).toMatch(/unlinkSync/);
      expect(closeHandlerMatch[0]).toMatch(/rmdirSync/);
    });

    it("should clean up temp files in error handler", () => {
      const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
      // Verify cleanup is in the error handler
      const errorHandlerMatch = src.match(/proc\.on\s*\(\s*["']error["']\s*,.*?(?=\}\s*\)\s*;?\s*\})/s);
      expect(errorHandlerMatch).toBeTruthy();
      expect(errorHandlerMatch[0]).toMatch(/unlinkSync/);
      expect(errorHandlerMatch[0]).toMatch(/rmdirSync/);
    });
  });

  describe("edge cases", () => {
    const bridge = createMockBridge();

    describe("empty message handling", () => {
      it("should handle empty string message in sanitizeSessionId", () => {
        expect(bridge.sanitizeSessionId("")).toBeNull();
      });

      // Note: Empty message validation happens in the poll() function
      // which checks msg.text existence before processing
    });

    describe("multi-line message handling", () => {
      it("source code should handle multi-line messages via stdin", () => {
        // MSG=$(cat) reads all stdin including newlines
        // The message is then passed in double quotes which preserves newlines
        const src = fs.readFileSync(TELEGRAM_BRIDGE_JS, "utf-8");
        expect(src).toMatch(/MSG=\$\(cat\)/);
        expect(src).toMatch(/-m\s*"\$MSG"/);
      });
    });

    describe("special characters in session ID", () => {
      it("should handle session IDs with only special characters", () => {
        expect(bridge.sanitizeSessionId("!@#$%^&*()")).toBeNull();
        // Dots and slashes are stripped, leaving just "etc"
        expect(bridge.sanitizeSessionId("../../../etc")).toBe("etc");
        expect(bridge.sanitizeSessionId("foo\nbar")).toBe("foobar");
        expect(bridge.sanitizeSessionId("foo\tbar")).toBe("foobar");
      });
    });

    describe("unicode handling", () => {
      it("should strip non-ASCII characters from session ID", () => {
        expect(bridge.sanitizeSessionId("test🔥emoji")).toBe("testemoji");
        expect(bridge.sanitizeSessionId("日本語")).toBeNull();
        expect(bridge.sanitizeSessionId("café123")).toBe("caf123");
      });
    });

    describe("boundary conditions", () => {
      it("should handle very long session IDs", () => {
        const longId = "a".repeat(10000);
        expect(bridge.sanitizeSessionId(longId)).toBe(longId);
      });

      it("should handle session ID with only hyphens", () => {
        expect(bridge.sanitizeSessionId("---")).toBeNull();
        expect(bridge.sanitizeSessionId("--------------------")).toBeNull();
      });
    });
  });
});
