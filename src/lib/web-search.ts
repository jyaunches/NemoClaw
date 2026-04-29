// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Web search provider model — types, metadata registry, and config fragment
 * builders for Brave, Gemini, and Tavily web search providers.
 *
 * This module is imported by onboard, session management, and the Dockerfile
 * config generator. It must remain side-effect-free.
 */

// ── Types ────────────────────────────────────────────────────────

export type WebSearchProvider = "brave" | "gemini" | "tavily";

export interface WebSearchConfig {
  provider: WebSearchProvider;
  fetchEnabled: boolean;
}

export interface DisabledWebSearchConfig {
  provider?: WebSearchProvider;
  fetchEnabled: false;
}

export type PersistedWebSearchConfig = WebSearchConfig | DisabledWebSearchConfig;

export interface WebSearchProviderMetadata {
  provider: WebSearchProvider;
  label: string;
  helpUrl: string;
  credentialEnv: string;
  pluginEntry: string;
  policyPreset: string;
}

// ── Constants ────────────────────────────────────────────────────

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
export const WEB_SEARCH_PROVIDER_ENV = "NEMOCLAW_WEB_SEARCH_PROVIDER";
export const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-2.5-flash";

// ── Provider Registry ────────────────────────────────────────────

const WEB_SEARCH_PROVIDERS: Record<WebSearchProvider, WebSearchProviderMetadata> = {
  brave: {
    provider: "brave",
    label: "Brave Search",
    helpUrl: "https://api.search.brave.com/app/keys",
    credentialEnv: BRAVE_API_KEY_ENV,
    pluginEntry: "brave",
    policyPreset: "brave",
  },
  gemini: {
    provider: "gemini",
    label: "Google Gemini",
    helpUrl: "https://aistudio.google.com/app/apikey",
    credentialEnv: GEMINI_API_KEY_ENV,
    pluginEntry: "google",
    policyPreset: "gemini",
  },
  tavily: {
    provider: "tavily",
    label: "Tavily",
    helpUrl: "https://app.tavily.com",
    credentialEnv: TAVILY_API_KEY_ENV,
    pluginEntry: "tavily",
    policyPreset: "tavily",
  },
};

// ── Provider Accessors ───────────────────────────────────────────

export function listWebSearchProviders(): WebSearchProviderMetadata[] {
  return Object.values(WEB_SEARCH_PROVIDERS);
}

export function parseWebSearchProvider(value: unknown): WebSearchProvider | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return Object.hasOwn(WEB_SEARCH_PROVIDERS, normalized)
    ? (normalized as WebSearchProvider)
    : null;
}

export function getWebSearchProvider(provider: WebSearchProvider): WebSearchProviderMetadata {
  return WEB_SEARCH_PROVIDERS[provider];
}

// ── Config Normalization ─────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a persisted web search config value from disk. Handles:
 * - Missing provider field (defaults to "brave" for backward compat)
 * - Invalid provider values (returns null)
 * - Explicit disable (fetchEnabled: false)
 */
export function normalizePersistedWebSearchConfig(
  value: unknown,
): PersistedWebSearchConfig | null {
  if (!isObject(value) || typeof value.fetchEnabled !== "boolean") return null;

  if (value.fetchEnabled === false) {
    const provider =
      value.provider === undefined ? undefined : parseWebSearchProvider(value.provider);
    if (value.provider !== undefined && !provider) return null;
    return provider ? { provider, fetchEnabled: false } : { fetchEnabled: false };
  }

  // fetchEnabled === true — provider is required (default: "brave" for backward compat)
  const provider =
    value.provider === undefined ? "brave" : parseWebSearchProvider(value.provider);
  if (!provider) return null;
  return { provider, fetchEnabled: true };
}

/**
 * Normalize to an enabled WebSearchConfig or null.
 */
export function normalizeWebSearchConfig(value: unknown): WebSearchConfig | null {
  const normalized = normalizePersistedWebSearchConfig(value);
  return normalized?.fetchEnabled === true ? (normalized as WebSearchConfig) : null;
}

// ── Credential Helpers ───────────────────────────────────────────

/**
 * Return all credential env var names across all providers.
 * Used for credential redaction in logs and session serialization.
 */
export function getWebSearchCredentialEnvNames(): string[] {
  return listWebSearchProviders().map((p) => p.credentialEnv);
}

/**
 * Return user-facing warning lines about credential exposure for a provider.
 */
export function getWebSearchExposureWarningLines(provider: WebSearchProvider): string[] {
  const { label } = getWebSearchProvider(provider);
  return [
    `NemoClaw will store a ${label} API key resolver in sandbox OpenClaw config.`,
    "The OpenClaw agent will be able to resolve and read that key at runtime.",
  ];
}

// ── Config Fragment Builders ─────────────────────────────────────

/**
 * Build the OpenClaw config fragment for a given web search provider.
 * Returns an empty object when config is null or disabled.
 */
export function buildWebSearchConfigFragment(
  config: WebSearchConfig | null,
  apiKey: string | null,
): Record<string, unknown> {
  const normalized = normalizeWebSearchConfig(config);
  if (!normalized) return {};

  const { credentialEnv, pluginEntry } = getWebSearchProvider(normalized.provider);
  const apiKeyRef = apiKey ? `openshell:resolve:env:${credentialEnv}` : null;

  return {
    plugins: {
      entries: {
        [pluginEntry]: {
          enabled: true,
          config: {
            webSearch: {
              ...(normalized.provider === "gemini"
                ? { model: DEFAULT_GEMINI_WEB_SEARCH_MODEL }
                : {}),
              ...(apiKeyRef ? { apiKey: apiKeyRef } : {}),
            },
          },
        },
      },
    },
    tools: {
      web: {
        search: {
          enabled: true,
          provider: normalized.provider,
        },
        fetch: {
          enabled: true,
        },
      },
    },
  };
}

/**
 * Encode a config fragment as base64 JSON for Docker build-arg transport.
 */
export function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8").toString("base64");
}

/**
 * Build the base64-encoded Docker build arg for web search config.
 */
export function buildWebSearchDockerConfig(
  config: WebSearchConfig | null,
  apiKey: string | null,
): string {
  return encodeDockerJsonArg(buildWebSearchConfigFragment(config, apiKey));
}
