// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";

// Import from compiled dist/ for coverage attribution.
import nim from "../../dist/lib/nim";

const require = createRequire(import.meta.url);
const NIM_DIST_PATH = require.resolve("../../dist/lib/nim");
const RUNNER_PATH = require.resolve("../../dist/lib/runner");

function loadNimWithMockedRunner(runCapture: Mock) {
  const runner = require(RUNNER_PATH);
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;
  const originalRunArgv = runner.runArgv;
  const originalRunArgvCapture = runner.runArgvCapture;

  delete require.cache[NIM_DIST_PATH];
  runner.run = vi.fn();
  runner.runArgv = vi.fn();
  runner.runCapture = runCapture;
  runner.runArgvCapture = runCapture;
  const nimModule = require(NIM_DIST_PATH);

  return {
    nimModule,
    restore() {
      delete require.cache[NIM_DIST_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
      runner.runArgv = originalRunArgv;
      runner.runArgvCapture = originalRunArgvCapture;
    },
  };
}

describe("nim", () => {
  describe("listModels", () => {
    it("returns 5 models", () => {
      expect(nim.listModels().length).toBe(5);
    });

    it("each model has name, image, and minGpuMemoryMB", () => {
      for (const m of nim.listModels()) {
        expect(m.name).toBeTruthy();
        expect(m.image).toBeTruthy();
        expect(typeof m.minGpuMemoryMB === "number").toBeTruthy();
        expect(m.minGpuMemoryMB > 0).toBeTruthy();
      }
    });
  });

  describe("getImageForModel", () => {
    it("returns correct image for known model", () => {
      expect(nim.getImageForModel("nvidia/nemotron-3-nano-30b-a3b")).toBe(
        "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
      );
    });

    it("returns null for unknown model", () => {
      expect(nim.getImageForModel("bogus/model")).toBe(null);
    });
  });

  describe("containerName", () => {
    it("prefixes with nemoclaw-nim-", () => {
      expect(nim.containerName("my-sandbox")).toBe("nemoclaw-nim-my-sandbox");
    });
  });

  describe("detectGpu", () => {
    it("returns object or null", () => {
      const gpu = nim.detectGpu();
      if (gpu !== null) {
        expect(gpu.type).toBeTruthy();
        expect(typeof gpu.count === "number").toBeTruthy();
        expect(typeof gpu.totalMemoryMB === "number").toBeTruthy();
        expect(typeof gpu.nimCapable === "boolean").toBeTruthy();
      }
    });

    it("nvidia type is nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "nvidia") {
        expect(gpu.nimCapable).toBe(true);
      }
    });

    it("apple type is not nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "apple") {
        expect(gpu.nimCapable).toBe(false);
        expect(gpu.name).toBeTruthy();
      }
    });

    it("detects GB10 unified-memory GPUs as Spark-capable NVIDIA devices", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
        if (cmdStr.includes("memory.total")) return "";
        if (cmdStr.includes("query-gpu=name")) return "NVIDIA GB10";
        if (cmdStr.includes("free") && cmdStr.includes("-m")) return "              total        used        free      shared  buff/cache   available\nMem:         131072       10240       90000        1024       30832      119808\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA GB10",
          count: 1,
          totalMemoryMB: 131072,
          perGpuMB: 131072,
          nimCapable: true,
          unifiedMemory: true,
          spark: true,
        });
      } finally {
        restore();
      }
    });

    it("detects Orin unified-memory GPUs without marking them as Spark", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
        if (cmdStr.includes("memory.total")) return "";
        if (cmdStr.includes("query-gpu=name")) return "NVIDIA Jetson AGX Orin";
        if (cmdStr.includes("free") && cmdStr.includes("-m")) return "              total        used        free      shared  buff/cache   available\nMem:          32768        5120       20000         512       7148       27136\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA Jetson AGX Orin",
          count: 1,
          totalMemoryMB: 32768,
          perGpuMB: 32768,
          nimCapable: true,
          unifiedMemory: true,
          spark: false,
        });
      } finally {
        restore();
      }
    });

    it("marks low-memory unified-memory NVIDIA devices as not NIM-capable", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
        if (cmdStr.includes("memory.total")) return "";
        if (cmdStr.includes("query-gpu=name")) return "NVIDIA Xavier";
        if (cmdStr.includes("free") && cmdStr.includes("-m")) return "              total        used        free      shared  buff/cache   available\nMem:           4096        1024        2048         256       1024        2816\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA Xavier",
          totalMemoryMB: 4096,
          nimCapable: false,
          unifiedMemory: true,
          spark: false,
        });
      } finally {
        restore();
      }
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      expect(st.running).toBe(false);
    });
  });

  describe("nimStatusByName", () => {
    /** Normalize a mock command arg (string or argv array) to a joined string for matching. */
    function cmdStr(cmd: string | string[]): string {
      return Array.isArray(cmd) ? cmd.join(" ") : cmd;
    }

    it("uses provided port directly", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        const s = cmdStr(cmd);
        if (s.includes("docker") && s.includes("inspect")) return "running";
        if (s.includes("http://localhost:9000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo", 9000);
        const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => cmdStr(c));

        expect(st).toMatchObject({
          running: true,
          healthy: true,
          container: "foo",
          state: "running",
        });
        expect(commands.some((c: string) => c.includes("docker port"))).toBe(false);
        expect(commands.some((c: string) => c.includes("http://localhost:9000/v1/models"))).toBe(
          true,
        );
      } finally {
        restore();
      }
    });

    it("uses published docker port when no port is provided", () => {
      for (const mapping of ["0.0.0.0:9000", "127.0.0.1:9000", "[::]:9000", ":::9000"]) {
        const runCapture = vi.fn((cmd: string | string[]) => {
          const s = cmdStr(cmd);
          if (s.includes("docker") && s.includes("inspect")) return "running";
          if (s.includes("docker") && s.includes("port")) return mapping;
          if (s.includes("http://localhost:9000/v1/models")) return '{"data":[]}';
          return "";
        });
        const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

        try {
          const st = nimModule.nimStatusByName("foo");
          const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => cmdStr(c));

          expect(st).toMatchObject({ running: true, healthy: true, container: "foo", state: "running" });
          expect(commands.some((c: string) => c.includes("docker port"))).toBe(true);
        } finally {
          restore();
        }
      }
    });

    it("falls back to 8000 when docker port lookup fails", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        const s = cmdStr(cmd);
        if (s.includes("docker") && s.includes("inspect")) return "running";
        if (s.includes("docker") && s.includes("port")) return "";
        if (s.includes("http://localhost:8000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        expect(st).toMatchObject({ running: true, healthy: true, container: "foo", state: "running" });
      } finally {
        restore();
      }
    });

    it("does not run health check when container is not running", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        const s = cmdStr(cmd);
        if (s.includes("docker") && s.includes("inspect")) return "exited";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        expect(st).toMatchObject({ running: false, healthy: false, container: "foo", state: "exited" });
        expect(runCapture.mock.calls).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });
});
