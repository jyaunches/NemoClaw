// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential detection and stripping utilities.
 *
 * Extracted from migration-state.ts so E2E tests can exercise the real
 * production logic instead of reimplementing it inline.
 */

/**
 * File basenames that contain credentials and must never cross
 * the sandbox boundary.
 */
export const CREDENTIAL_SENSITIVE_BASENAMES = new Set(["auth-profiles.json"]);

/**
 * Credential field names that MUST be stripped from config files
 * before they enter the sandbox. Credentials should be injected
 * at runtime via OpenShell's provider credential mechanism.
 */
export const CREDENTIAL_FIELDS = new Set([
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "resolvedKey",
]);

/**
 * Pattern-based detection for credential field names not covered by the
 * explicit set above. Matches common suffixes like accessToken, privateKey,
 * clientSecret, etc.
 */
export const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

export function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

/**
 * Recursively strip credential fields from a JSON-like object.
 * Returns a new object with sensitive values replaced by a placeholder.
 */
export function stripCredentials(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isCredentialField(key)) {
      result[key] = "[STRIPPED_BY_MIGRATION]";
    } else {
      result[key] = stripCredentials(value);
    }
  }
  return result;
}

import { createHash } from "node:crypto";

/**
 * Compute a SHA-256 hex digest for the given content buffer or string.
 */
export function computeDigest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
