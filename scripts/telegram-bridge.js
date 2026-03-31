#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram → NemoClaw bridge.
 *
 * Messages from Telegram are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Telegram.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: nemoclaw)
 *   ALLOWED_CHAT_IDS    — comma-separated Telegram chat IDs to accept (optional, accepts all if unset)
 */

const https = require("https");
const fs = require("fs");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { validateName } = require("../bin/lib/runner");

// Maximum message length (matches Telegram's limit)
const MAX_MESSAGE_LENGTH = 4096;

// Configuration - validated at startup when running as main module
let OPENSHELL = null;
let TOKEN = null;
let API_KEY = null;
let SANDBOX = null;
let ALLOWED_CHATS = null;

/**
 * Initialize configuration from environment variables.
 * Called automatically when running as main module.
 * Can be called manually for testing with custom values.
 */
function initConfig(options = {}) {
  OPENSHELL = options.openshell || resolveOpenshell();
  if (!OPENSHELL) {
    console.error("openshell not found on PATH or in common locations");
    process.exit(1);
  }

  TOKEN = options.token || process.env.TELEGRAM_BOT_TOKEN;
  API_KEY = options.apiKey || process.env.NVIDIA_API_KEY;
  SANDBOX = options.sandbox || process.env.SANDBOX_NAME || "nemoclaw";

  try {
    validateName(SANDBOX, "SANDBOX_NAME");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  ALLOWED_CHATS = options.allowedChats || (process.env.ALLOWED_CHAT_IDS
    ? process.env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim())
    : null);

  if (!TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN required");
    process.exit(1);
  }
  if (!API_KEY) {
    console.error("NVIDIA_API_KEY required");
    process.exit(1);
  }
}

let offset = 0;
const activeSessions = new Map(); // chatId → message history

const COOLDOWN_MS = 5000;
const lastMessageTime = new Map();
const busyChats = new Set();

// ── Telegram API helpers ──────────────────────────────────────────

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: buf }); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chatId, text, replyTo) {
  // Telegram max message length is 4096
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyTo,
      parse_mode: "Markdown",
    }).catch(() =>
      // Retry without markdown if it fails (unbalanced formatting)
      tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo }),
    );
  }
}

