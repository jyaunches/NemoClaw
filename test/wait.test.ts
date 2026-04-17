// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert";
import { describe, expect, it } from "vitest";
import { sleepMs, sleepSeconds } from "../src/lib/wait.ts";

describe("wait utility", () => {
  it("sleepMs blocks for approximately the requested time", () => {
    const start = Date.now();
    sleepMs(100);
    const end = Date.now();
    const duration = end - start;

    // Allow for some jitter, but should be at least 100ms and not excessively more.
    assert.ok(duration >= 100, `duration ${duration}ms < 100ms`);
    assert.ok(duration < 200, `duration ${duration}ms > 200ms`);
  });

  it("sleepSeconds blocks for approximately the requested time", () => {
    const start = Date.now();
    sleepSeconds(0.1);
    const end = Date.now();
    const duration = end - start;

    assert.ok(duration >= 100, `duration ${duration}ms < 100ms`);
    assert.ok(duration < 200, `duration ${duration}ms > 200ms`);
  });

  it("returns immediately for zero or negative time", () => {
    const start = Date.now();
    sleepMs(0);
    sleepMs(-50);
    const end = Date.now();
    const duration = end - start;
    assert.ok(duration < 50, `duration ${duration}ms > 50ms`);
  });
});
