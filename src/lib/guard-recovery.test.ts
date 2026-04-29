// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./docker/exec", () => ({
  dockerExecFileSync: vi.fn(),
}));

vi.mock("./openshell-timeouts", () => ({
  OPENSHELL_OPERATION_TIMEOUT_MS: 30_000,
}));

import { checkGuardsPresent, reEmitGuards } from "./guard-recovery";
import { dockerExecFileSync } from "./docker/exec";

const mockDockerExec = vi.mocked(dockerExecFileSync);

describe("guard-recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("checkGuardsPresent", () => {
    it("returns true when guards are present", () => {
      mockDockerExec.mockReturnValue("GUARDS_OK\n");
      expect(checkGuardsPresent("my-sandbox")).toBe(true);
    });

    it("returns false when guards are missing", () => {
      mockDockerExec.mockReturnValue("GUARDS_MISSING\n");
      expect(checkGuardsPresent("my-sandbox")).toBe(false);
    });

    it("returns null when kubectl exec fails", () => {
      mockDockerExec.mockImplementation(() => {
        throw new Error("container not running");
      });
      expect(checkGuardsPresent("my-sandbox")).toBeNull();
    });

    it("returns null for unexpected output", () => {
      mockDockerExec.mockReturnValue("some garbage output");
      expect(checkGuardsPresent("my-sandbox")).toBeNull();
    });

    it("constructs the correct kubectl exec command", () => {
      mockDockerExec.mockReturnValue("GUARDS_OK");
      checkGuardsPresent("test-sandbox");

      expect(mockDockerExec).toHaveBeenCalledWith(
        expect.arrayContaining([
          "exec",
          "openshell-cluster-nemoclaw",
          "kubectl",
          "exec",
          "-n",
          "openshell",
          "test-sandbox",
          "-c",
          "agent",
          "--",
          "sh",
          "-c",
          expect.stringContaining("nemoclaw-proxy-env.sh"),
        ]),
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it("checks for both proxy-env.sh and ciao-network-guard.js", () => {
      mockDockerExec.mockReturnValue("GUARDS_OK");
      checkGuardsPresent("test-sandbox");

      const args = mockDockerExec.mock.calls[0][0] as string[];
      const shCommand = args[args.length - 1];
      expect(shCommand).toContain("nemoclaw-proxy-env.sh");
      expect(shCommand).toContain("nemoclaw-ciao-network-guard.js");
    });
  });

  describe("reEmitGuards", () => {
    it("returns true when emit-guards.sh succeeds", () => {
      mockDockerExec.mockReturnValue("[emit-guards] Guard chain installed successfully\n");
      expect(reEmitGuards("my-sandbox")).toBe(true);
    });

    it("returns false when emit-guards.sh fails", () => {
      mockDockerExec.mockImplementation(() => {
        throw new Error("exec failed");
      });
      expect(reEmitGuards("my-sandbox")).toBe(false);
    });

    it("returns false when output doesn't contain success marker", () => {
      mockDockerExec.mockReturnValue("some error output\n");
      expect(reEmitGuards("my-sandbox")).toBe(false);
    });

    it("calls emit-guards.sh at the expected path", () => {
      mockDockerExec.mockReturnValue("[emit-guards] Guard chain installed successfully");
      reEmitGuards("test-sandbox");

      expect(mockDockerExec).toHaveBeenCalledWith(
        [
          "exec",
          "openshell-cluster-nemoclaw",
          "kubectl",
          "exec",
          "-n",
          "openshell",
          "test-sandbox",
          "-c",
          "agent",
          "--",
          "/usr/local/lib/nemoclaw/emit-guards.sh",
        ],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });
  });
});
