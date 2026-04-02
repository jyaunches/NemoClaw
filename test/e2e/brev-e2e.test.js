// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ephemeral Brev E2E test suite.
 *
 * Creates a fresh Brev instance (via launchable or bare CPU), bootstraps it,
 * runs E2E tests remotely, then tears it down.
 *
 * Intended to be run from CI via:
 *   npx vitest run --project e2e-brev
 *
 * Required env vars:
 *   BREV_API_TOKEN   — Brev refresh token for headless auth
 *   NVIDIA_API_KEY   — passed to VM for inference config during onboarding
 *   GITHUB_TOKEN     — passed to VM for OpenShell binary download
 *   INSTANCE_NAME    — Brev instance name (e.g. pr-156-test)
 *
 * Optional env vars:
 *   TEST_SUITE             — which test to run: full (default), credential-sanitization, telegram-injection, all
 *   USE_LAUNCHABLE         — "1" (default) to use CI launchable, "0" for bare brev create + brev-setup.sh
 *   LAUNCHABLE_SETUP_SCRIPT — URL to setup script for launchable path (default: brev-launchable-ci-cpu.sh on main)
 *   BREV_MIN_VCPU          — Minimum vCPUs for CPU instance (default: 4)
 *   BREV_MIN_RAM           — Minimum RAM in GB for CPU instance (default: 16)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Instance configuration
const BREV_MIN_VCPU = parseInt(process.env.BREV_MIN_VCPU || "4", 10);
const BREV_MIN_RAM = parseInt(process.env.BREV_MIN_RAM || "16", 10);
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const TEST_SUITE = process.env.TEST_SUITE || "full";
const REPO_DIR = path.resolve(import.meta.dirname, "../..");

// Launchable configuration
// CI-Ready CPU setup script: pre-bakes Docker, Node.js, OpenShell CLI, npm deps, Docker images.
// The Brev CLI (v0.6.322+) uses `brev search cpu | brev create --startup-script @file`.
// Override via LAUNCHABLE_SETUP_SCRIPT env var (e.g. to test a branch version of the script).
const DEFAULT_SETUP_SCRIPT_URL =
  process.env.LAUNCHABLE_SETUP_SCRIPT ||
  "https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/brev-launchable-ci-cpu.sh";
const USE_LAUNCHABLE = !["0", "false"].includes(process.env.USE_LAUNCHABLE?.toLowerCase());

// Sentinel file written by brev-launchable-ci-cpu.sh when setup is complete.
// More reliable than grepping log files.
const LAUNCHABLE_SENTINEL = "/var/run/nemoclaw-launchable-ready";

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

