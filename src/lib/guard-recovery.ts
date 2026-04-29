// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard chain recovery — re-emits NODE_OPTIONS preload guard files into /tmp
 * when they are missing after a pod recreate.
 *
 * Uses kubectl exec (via docker exec) to run /usr/local/lib/nemoclaw/emit-guards.sh
 * as root inside the sandbox container, bypassing Landlock. This is the same
 * mechanism used by shields.ts and sandbox-config.ts for privileged operations.
 *
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/2701
 */

import { dockerExecFileSync } from "./docker/exec";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./openshell-timeouts";

const K3S_CONTAINER = "openshell-cluster-nemoclaw";
const EMIT_GUARDS_PATH = "/usr/local/lib/nemoclaw/emit-guards.sh";

/**
 * Check whether the critical guard files exist inside the sandbox.
 * Returns true if the minimum required guards are present, false if missing.
 * Returns null if the check itself failed (sandbox unreachable).
 */
export function checkGuardsPresent(sandboxName: string): boolean | null {
  try {
    const result = dockerExecFileSync(
      [
        "exec",
        K3S_CONTAINER,
        "kubectl",
        "exec",
        "-n",
        "openshell",
        sandboxName,
        "-c",
        "agent",
        "--",
        "sh",
        "-c",
        // Check for the two most critical files:
        // - proxy-env.sh (the aggregator that sources all guards via NODE_OPTIONS)
        // - ciao-network-guard.js (prevents the specific crash in #2701)
        "test -f /tmp/nemoclaw-proxy-env.sh && test -f /tmp/nemoclaw-ciao-network-guard.js && echo GUARDS_OK || echo GUARDS_MISSING",
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: OPENSHELL_OPERATION_TIMEOUT_MS },
    );
    if (result.trim() === "GUARDS_OK") return true;
    if (result.trim() === "GUARDS_MISSING") return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Re-emit all guard files by running emit-guards.sh inside the sandbox as root.
 * Uses kubectl exec (bypasses Landlock) to write root:root 444 files.
 *
 * Returns true if re-emission succeeded, false otherwise.
 */
export function reEmitGuards(sandboxName: string): boolean {
  try {
    const result = dockerExecFileSync(
      [
        "exec",
        K3S_CONTAINER,
        "kubectl",
        "exec",
        "-n",
        "openshell",
        sandboxName,
        "-c",
        "agent",
        "--",
        EMIT_GUARDS_PATH,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: OPENSHELL_OPERATION_TIMEOUT_MS },
    );
    return result.includes("Guard chain installed successfully");
  } catch {
    return false;
  }
}
