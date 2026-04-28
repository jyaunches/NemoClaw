// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ollama auth proxy lifecycle management — token persistence, PID tracking,
 * process spawning, health probing, and cleanup.
 *
 * Extracted from onboard.ts to reduce the monolith and make proxy health
 * testable in isolation (see issue #767).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OLLAMA_PORT, OLLAMA_PROXY_PORT } from "./ports";
import { sleepSeconds } from "./wait";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SCRIPTS, run, runCapture } = require("./runner");

// ── State dir paths ──────────────────────────────────────────────

const PROXY_STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const PROXY_TOKEN_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-token");
const PROXY_PID_PATH = path.join(PROXY_STATE_DIR, "ollama-auth-proxy.pid");

let ollamaProxyToken: string | null = null;

// ── Token persistence ────────────────────────────────────────────

function ensureProxyStateDir(): void {
  if (!fs.existsSync(PROXY_STATE_DIR)) {
    fs.mkdirSync(PROXY_STATE_DIR, { recursive: true });
  }
}

export function persistProxyToken(token: string): void {
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_TOKEN_PATH, token, { mode: 0o600 });
  // mode only applies on creation; ensure permissions on existing files too
  fs.chmodSync(PROXY_TOKEN_PATH, 0o600);
}

export function loadPersistedProxyToken(): string | null {
  try {
    if (fs.existsSync(PROXY_TOKEN_PATH)) {
      const token = fs.readFileSync(PROXY_TOKEN_PATH, "utf-8").trim();
      return token || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── PID persistence ──────────────────────────────────────────────

export function persistProxyPid(pid: number | null | undefined): void {
  const validPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  if (validPid === null) return;
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_PID_PATH, `${validPid}\n`, { mode: 0o600 });
  fs.chmodSync(PROXY_PID_PATH, 0o600);
}

export function loadPersistedProxyPid(): number | null {
  try {
    if (!fs.existsSync(PROXY_PID_PATH)) return null;
    const raw = fs.readFileSync(PROXY_PID_PATH, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearPersistedProxyPid(): void {
  try {
    if (fs.existsSync(PROXY_PID_PATH)) {
      fs.unlinkSync(PROXY_PID_PATH);
    }
  } catch {
    /* ignore */
  }
}

// ── Process detection ────────────────────────────────────────────

export function isOllamaProxyProcess(pid: number | null | undefined): boolean {
  const validPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  if (validPid === null) return false;
  const cmdline = runCapture(["ps", "-p", String(validPid), "-o", "args="], {
    ignoreError: true,
  });
  return Boolean(cmdline && cmdline.includes("ollama-auth-proxy.js"));
}

// ── Spawn / kill ─────────────────────────────────────────────────

export function spawnOllamaAuthProxy(token: string): number | null {
  const child = spawn(process.execPath, [path.join(SCRIPTS, "ollama-auth-proxy.js")], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(OLLAMA_PROXY_PORT),
      OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
    },
  });
  child.unref();
  persistProxyPid(child.pid);
  return child.pid ?? null;
}

export function killStaleProxy(): void {
  try {
    const persistedPid = loadPersistedProxyPid();
    if (isOllamaProxyProcess(persistedPid)) {
      run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
    }
    clearPersistedProxyPid();

    // Best-effort cleanup for older proxy processes created before the PID file
    // existed. Only kill processes that are actually the auth proxy, not
    // unrelated services that happen to use the same port.
    const pidOutput = runCapture(["lsof", "-ti", `:${OLLAMA_PROXY_PORT}`], { ignoreError: true });
    if (pidOutput && pidOutput.trim()) {
      for (const pid of pidOutput.trim().split(/\s+/)) {
        if (isOllamaProxyProcess(Number.parseInt(pid, 10))) {
          run(["kill", pid], { ignoreError: true, suppressOutput: true });
        }
      }
      sleepSeconds(1);
    }
  } catch {
    /* ignore */
  }
}

// ── High-level lifecycle ─────────────────────────────────────────

export function startOllamaAuthProxy(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto");
  killStaleProxy();

  const proxyToken = crypto.randomBytes(24).toString("hex");
  // Don't persist yet — wait until provider is confirmed in setupInference.
  // If the user backs out to a different provider, the token stays in memory
  // only and is discarded.
  const pid = spawnOllamaAuthProxy(proxyToken);
  sleepSeconds(1);
  if (!isOllamaProxyProcess(pid)) {
    console.error(`  Error: Ollama auth proxy failed to start on :${OLLAMA_PROXY_PORT}`);
    console.error(`  Containers will not be able to reach Ollama without the proxy.`);
    console.error(
      `  Check if port ${OLLAMA_PROXY_PORT} is already in use: lsof -ti :${OLLAMA_PROXY_PORT}`,
    );
    return false;
  }
  // Only set the in-memory token after confirming the proxy is alive.
  // This prevents getOllamaProxyToken() from returning a stale token
  // when the proxy failed to start.
  ollamaProxyToken = proxyToken;
  return true;
}

/**
 * Ensure the auth proxy is running — called on sandbox connect to recover
 * from host reboots where the background proxy process was lost.
 */
export function ensureOllamaAuthProxy(): void {
  // Try to load persisted token first — if none, this isn't an Ollama setup.
  const token = loadPersistedProxyToken();
  if (!token) return;

  const pid = loadPersistedProxyPid();
  if (isOllamaProxyProcess(pid)) {
    ollamaProxyToken = token;
    return;
  }

  // Proxy not running — restart it with the persisted token.
  killStaleProxy();
  ollamaProxyToken = token;
  spawnOllamaAuthProxy(token);
  sleepSeconds(1);
}

export function getOllamaProxyToken(): string | null {
  if (ollamaProxyToken) return ollamaProxyToken;
  // Fall back to persisted token (resume / reconnect scenario)
  ollamaProxyToken = loadPersistedProxyToken();
  return ollamaProxyToken;
}

// ── Proxy health probe ───────────────────────────────────────────

/**
 * Check whether the Ollama auth proxy is actually healthy — not just that
 * the PID exists, but that the proxy endpoint responds to HTTP requests.
 *
 * This is the correct check for the setupInference fallback: if the
 * container reachability test fails (Docker bridge issue) but the proxy
 * is confirmed healthy on the host, onboarding can safely continue.
 */
export function isProxyHealthy(): boolean {
  // 1. PID check — informational, but don't early-return on failure.
  //    The proxy may have been restarted with a new PID that isn't in our
  //    PID file, so the HTTP probe is the authoritative signal.
  const pid = loadPersistedProxyPid();
  const hasValidPid = isOllamaProxyProcess(pid);

  // 2. HTTP probe — confirm the proxy actually responds. This is the
  //    authoritative check: a successful probe wins even if the PID file
  //    is missing or stale (e.g., after a manual restart).
  const proxyUrl = `http://127.0.0.1:${OLLAMA_PROXY_PORT}/api/tags`;
  const token = loadPersistedProxyToken();
  const probeCmd = token
    ? ["curl", "-sf", "--connect-timeout", "3", "--max-time", "5",
       "-H", `Authorization: Bearer ${token}`, proxyUrl]
    : ["curl", "-sf", "--connect-timeout", "3", "--max-time", "5", proxyUrl];

  const output = runCapture(probeCmd, { ignoreError: true });
  if (output) return true;

  // HTTP probe failed — fall back to PID as a weaker signal.
  // This covers edge cases where the probe transiently fails but the
  // process is confirmed alive.
  return hasValidPid;
}