async function sendTyping(chatId) {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// ── Run agent inside sandbox ──────────────────────────────────────

/**
 * Sanitize session ID to contain only alphanumeric characters and hyphens.
 * Returns null if the result is empty after sanitization.
 * @param {string|number} sessionId - The session ID to sanitize
 * @returns {string|null} - Sanitized session ID or null if empty
 */
function sanitizeSessionId(sessionId) {
  const sanitized = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Run the OpenClaw agent inside the sandbox with the given message.
 *
 * SECURITY: This function passes user messages and API credentials via stdin
 * instead of shell string interpolation to prevent command injection attacks.
 * The remote script reads the API key from the first line of stdin and the
 * message from the remaining stdin, then uses them in double-quoted variables
 * which prevents shell interpretation.
 *
 * @param {string} message - The user message to send to the agent
 * @param {string|number} sessionId - The session identifier (typically Telegram chat ID)
 * @param {object} options - Optional overrides for testing
 * @param {string} options.apiKey - Override API key (defaults to process.env.NVIDIA_API_KEY)
 * @param {string} options.sandbox - Override sandbox name (defaults to SANDBOX)
 * @param {string} options.openshell - Override openshell path (defaults to OPENSHELL)
 * @returns {Promise<string>} - The agent's response
 */
function runAgentInSandbox(message, sessionId, options = {}) {
  const apiKey = options.apiKey || API_KEY;
  const sandbox = options.sandbox || SANDBOX;
  const openshell = options.openshell || OPENSHELL;

  return new Promise((resolve) => {
    // Sanitize session ID - reject if empty after sanitization
    const safeSessionId = sanitizeSessionId(sessionId);
    if (!safeSessionId) {
      resolve("Error: Invalid session ID");
      return;
    }

    // Get SSH config using execFileSync (no shell interpretation)
    const sshConfig = execFileSync(openshell, ["sandbox", "ssh-config", sandbox], { encoding: "utf-8" });

    // Write temp ssh config with cryptographically unpredictable path
    // to prevent symlink race attacks (CWE-377)
    const confDir = fs.mkdtempSync("/tmp/nemoclaw-tg-ssh-");
    const confPath = `${confDir}/config`;
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });

    // SECURITY FIX: Pass API key and message via stdin instead of shell interpolation.
    // The remote script:
    // 1. Reads API key from first line of stdin
    // 2. Exports it as environment variable
    // 3. Reads message from remaining stdin
    // 4. Passes message to nemoclaw-start in double quotes (no shell expansion)
    const remoteScript = [
      "read -r NVIDIA_API_KEY",
      "export NVIDIA_API_KEY",
      "MSG=$(cat)",
      `exec nemoclaw-start openclaw agent --agent main --local -m "$MSG" --session-id "tg-${safeSessionId}"`,
    ].join(" && ");

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${sandbox}`, remoteScript], {
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"], // Enable stdin
    });

    // Write API key (first line) and message (remaining) to stdin
    proc.stdin.write(apiKey + "\n");
    proc.stdin.write(message);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      // Clean up temp files
      try {
        fs.unlinkSync(confPath);
        fs.rmdirSync(confDir);
      } catch { /* ignored */ }

      // Extract the actual agent response — skip setup lines
      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      // Clean up temp files on error
      try {
        fs.unlinkSync(confPath);
        fs.rmdirSync(confDir);
      } catch { /* ignored */ }
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Poll loop ─────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await tgApi("getUpdates", { offset, timeout: 30 });

    if (res.ok && res.result?.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        // Access control
        if (ALLOWED_CHATS && !ALLOWED_CHATS.includes(chatId)) {
          console.log(`[ignored] chat ${chatId} not in allowed list`);
          continue;
        }

        const userName = msg.from?.first_name || "someone";
        console.log(`[${chatId}] ${userName}: ${msg.text}`);

        // Handle /start
        if (msg.text === "/start") {
          await sendMessage(
            chatId,
            "🦀 *NemoClaw* — powered by Nemotron 3 Super 120B\n\n" +
              "Send me a message and I'll run it through the OpenClaw agent " +
              "inside an OpenShell sandbox.\n\n" +
              "If the agent needs external access, the TUI will prompt for approval.",
            msg.message_id,
          );
          continue;
        }

        // Handle /reset
        if (msg.text === "/reset") {
          activeSessions.delete(chatId);
          await sendMessage(chatId, "Session reset.", msg.message_id);
          continue;
        }

        // Message length validation
        if (msg.text.length > MAX_MESSAGE_LENGTH) {
          await sendMessage(
            chatId,
            `Message too long (${msg.text.length} chars). Maximum is ${MAX_MESSAGE_LENGTH} characters.`,
            msg.message_id,
          );
          continue;
        }

        // Rate limiting: per-chat cooldown
        const now = Date.now();
        const lastTime = lastMessageTime.get(chatId) || 0;
        if (now - lastTime < COOLDOWN_MS) {
          const wait = Math.ceil((COOLDOWN_MS - (now - lastTime)) / 1000);
          await sendMessage(chatId, `Please wait ${wait}s before sending another message.`, msg.message_id);
          continue;
        }

        // Per-chat serialization: reject if this chat already has an active session
        if (busyChats.has(chatId)) {
          await sendMessage(chatId, "Still processing your previous message.", msg.message_id);
          continue;
        }

        lastMessageTime.set(chatId, now);
        busyChats.add(chatId);

        // Send typing indicator
        await sendTyping(chatId);

        // Keep a typing indicator going while agent runs
        const typingInterval = setInterval(() => sendTyping(chatId), 4000);

        try {
          const response = await runAgentInSandbox(msg.text, chatId);
          clearInterval(typingInterval);
          console.log(`[${chatId}] agent: ${response.slice(0, 100)}...`);
          await sendMessage(chatId, response, msg.message_id);
        } catch (err) {
          clearInterval(typingInterval);
          await sendMessage(chatId, `Error: ${err.message}`, msg.message_id);
        } finally {
          busyChats.delete(chatId);
        }
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  // Continue polling (1s floor prevents tight-loop resource waste)
  setTimeout(poll, 1000);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  // Initialize configuration from environment
  initConfig();

  const me = await tgApi("getMe", {});
  if (!me.ok) {
    console.error("Failed to connect to Telegram:", JSON.stringify(me));
    process.exit(1);
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Telegram Bridge                          │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${(me.result.username + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  poll();
}

// Only run main() if this is the entry point (not imported for testing)
if (require.main === module) {
  main();
}

// Export for testing
module.exports = {
  runAgentInSandbox,
  sanitizeSessionId,
  initConfig,
  MAX_MESSAGE_LENGTH,
};
