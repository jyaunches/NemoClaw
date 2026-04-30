// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, afterEach } from "vitest";
import { renderBox } from "./banner.js";

describe("renderBox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a basic box with default minInner of 53", () => {
    const lines = renderBox(["  Hello"]);
    // First line is top border
    expect(lines[0]).toMatch(/^\s+┌─+┐$/);
    // Inner width should be at least 53
    const inner = lines[0].length - 4; // "  ┌" (3) + "┐" (1)
    expect(inner).toBeGreaterThanOrEqual(53);
    // Last line is bottom border
    expect(lines[lines.length - 1]).toMatch(/^\s+└─+┘$/);
  });

  it("expands box for long content", () => {
    const longUrl = "  Public URL:  https://very-long-subdomain-name.trycloudflare.com";
    const lines = renderBox([longUrl]);
    // The content line should have trailing space before │
    const contentLine = lines[1];
    expect(contentLine).toMatch(/\s\s│$/);
    // Should NOT truncate the URL
    expect(contentLine).toContain("very-long-subdomain-name.trycloudflare.com");
  });

  it("renders null entries as blank separator rows", () => {
    const lines = renderBox(["  Title", null, "  Content"]);
    // Line at index 2 should be a blank row
    const blankLine = lines[2];
    expect(blankLine).toMatch(/^\s+│\s+│$/);
  });

  it("produces lines of equal length (box integrity)", () => {
    const lines = renderBox([
      "  NemoClaw Services",
      null,
      "  Public URL:  https://abc-def-ghi.trycloudflare.com",
      "  Messaging:   via OpenClaw native channels (if configured)",
      null,
      "  Run 'openshell term' to monitor egress approvals",
    ]);
    const lengths = lines.map((l) => l.length);
    expect(new Set(lengths).size).toBe(1);
  });

  it("ensures at least 2 trailing spaces before closing border", () => {
    const url = "  Public URL:  https://some-subdomain.trycloudflare.com";
    const lines = renderBox([url]);
    const contentLine = lines[1];
    // Extract text between │ markers
    const match = contentLine.match(/│(.+)│/);
    expect(match).not.toBeNull();
    const content = match![1];
    // Should end with at least 2 spaces (the +2 in contentMax calculation)
    expect(content).toMatch(/\s{2,}$/);
  });

  it("caps width at terminal columns", () => {
    // Mock a narrow terminal by overriding the columns getter
    const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", {
      get: () => 80,
      configurable: true,
    });
    try {
      const veryLong = "x".repeat(200);
      const lines = renderBox([veryLong]);
      // Every rendered row should stay within the terminal width
      expect(lines.every((line) => line.length <= 80)).toBe(true);
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, "columns", original);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (process.stdout as unknown as Record<string, unknown>)["columns"];
      }
    }
  });

  it("respects custom minInner option", () => {
    const lines = renderBox(["  Hi"], { minInner: 30 });
    const inner = lines[0].length - 4;
    expect(inner).toBeGreaterThanOrEqual(30);
  });

  it("handles empty lines array", () => {
    const lines = renderBox([]);
    expect(lines).toHaveLength(2); // just top + bottom border
    expect(lines[0]).toMatch(/^\s+┌─+┐$/);
    expect(lines[1]).toMatch(/^\s+└─+┘$/);
  });
});
