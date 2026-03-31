// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Telegram bridge security fix.
 *
 * Tests the command injection prevention measures:
 * - Input validation (SANDBOX_NAME, sessionId, message length)
 * - Stdin-based credential/message passing
 * - Source code patterns for security hardening
 *
 * See: https://github.com/NVIDIA/NemoClaw/issues/118
 *      https://github.com/NVIDIA/NemoClaw/pull/119
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

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

    it("should preserve hyphens", () => {
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

    it("should handle numeric input (Telegram chat IDs)", () => {
      expect(bridge.sanitizeSessionId(123456789)).toBe("123456789");
      expect(bridge.sanitizeSessionId(-123456789)).toBe("-123456789");
    });
  });

  describe("MAX_MESSAGE_LENGTH", () => {
    const bridge = createMockBridge();

    it("should be 4096 (Telegram's limit)", () => {
      expect(bridge.MAX_MESSAGE_LENGTH).toBe(4096);
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
  });
});
