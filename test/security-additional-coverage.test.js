// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Additional security regression tests covering gaps identified during
// review of PR #584 (command injection) and PR #743 (credential sanitization).
//
// Covers:
//   Gap 1: Gateway auth token readable inside sandbox (ENV / openclaw.json)
//   Gap 2: Dockerfile ENV var persistence — no secrets in build-time ENV
//   Gap 3: CREDENTIAL_SENSITIVE_BASENAMES case-variant bypass
//   Gap 4: stripCredentials in prepareSandboxState path
//   Gap 5: Blueprint digest — v3 manifest with key deliberately deleted

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ═══════════════════════════════════════════════════════════════════
// Shared helpers — mirror production logic
// ═══════════════════════════════════════════════════════════════════

const CREDENTIAL_SENSITIVE_BASENAMES = new Set(["auth-profiles.json"]);

/**
 * Mirror of copyDirectory's filter logic from migration-state.ts:500-503.
 * Returns true if the file should be INCLUDED (i.e., is NOT a sensitive file).
 */
function credentialFilter(sourcePath) {
  return !CREDENTIAL_SENSITIVE_BASENAMES.has(path.basename(sourcePath).toLowerCase());
}

const CREDENTIAL_FIELDS = new Set([
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "resolvedKey",
]);
const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

