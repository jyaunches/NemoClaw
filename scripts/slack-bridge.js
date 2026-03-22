#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slack → NemoClaw bridge.
 *
 * Messages from Slack are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Slack.
 *
 * Env:
 *   SLACK_BOT_TOKEN       — Bot User OAuth Token (xoxb-...)
 *   SLACK_APP_TOKEN       — App-Level Token (xapp-...) for Socket Mode
 *   NVIDIA_API_KEY        — for inference
 *   SANDBOX_NAME          — sandbox name (default: nemoclaw)
 *   ALLOWED_CHANNEL_IDS   — comma-separated Slack channel IDs to accept (optional, accepts all if unset)
 */

const { App } = require("@slack/bolt");
const { runAgentInSandbox, SANDBOX } = require("./bridge-core");

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
if (!BOT_TOKEN) { console.error("SLACK_BOT_TOKEN required"); process.exit(1); }
if (!APP_TOKEN) { console.error("SLACK_APP_TOKEN required (xapp-... for Socket Mode)"); process.exit(1); }

const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNEL_IDS
  ? process.env.ALLOWED_CHANNEL_IDS.split(",").map((s) => s.trim())
  : null;

// ── Slack app setup (Socket Mode) ─────────────────────────────────

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
});

// ── Message handling ──────────────────────────────────────────────

app.message(async ({ message, say }) => {
  // Ignore bot messages, edits, and thread broadcasts
  if (message.subtype) return;
  if (!message.text) return;

  const channelId = message.channel;
  if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(channelId)) return;

  const userName = message.user || "someone";
  console.log(`[${channelId}] ${userName}: ${message.text}`);

  try {
    const response = await runAgentInSandbox(message.text, `sl-${channelId}`);
    console.log(`[${channelId}] agent: ${response.slice(0, 100)}...`);

    // Slack max message length is 40000 but keep chunks readable
    const chunks = [];
    for (let i = 0; i < response.length; i += 3000) {
      chunks.push(response.slice(i, i + 3000));
    }
    for (const chunk of chunks) {
      await say({ text: chunk, thread_ts: message.ts });
    }
  } catch (err) {
    await say({ text: `Error: ${err.message}`, thread_ts: message.ts }).catch(() => {});
  }
});

// ── Main ──────────────────────────────────────────────────────────

(async () => {
  await app.start();

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Slack Bridge                              │");
  console.log("  │                                                     │");
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
})();