function ssh(cmd, { timeout = 120_000, stream = false } = {}) {
  const escaped = cmd.replace(/'/g, "'\\''");
  /** @type {import("child_process").StdioOptions} */
  const stdio = stream ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"];
  const result = execSync(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "${INSTANCE_NAME}" '${escaped}'`,
    { encoding: "utf-8", timeout, stdio },
  );
  return stream ? "" : result.trim();
}

/**
 * Escape a value for safe inclusion in a single-quoted shell string.
 * Replaces single quotes with the shell-safe sequence: '\''
 */
function shellEscape(value) {
  return String(value).replace(/'/g, "'\\''");
}

/** Run a command on the remote VM with env vars set for NemoClaw. */
function sshEnv(cmd, { timeout = 600_000, stream = false } = {}) {
  const envPrefix = [
    `export NVIDIA_API_KEY='${shellEscape(process.env.NVIDIA_API_KEY)}'`,
    `export GITHUB_TOKEN='${shellEscape(process.env.GITHUB_TOKEN)}'`,
    `export NEMOCLAW_NON_INTERACTIVE=1`,
    `export NEMOCLAW_SANDBOX_NAME=e2e-test`,
  ].join(" && ");

  return ssh(`${envPrefix} && ${cmd}`, { timeout, stream });
}

function waitForSsh(maxAttempts = 90, intervalMs = 5_000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      ssh("echo ok", { timeout: 10_000 });
      return;
    } catch {
      if (i === maxAttempts) throw new Error(`SSH not ready after ${maxAttempts} attempts`);
      if (i % 5 === 0) {
        try {
          brev("refresh");
        } catch {
          /* ignore */
        }
      }
      execSync(`sleep ${intervalMs / 1000}`);
    }
  }
}

/**
 * Wait for the launchable setup script to finish by checking a sentinel file.
 * Much more reliable than grepping log files.
 */
function waitForLaunchableReady(maxWaitMs = 1_200_000, pollIntervalMs = 15_000) {
  const start = Date.now();
  const elapsed = () => `${Math.round((Date.now() - start) / 1000)}s`;

  while (Date.now() - start < maxWaitMs) {
    try {
      const result = ssh(`test -f ${LAUNCHABLE_SENTINEL} && echo READY || echo PENDING`, {
        timeout: 15_000,
      });
      if (result.includes("READY")) {
        console.log(`[${elapsed()}] Launchable setup complete (sentinel file found)`);
        return;
      }
      // Show progress from the setup log
      try {
        const tail = ssh("tail -2 /tmp/launch-plugin.log 2>/dev/null || echo '(no log yet)'", {
          timeout: 10_000,
        });
        console.log(`[${elapsed()}] Setup still running... ${tail.replace(/\n/g, " | ")}`);
      } catch {
        /* ignore */
      }
    } catch {
      console.log(`[${elapsed()}] Setup poll: SSH command failed, retrying...`);
    }
    execSync(`sleep ${pollIntervalMs / 1000}`);
  }

  throw new Error(
    `Launchable setup did not complete within ${maxWaitMs / 60_000} minutes. ` +
      `Sentinel file ${LAUNCHABLE_SENTINEL} not found.`,
  );
}

function runRemoteTest(scriptPath) {
  const cmd = [
    `set -o pipefail`,
    `source ~/.nvm/nvm.sh 2>/dev/null || true`,
    `cd ${remoteDir}`,
    `export npm_config_prefix=$HOME/.local`,
    `export PATH=$HOME/.local/bin:$PATH`,
    `bash ${scriptPath} 2>&1 | tee /tmp/test-output.log`,
  ].join(" && ");

  // Stream test output to CI log AND capture it for assertions
  sshEnv(cmd, { timeout: 900_000, stream: true });
  // Retrieve the captured output for assertion checking
  return ssh("cat /tmp/test-output.log", { timeout: 30_000 });
}

// --- suite ------------------------------------------------------------------

const REQUIRED_VARS = ["BREV_API_TOKEN", "NVIDIA_API_KEY", "GITHUB_TOKEN", "INSTANCE_NAME"];
const hasRequiredVars = REQUIRED_VARS.every((key) => process.env[key]);

describe.runIf(hasRequiredVars)("Brev E2E", () => {
  beforeAll(() => {
    const bootstrapStart = Date.now();
    const elapsed = () => `${Math.round((Date.now() - bootstrapStart) / 1000)}s`;

    // Authenticate with Brev
    mkdirSync(path.join(homedir(), ".brev"), { recursive: true });
    writeFileSync(
      path.join(homedir(), ".brev", "onboarding_step.json"),
      '{"step":1,"hasRunBrevShell":true,"hasRunBrevOpen":true}',
    );
    brev("login", "--token", process.env.BREV_API_TOKEN);

    // Pre-cleanup: delete any leftover instance with the same name.
    // This can happen when a previous run's create succeeded on the backend
    // but the CLI got a network error (unexpected EOF) before confirming,
    // then the retry/fallback fails with "duplicate workspace".
    try {
      brev("delete", INSTANCE_NAME);
      console.log(`[${elapsed()}] Deleted leftover instance "${INSTANCE_NAME}"`);
    } catch {
      // Expected — no leftover instance exists
    }

    if (USE_LAUNCHABLE) {
      // ── Launchable path: pre-baked CI environment ──────────────────
      // Uses brev search cpu | brev create with --startup-script.
      // The script pre-installs Docker, Node.js, OpenShell CLI, npm deps,
      // and pre-pulls Docker images. We just need to rsync branch code and
      // run onboard.
      //
      // brev create (v0.6.322+) accepts --startup-script as a string or
      // @filepath — not a URL. So we download the script first.
      console.log(
        `[${elapsed()}] Creating instance via launchable (brev search cpu | brev create + startup-script)...`,
      );
      console.log(`[${elapsed()}]   setup-script: ${DEFAULT_SETUP_SCRIPT_URL}`);
      console.log(`[${elapsed()}]   cpu: min ${BREV_MIN_VCPU} vCPU, ${BREV_MIN_RAM} GB RAM`);

      // Download the setup script to a temp file
      const setupScriptPath = "/tmp/brev-ci-setup.sh";
      execSync(`curl -fsSL -o ${setupScriptPath} "${DEFAULT_SETUP_SCRIPT_URL}"`, {
        encoding: "utf-8",
        timeout: 30_000,
      });
      console.log(`[${elapsed()}] Setup script downloaded to ${setupScriptPath}`);

      // brev search cpu | brev create: finds cheapest CPU instance matching
      // our specs and creates it with the setup script attached.
      //
      // The Brev API sometimes returns "unexpected EOF" after the instance
      // is actually created server-side. The CLI then falls back to the next
      // instance type, which fails with "duplicate workspace". To handle this,
      // we catch create failures and check if the instance exists anyway.
      try {
        execSync(
          `brev search cpu --min-vcpu ${BREV_MIN_VCPU} --min-ram ${BREV_MIN_RAM} --sort price | ` +
            `brev create ${INSTANCE_NAME} --startup-script @${setupScriptPath} --detached`,
          { encoding: "utf-8", timeout: 180_000, stdio: ["pipe", "inherit", "inherit"] },
        );
      } catch (createErr) {
        console.log(
          `[${elapsed()}] brev create exited with error — checking if instance was created anyway...`,
        );
        try {
          brev("refresh");
        } catch {
          /* ignore */
        }
        const lsOutput = execSync(`brev ls 2>&1 || true`, { encoding: "utf-8", timeout: 30_000 });
        if (!lsOutput.includes(INSTANCE_NAME)) {
          throw new Error(
            `brev create failed and instance "${INSTANCE_NAME}" not found in brev ls. ` +
              `Original error: ${createErr.message}`,
            { cause: createErr },
          );
        }
        console.log(
          `[${elapsed()}] Instance "${INSTANCE_NAME}" found in brev ls despite create error — proceeding`,
        );
      }
      instanceCreated = true;
      console.log(`[${elapsed()}] brev create returned (instance provisioning in background)`);

      // Wait for SSH
      try {
        brev("refresh");
      } catch {
        /* ignore */
      }
      waitForSsh();
      console.log(`[${elapsed()}] SSH is up`);

      // Wait for launchable setup to finish (sentinel file)
      console.log(`[${elapsed()}] Waiting for launchable setup to complete...`);
      waitForLaunchableReady();

      // The launchable clones NemoClaw to ~/NemoClaw
      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/NemoClaw`;

      // Rsync PR branch code over the launchable's clone
      console.log(`[${elapsed()}] Syncing PR branch code over launchable's clone...`);
      execSync(
        `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv "${REPO_DIR}/" "${INSTANCE_NAME}:${remoteDir}/"`,
        { encoding: "utf-8", timeout: 120_000 },
      );
      console.log(`[${elapsed()}] Code synced`);

      // Re-install deps for our branch (most already cached by launchable)
      console.log(`[${elapsed()}] Running npm ci to sync dependencies...`);
      ssh(
        [
          `source ~/.nvm/nvm.sh 2>/dev/null || true`,
          `cd ${remoteDir} && npm ci --ignore-scripts 2>&1 | tail -5`,
        ].join(" && "),
        { timeout: 300_000, stream: true },
      );
      console.log(`[${elapsed()}] Dependencies synced`);

      // Rebuild TS plugin for our branch
      console.log(`[${elapsed()}] Building TypeScript plugin...`);
      ssh(`source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${remoteDir}/nemoclaw && npm run build`, {
        timeout: 120_000,
        stream: true,
      });
      console.log(`[${elapsed()}] Plugin built`);

      // Install nemoclaw CLI and run onboard
      console.log(`[${elapsed()}] Installing nemoclaw CLI + onboard...`);
      sshEnv(
        `source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${remoteDir} && npm link && nemoclaw onboard --non-interactive 2>&1`,
        { timeout: 2_400_000, stream: true },
      );
      console.log(`[${elapsed()}] nemoclaw onboard complete`);
    } else {
      // ── Bare instance path: brev create + brev-setup.sh ────────────
      // Full bootstrap from scratch. Slower but doesn't require a launchable.
      console.log(`[${elapsed()}] Creating bare CPU instance via brev search cpu | brev create...`);
      console.log(`[${elapsed()}]   min-vcpu: ${BREV_MIN_VCPU}, min-ram: ${BREV_MIN_RAM}GB`);
      try {
        execSync(
          `brev search cpu --min-vcpu ${BREV_MIN_VCPU} --min-ram ${BREV_MIN_RAM} --sort price | ` +
            `brev create ${INSTANCE_NAME} --detached`,
          { encoding: "utf-8", timeout: 180_000, stdio: ["pipe", "inherit", "inherit"] },
        );
      } catch (createErr) {
        console.log(
          `[${elapsed()}] brev create exited with error — checking if instance was created anyway...`,
        );
        try {
          brev("refresh");
        } catch {
          /* ignore */
        }
        const lsOutput = execSync(`brev ls 2>&1 || true`, { encoding: "utf-8", timeout: 30_000 });
        if (!lsOutput.includes(INSTANCE_NAME)) {
          throw new Error(
            `brev create failed and instance "${INSTANCE_NAME}" not found in brev ls. ` +
              `Original error: ${createErr.message}`,
            { cause: createErr },
          );
        }
        console.log(
          `[${elapsed()}] Instance "${INSTANCE_NAME}" found in brev ls despite create error — proceeding`,
        );
      }
      instanceCreated = true;
      console.log(`[${elapsed()}] brev create returned (instance provisioning in background)`);

      // Wait for SSH
      try {
        brev("refresh");
      } catch {
        /* ignore */
      }
      waitForSsh();
      console.log(`[${elapsed()}] SSH is up`);

      // Sync code
      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/nemoclaw`;
      ssh(`mkdir -p ${remoteDir}`);
      execSync(
        `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv "${REPO_DIR}/" "${INSTANCE_NAME}:${remoteDir}/"`,
        { encoding: "utf-8", timeout: 120_000 },
      );
      console.log(`[${elapsed()}] Code synced`);

      // Bootstrap VM — stream output to CI log so we can see progress
      console.log(`[${elapsed()}] Running brev-setup.sh (bootstrap)...`);
      sshEnv(`cd ${remoteDir} && SKIP_VLLM=1 bash scripts/brev-setup.sh`, {
        timeout: 2_400_000,
        stream: true,
      });
      console.log(`[${elapsed()}] Bootstrap complete`);

      // Verify the CLI installed by brev-setup.sh is visible
      console.log(`[${elapsed()}] Verifying nemoclaw CLI...`);
      ssh(
        [
          `export npm_config_prefix=$HOME/.local`,
          `export PATH=$HOME/.local/bin:$PATH`,
          `which nemoclaw && nemoclaw --version`,
        ].join(" && "),
        { timeout: 120_000 },
      );
      console.log(`[${elapsed()}] nemoclaw CLI verified`);
    }

    // Verify sandbox registry (common to both paths)
    console.log(`[${elapsed()}] Verifying sandbox registry...`);
    const registry = JSON.parse(ssh(`cat ~/.nemoclaw/sandboxes.json`, { timeout: 10_000 }));
    expect(registry.defaultSandbox).toBe("e2e-test");
    expect(registry.sandboxes).toHaveProperty("e2e-test");
    const sandbox = registry.sandboxes["e2e-test"];
    expect(sandbox).toMatchObject({
      name: "e2e-test",
      gpuEnabled: false,
      policies: [],
    });
    console.log(`[${elapsed()}] Sandbox registry verified`);

    console.log(`[${elapsed()}] beforeAll complete — total bootstrap time: ${elapsed()}`);
  }, 2_700_000); // 45 min

  afterAll(() => {
    if (!instanceCreated) return;
    if (process.env.KEEP_ALIVE === "true") {
      console.log(`\n  Instance "${INSTANCE_NAME}" kept alive for debugging.`);
      console.log(`  To connect: brev refresh && ssh ${INSTANCE_NAME}`);
      console.log(`  To delete:  brev delete ${INSTANCE_NAME}\n`);
      return;
    }
    try {
      brev("delete", INSTANCE_NAME);
    } catch {
      // Best-effort cleanup — instance may already be gone
    }
  });

  // NOTE: The full E2E test runs install.sh --non-interactive which destroys and
  // rebuilds the sandbox from scratch. It cannot run alongside the security tests
  // (credential-sanitization, telegram-injection) which depend on the sandbox
  // that beforeAll already created. Run it only when TEST_SUITE=full.
  it.runIf(TEST_SUITE === "full")(
    "full E2E suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-full-e2e.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    900_000,
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

  it.runIf(TEST_SUITE === "telegram-injection" || TEST_SUITE === "all")(
    "telegram bridge injection suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-telegram-injection.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );
});