function isCredentialField(key) {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

function stripCredentials(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] = "[STRIPPED_BY_MIGRATION]";
    } else {
      result[key] = stripCredentials(value);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Gap 1: Gateway auth token visibility
//
// The sandbox's openclaw.json contains a gateway auth token generated
// at build time. The agent CAN read it (chmod 444). This is by design
// (the agent needs it for gateway communication), but we verify the
// token is random and not a known/static value.
// ═══════════════════════════════════════════════════════════════════

describe("Gap 1: gateway auth token is random per build", () => {
  const blueprintPath = path.join(
    import.meta.dirname,
    "..",
    "nemoclaw-blueprint",
    "blueprint.yaml",
  );

  it("Dockerfile generates token via secrets.token_hex(32), not a static value", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "..", "Dockerfile"),
      "utf-8",
    );
    // The token must come from secrets.token_hex, not a hardcoded string
    expect(dockerfile).toContain("secrets.token_hex(32)");
    // There should be no hardcoded token value
    expect(dockerfile).not.toMatch(/['"]auth['"]:\s*\{['"]token['"]:\s*['"][a-f0-9]{64}['"]/);
  });

  it("openclaw.json config is locked: root-owned, read-only in Dockerfile", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "..", "Dockerfile"),
      "utf-8",
    );
    // Config should be owned by root and read-only
    expect(dockerfile).toMatch(/chown root:root \/sandbox\/\.openclaw/);
    expect(dockerfile).toMatch(/chmod 444 \/sandbox\/\.openclaw\/openclaw\.json/);
  });

  it("config integrity hash is pinned at build time", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "..", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("sha256sum /sandbox/.openclaw/openclaw.json");
    expect(dockerfile).toContain(".config-hash");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Gap 2: Dockerfile ENV var persistence
//
// Build-args promoted to ENV persist in the final image. Verify none
// of the persisted ENV values are actual secrets.
// ═══════════════════════════════════════════════════════════════════

describe("Gap 2: no secrets in Dockerfile ENV declarations", () => {
  const dockerfile = fs.readFileSync(
    path.join(import.meta.dirname, "..", "Dockerfile"),
    "utf-8",
  );

  it("NVIDIA_API_KEY is never set as an ENV var in the Dockerfile", () => {
    // ENV lines that set NVIDIA_API_KEY would bake the key into the image
    const envLines = dockerfile
      .split("\n")
      .filter((l) => /^\s*ENV\b/.test(l) || /^\s+[A-Z_]+=/.test(l));
    const apiKeyEnv = envLines.filter((l) => l.includes("NVIDIA_API_KEY"));
    expect(apiKeyEnv).toHaveLength(0);
  });

  it("no ARG with 'SECRET', 'PASSWORD', or 'KEY' contains a real value", () => {
    // ARG lines that have default values with secret-looking content
    const argLines = dockerfile.split("\n").filter((l) => /^\s*ARG\b/.test(l));
    for (const line of argLines) {
      const match = line.match(/ARG\s+(\w+)=(.*)/);
      if (!match) continue;
      const [, name, value] = match;
      // Skip known-safe names
      if (name === "NEMOCLAW_PROVIDER_KEY") continue; // value is "nvidia", not a secret
      if (/SECRET|PASSWORD|API_KEY|TOKEN/i.test(name)) {
        // The default value should be empty, a placeholder, or a non-secret
        expect(value.trim()).not.toMatch(/^nvapi-/);
        expect(value.trim()).not.toMatch(/^ghp_/);
        expect(value.trim()).not.toMatch(/^sk-/);
      }
    }
  });

  it("ENV block only contains non-secret build configuration", () => {
    // Extract all ENV var names from the Dockerfile
    const envBlock = dockerfile.match(/ENV\s+([\s\S]*?)(?=\n\S|\nUSER|\nWORKDIR|\nRUN|\nCOPY|$)/m);
    if (!envBlock) return; // No ENV block is safe

    const envVarNames = envBlock[1].match(/[A-Z_]+(?==)/g) || [];
    const knownSafe = new Set([
      "NEMOCLAW_MODEL",
      "NEMOCLAW_PROVIDER_KEY",
      "NEMOCLAW_PRIMARY_MODEL_REF",
      "CHAT_UI_URL",
      "NEMOCLAW_INFERENCE_BASE_URL",
      "NEMOCLAW_INFERENCE_API",
      "NEMOCLAW_INFERENCE_COMPAT_B64",
    ]);

    for (const name of envVarNames) {
      if (knownSafe.has(name)) continue;
      // Any new ENV var with secret-looking name should be flagged
      expect(name, `Unexpected ENV var ${name} — verify it's not a secret`).not.toMatch(
        /SECRET|PASSWORD|API_KEY|TOKEN|CREDENTIAL/i,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Gap 3: CREDENTIAL_SENSITIVE_BASENAMES case-variant bypass
//
// PR #743 added .toLowerCase() to prevent case-variant bypasses like
// Auth-Profiles.JSON or AUTH-PROFILES.json. Test that variants are
// correctly filtered.
// ═══════════════════════════════════════════════════════════════════

describe("Gap 3: case-variant bypass of credential file filter", () => {
  it("exact lowercase 'auth-profiles.json' is filtered", () => {
    expect(credentialFilter("/some/path/auth-profiles.json")).toBe(false);
  });

  it("UPPERCASE 'AUTH-PROFILES.JSON' is filtered", () => {
    expect(credentialFilter("/some/path/AUTH-PROFILES.JSON")).toBe(false);
  });

  it("mixed case 'Auth-Profiles.Json' is filtered", () => {
    expect(credentialFilter("/some/path/Auth-Profiles.Json")).toBe(false);
  });

  it("camelCase 'Auth-profiles.JSON' is filtered", () => {
    expect(credentialFilter("/some/path/Auth-profiles.JSON")).toBe(false);
  });

  it("random case 'aUtH-pRoFiLeS.jSoN' is filtered", () => {
    expect(credentialFilter("/some/path/aUtH-pRoFiLeS.jSoN")).toBe(false);
  });

  it("non-sensitive file 'config.json' is NOT filtered", () => {
    expect(credentialFilter("/some/path/config.json")).toBe(true);
  });

  it("partial match 'auth-profiles.json.bak' is NOT filtered (different basename)", () => {
    // path.basename("auth-profiles.json.bak") === "auth-profiles.json.bak"
    // which is NOT in the set, so it should pass through
    expect(credentialFilter("/some/path/auth-profiles.json.bak")).toBe(true);
  });

  it("directory named 'auth-profiles.json' is filtered by basename", () => {
    // The filter runs on every path including dirs — basename still matches
    expect(credentialFilter("/some/agents/auth-profiles.json")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Gap 4: stripCredentials applied during prepareSandboxState
//
// prepareSandboxState() is a separate code path from createSnapshotBundle.
// It copies snapshot state into the sandbox at restore time. PR #743
// added { stripCredentials: true } there too. Verify the stripping
// works on a realistic nested config with mixed credential/safe fields.
// ═══════════════════════════════════════════════════════════════════

describe("Gap 4: stripCredentials on prepareSandboxState-style config", () => {
  it("strips credentials from a realistic openclaw.json with gateway config", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "nvidia/nemotron-3-super-120b-a12b" },
          workspace: "/sandbox/.openclaw/workspace",
        },
      },
      models: {
        mode: "merge",
        providers: {
          "nvidia-nim": {
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKey: "nvapi-real-key-here",
          },
        },
      },
      gateway: {
        mode: "local",
        auth: { token: "abc123deadbeef" },
        controlUi: {
          allowInsecureAuth: true,
          dangerouslyDisableDeviceAuth: true,
        },
      },
      nvidia: {
        apiKey: "nvapi-another-real-key",
      },
    };

    const sanitized = stripCredentials(config);

    // Secrets stripped
    expect(sanitized.models.providers["nvidia-nim"].apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized.gateway.auth.token).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized.nvidia.apiKey).toBe("[STRIPPED_BY_MIGRATION]");

    // Non-secrets preserved
    expect(sanitized.agents.defaults.model.primary).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(sanitized.models.providers["nvidia-nim"].baseUrl).toBe(
      "https://integrate.api.nvidia.com/v1",
    );
    expect(sanitized.gateway.mode).toBe("local");
    expect(sanitized.gateway.controlUi.allowInsecureAuth).toBe(true);
  });

  it("strips credentials from auth-profiles.json content if it were inlined", () => {
    // Even if auth-profiles.json content somehow made it into another file,
    // the field-level stripping should catch it
    const authProfiles = {
      "nvidia:manual": {
        type: "api_key",
        provider: "nvidia",
        resolvedKey: "nvapi-leaked-key",
        profileId: "nvidia:manual",
        accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        refreshToken: "dGhpcyBpcyBhIGZha2UgcmVmcmVzaCB0b2tlbg==",
      },
      "github:pat": {
        type: "api_key",
        provider: "github",
        token: "ghp_1234567890abcdef",
      },
    };

    const sanitized = stripCredentials(authProfiles);

    expect(sanitized["nvidia:manual"].resolvedKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized["nvidia:manual"].accessToken).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized["nvidia:manual"].refreshToken).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized["github:pat"].token).toBe("[STRIPPED_BY_MIGRATION]");

    // Non-credential fields preserved
    expect(sanitized["nvidia:manual"].type).toBe("api_key");
    expect(sanitized["nvidia:manual"].provider).toBe("nvidia");
    expect(sanitized["nvidia:manual"].profileId).toBe("nvidia:manual");
  });

  it("handles deeply nested credentials in provider configs", () => {
    const config = {
      providers: {
        openai: {
          connection: {
            auth: {
              apiKey: "sk-proj-REAL-KEY",
              bearerToken: "Bearer abc123",
            },
            proxy: {
              url: "https://proxy.internal",
              clientSecret: "proxy-secret-value",
            },
          },
          model: "gpt-4",
        },
      },
    };

    const sanitized = stripCredentials(config);

    expect(sanitized.providers.openai.connection.auth.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized.providers.openai.connection.auth.bearerToken).toBe(
      "[STRIPPED_BY_MIGRATION]",
    );
    expect(sanitized.providers.openai.connection.proxy.clientSecret).toBe(
      "[STRIPPED_BY_MIGRATION]",
    );
    expect(sanitized.providers.openai.connection.proxy.url).toBe("https://proxy.internal");
    expect(sanitized.providers.openai.model).toBe("gpt-4");
  });

  it("copyDirectory with stripCredentials filters auth-profiles.json from tree", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gap4-"));
    try {
      // Build source tree
      const srcDir = path.join(workDir, "src");
      fs.mkdirSync(path.join(srcDir, "agents", "main", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, "agents", "main", "agent", "auth-profiles.json"),
        '{"secret": true}',
      );
      fs.writeFileSync(
        path.join(srcDir, "agents", "main", "agent", "config.json"),
        '{"name": "main"}',
      );
      fs.writeFileSync(path.join(srcDir, "openclaw.json"), '{"version": 1}');

      // Copy with credential filter
      const destDir = path.join(workDir, "dest");
      fs.cpSync(srcDir, destDir, {
        recursive: true,
        filter: (source) =>
          !CREDENTIAL_SENSITIVE_BASENAMES.has(path.basename(source).toLowerCase()),
      });

      // auth-profiles.json should be gone
      expect(
        fs.existsSync(path.join(destDir, "agents", "main", "agent", "auth-profiles.json")),
      ).toBe(false);

      // config.json and openclaw.json should remain
      expect(
        fs.existsSync(path.join(destDir, "agents", "main", "agent", "config.json")),
      ).toBe(true);
      expect(fs.existsSync(path.join(destDir, "openclaw.json"))).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Gap 5: Blueprint digest — v3 manifest with key deliberately deleted
//
// The fix uses `"blueprintDigest" in manifest` to decide whether to
// verify. If an attacker takes a v3 snapshot that HAS a digest and
// deletes the key from snapshot.json, verification is skipped entirely.
// This tests whether that's possible and what the impact is.
// ═══════════════════════════════════════════════════════════════════

describe("Gap 5: v3 manifest with blueprintDigest key removed", () => {
  // Simulate the production verification logic exactly
  function verifyBlueprintDigestFromManifest(manifest, blueprintContent) {
    // This mirrors migration-state.ts:792-824 (with the v3 key-deletion fix)

    // SECURITY FIX: v3+ manifests must have the blueprintDigest key when a
    // blueprint is provided for verification. Prevents key-deletion bypass.
    if (
      manifest.version >= 3 &&
      !("blueprintDigest" in manifest) &&
      blueprintContent
    ) {
      return {
        valid: false,
        reason: "v3+ manifest missing blueprintDigest — possible tampering",
      };
    }

    if ("blueprintDigest" in manifest) {
      if (!manifest.blueprintDigest || typeof manifest.blueprintDigest !== "string") {
        return { valid: false, reason: "empty or invalid blueprintDigest" };
      }
      if (!blueprintContent) {
        return { valid: false, reason: "digest present but no blueprint available" };
      }
      const computed = crypto.createHash("sha256").update(blueprintContent).digest("hex");
      if (manifest.blueprintDigest !== computed) {
        return {
          valid: false,
          reason: `digest mismatch: manifest=${manifest.blueprintDigest}, computed=${computed}`,
        };
      }
      return { valid: true };
    }
    // Key not present and either v2 or no blueprint to verify — skip
    return { valid: true, skipped: true };
  }

  it("v3 manifest WITH valid blueprintDigest passes verification", () => {
    const blueprint = "name: nemoclaw\nversion: 0.1.0\n";
    const digest = crypto.createHash("sha256").update(blueprint).digest("hex");
    const manifest = { version: 3, blueprintDigest: digest };

    const result = verifyBlueprintDigestFromManifest(manifest, blueprint);
    expect(result.valid).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("v3 manifest WITH wrong blueprintDigest fails verification", () => {
    const manifest = { version: 3, blueprintDigest: "deadbeef".repeat(8) };
    const result = verifyBlueprintDigestFromManifest(manifest, "real blueprint content");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("digest mismatch");
  });

  it("v3 manifest with blueprintDigest key DELETED is rejected when blueprint provided", () => {
    // Attack: take a v3 snapshot, delete the key, swap in a malicious blueprint.
    // The fix detects this: v3+ with missing key + blueprintPath = reject.
    const manifest = { version: 3, blueprintDigest: "deadbeef".repeat(8) };
    delete manifest.blueprintDigest;

    const result = verifyBlueprintDigestFromManifest(manifest, "tampered blueprint");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("missing blueprintDigest");
  });

  it("v3 manifest with blueprintDigest key DELETED skips when no blueprint provided", () => {
    // When no blueprint is provided for verification, backward compat applies
    const manifest = { version: 3, blueprintDigest: "deadbeef".repeat(8) };
    delete manifest.blueprintDigest;

    const result = verifyBlueprintDigestFromManifest(manifest, null);
    expect(result.valid).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("v3 manifest with blueprintDigest set to undefined skips verification", () => {
    const manifest = { version: 3, blueprintDigest: undefined };
    // `"blueprintDigest" in manifest` is TRUE (key exists, value is undefined)
    // but `!manifest.blueprintDigest` is TRUE (undefined is falsy)
    // so this should FAIL (reject)
    const result = verifyBlueprintDigestFromManifest(manifest, "anything");
    expect(result.valid).toBe(false);
  });

  it("v3 manifest with blueprintDigest set to null fails verification", () => {
    const manifest = { version: 3, blueprintDigest: null };
    const result = verifyBlueprintDigestFromManifest(manifest, "anything");
    expect(result.valid).toBe(false);
  });

  it("v3 manifest with blueprintDigest set to 0 fails verification", () => {
    const manifest = { version: 3, blueprintDigest: 0 };
    const result = verifyBlueprintDigestFromManifest(manifest, "anything");
    expect(result.valid).toBe(false);
  });

  it("v2 manifest (no blueprintDigest key) skips verification (backward compat)", () => {
    const manifest = { version: 2 };
    const result = verifyBlueprintDigestFromManifest(manifest, "anything");
    expect(result.valid).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("v3 key deletion bypass is now blocked when blueprint is provided", () => {
    // Previously, deleting blueprintDigest from a v3 manifest would cause
    // verification to be skipped entirely. The fix detects this: if the
    // manifest is v3+ and a blueprint is provided for verification, the
    // key MUST be present.
    const v3WithDigest = { version: 3, blueprintDigest: "abc123" };
    const v3WithoutDigest = { version: 3 };

    expect("blueprintDigest" in v3WithDigest).toBe(true);
    expect("blueprintDigest" in v3WithoutDigest).toBe(false);

    // With blueprint provided: key deletion is caught
    const result = verifyBlueprintDigestFromManifest(v3WithoutDigest, "blueprint content");
    expect(result.valid).toBe(false);

    // Without blueprint provided: backward compat still works
    const resultNoBp = verifyBlueprintDigestFromManifest(v3WithoutDigest, null);
    expect(resultNoBp.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Bonus: execSync absence in critical files
//
// PR #584 replaced execSync with execFileSync in security-critical
// paths. Verify no regression brings it back.
// ═══════════════════════════════════════════════════════════════════

describe("Bonus: no execSync in security-critical bridge/deploy code", () => {
  it("nemoclaw.js does not use execSync (only spawnSync/execFileSync)", () => {
    const content = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
      "utf-8",
    );
    // Should use execFileSync or spawnSync, never execSync directly
    // (runner.js wraps execSync in run()/runCapture() which is OK)
    const directExecSync = content.match(/\bexecSync\b/g) || [];
    const imports = content.match(/require.*child_process/g) || [];

    // execSync should not appear outside of require statements
    // Allow: const { execFileSync } = require("child_process")
    // Reject: execSync("user controlled string")
    const nonImportUses = content
      .split("\n")
      .filter((l) => /\bexecSync\b/.test(l) && !/require/.test(l) && !/execFileSync/.test(l));
    expect(
      nonImportUses,
      `execSync used directly in nemoclaw.js (lines: ${nonImportUses.map((l) => l.trim()).join("; ")})`,
    ).toHaveLength(0);
  });
});
