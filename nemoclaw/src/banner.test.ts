// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, afterEach } from "vitest";
import { renderBox } from "./banner.js";

describe("renderBox (nemoclaw plugin)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders registration banner with dynamic width", () => {
    const lines = renderBox([
      "  NemoClaw registered",
      null,
      "  Endpoint:  https://integrate.api.nvidia.com/v1",
      "  Provider:  NVIDIA Endpoints",
      "  Model:     nvidia/nemotron-3-super-120b-a12b",
      "  Slash:     /nemoclaw",
    ]);
    // All lines same length
    const lengths = lines.map((l) => l.length);
    expect(new Set(lengths).size).toBe(1);
    // Endpoint line has trailing space before │
    const endpointLine = lines[3];
    expect(endpointLine).toMatch(/\s{2,}│$/);
  });

  it("expands for very long endpoint URLs", () => {
    const longEndpoint =
      "  Endpoint:  https://very-long-custom-endpoint.internal.nvidia.com/v1/completions";
    const lines = renderBox([longEndpoint]);
    // Should contain the full URL without truncation
    expect(lines[1]).toContain("very-long-custom-endpoint.internal.nvidia.com");
    // Should have trailing space
    expect(lines[1]).toMatch(/\s{2,}│$/);
  });

  it("produces equal-length lines (box integrity)", () => {
    const lines = renderBox(["  Short", null, "  A much longer line of text here"]);
    const lengths = lines.map((l) => l.length);
    expect(new Set(lengths).size).toBe(1);
  });
});
