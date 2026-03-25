// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Brev E2E test suite — supports both warm pool and ephemeral modes.
 *
 * Warm pool mode (WARM_INSTANCE set):
 *   Instance already exists and code is deployed. Skips create + bootstrap.
 *   Just verifies connectivity and runs the test suite.
 *
 * Ephemeral mode (WARM_INSTANCE not set):
 *   Creates a fresh Brev instance, bootstraps it, runs tests, tears it down.
 *   This is the original PR #813 flow, kept as fallback.
 *
 * Invoked from CI via:
 *   npx vitest run --project e2e-brev
 *
 * Required env vars:
 *   BREV_API_TOKEN   — Brev refresh token for headless auth
 *   NVIDIA_API_KEY   — passed to VM for inference config during onboarding
 *   GITHUB_TOKEN     — passed to VM for OpenShell binary download
 *   INSTANCE_NAME    — Brev instance name (e.g. pr-156-test or e2e-warm-1234-001)
 *
 * Optional env vars:
 *   WARM_INSTANCE       — if set, use warm pool mode (skip create/bootstrap)
 *   TEST_SUITE          — which test to run: full, telegram-injection, credential-sanitization, all
 *   BREV_INSTANCE_TYPE  — instance type for ephemeral mode (default: n2d-standard-4)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const BREV_INSTANCE_TYPE = process.env.BREV_INSTANCE_TYPE || "n2d-standard-4";
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const WARM_INSTANCE = process.env.WARM_INSTANCE;
const TEST_SUITE = process.env.TEST_SUITE || "full";
const REPO_DIR = path.resolve(import.meta.dirname, "../..");

let remoteDir;
let instanceCreated = false;

// --- helpers ----------------------------------------------------------------

function brev(...args) {
  return execFileSync("brev", args, {
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** The effective instance name — warm pool instance or ephemeral name. */
const effectiveName = WARM_INSTANCE || INSTANCE_NAME;

function ssh(cmd, { timeout = 120_000 } = {}) {
  const escaped = cmd.replace(/'/g, "'\\''");
  return execSync(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "${effectiveName}" '${escaped}'`,
    { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

function shellEscape(value) {
  return value.replace(/'/g, "'\\''");
}

/** Run a command on the remote VM with secrets passed via stdin (not CLI args). */
function sshWithSecrets(cmd, { timeout = 600_000 } = {}) {
  const secretPreamble = [
    `export NVIDIA_API_KEY='${shellEscape(process.env.NVIDIA_API_KEY)}'`,
    `export GITHUB_TOKEN='${shellEscape(process.env.GITHUB_TOKEN)}'`,
    `export NEMOCLAW_NON_INTERACTIVE=1`,
    `export NEMOCLAW_SANDBOX_NAME=e2e-test`,
  ].join("\n");

  return execSync(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "${effectiveName}" 'eval "$(cat)" && ${cmd.replace(/'/g, "'\\''")}'`,
    {
      encoding: "utf-8",
      timeout,
      input: secretPreamble,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
}

function waitForSsh(maxAttempts = 60, intervalMs = 5_000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      ssh("echo ok", { timeout: 10_000 });
      return;
    } catch {
      if (i === maxAttempts) throw new Error(`SSH not ready after ${maxAttempts} attempts`);
      if (i % 5 === 0) {
        try { brev("refresh"); } catch { /* ignore */ }
      }
      execSync(`sleep ${intervalMs / 1000}`);
    }
  }
}

function runRemoteTest(scriptPath) {
  const cmd = [
    `cd ${remoteDir}`,
    `export npm_config_prefix=$HOME/.local`,
    `export PATH=$HOME/.local/bin:$PATH`,
    `bash ${scriptPath}`,
  ].join(" && ");

  return sshWithSecrets(cmd, { timeout: 600_000 });
}

// --- suite ------------------------------------------------------------------

const REQUIRED_VARS = ["BREV_API_TOKEN", "NVIDIA_API_KEY", "GITHUB_TOKEN", "INSTANCE_NAME"];
const hasRequiredVars = REQUIRED_VARS.every((key) => process.env[key]);

describe.runIf(hasRequiredVars)("Brev E2E", () => {
  beforeAll(() => {
    // Authenticate with Brev
    mkdirSync(path.join(homedir(), ".brev"), { recursive: true });
    writeFileSync(
      path.join(homedir(), ".brev", "onboarding_step.json"),
      '{"step":1,"hasRunBrevShell":true,"hasRunBrevOpen":true}',
    );
    brev("login", "--token", process.env.BREV_API_TOKEN);

    if (WARM_INSTANCE) {
      // ── Warm pool mode ──────────────────────────────────────────────
      // Instance already exists and code is deployed by the workflow's
      // "Deploy code to warm instance" step. Just verify connectivity.
      console.log(`\n  Warm pool mode: using pre-built instance "${WARM_INSTANCE}"`);
      try { brev("refresh"); } catch { /* ignore */ }
      waitForSsh(12, 5_000); // 1 min max — should already be reachable
      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/nemoclaw`;
      console.log(`  Remote dir: ${remoteDir}`);
    } else {
      // ── Ephemeral mode (fallback) ───────────────────────────────────
      // Create instance from scratch — the original PR #813 flow.
      console.log(`\n  Ephemeral mode: creating instance "${INSTANCE_NAME}"`);
      brev("create", INSTANCE_NAME, "--type", BREV_INSTANCE_TYPE, "--detached");
      instanceCreated = true;

      try { brev("refresh"); } catch { /* ignore */ }
      waitForSsh();

      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/nemoclaw`;
      ssh(`mkdir -p ${remoteDir}`);
      execSync(
        `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv "${REPO_DIR}/" "${effectiveName}:${remoteDir}/"`,
        { encoding: "utf-8", timeout: 120_000 },
      );

      // Bootstrap VM
      sshWithSecrets(`cd ${remoteDir} && bash scripts/brev-setup.sh`, { timeout: 900_000 });
    }
  }, 1_200_000); // 20 min — instance creation + bootstrap can be slow

  afterAll(() => {
    // In warm pool mode, the workflow handles cleanup (brev delete).
    // In ephemeral mode, we clean up unless KEEP_ALIVE is set.
    if (WARM_INSTANCE) {
      console.log(`\n  Warm pool mode — workflow will handle instance cleanup.`);
      return;
    }

    if (!instanceCreated) return;
    if (process.env.KEEP_ALIVE === "true") {
      console.log(`\n  Instance "${effectiveName}" kept alive for debugging.`);
      console.log(`  To connect: brev refresh && ssh ${effectiveName}`);
      console.log(`  To delete:  brev delete ${effectiveName}\n`);
      return;
    }
    try {
      brev("delete", effectiveName);
    } catch {
      // Best-effort cleanup — instance may already be gone
    }
  });

  it.runIf(TEST_SUITE === "full" || TEST_SUITE === "all")(
    "full E2E suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-full-e2e.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );

  it.runIf(TEST_SUITE === "telegram-injection" || TEST_SUITE === "all")(
    "telegram injection suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-telegram-injection.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );

  it.runIf(TEST_SUITE === "credential-sanitization" || TEST_SUITE === "all")(
    "credential sanitization suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-credential-sanitization.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );
});
