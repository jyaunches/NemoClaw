// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BRAVE_API_KEY_ENV,
  GEMINI_API_KEY_ENV,
  TAVILY_API_KEY_ENV,
  WEB_SEARCH_PROVIDER_ENV,
  DEFAULT_GEMINI_WEB_SEARCH_MODEL,
  listWebSearchProviders,
  parseWebSearchProvider,
  getWebSearchProvider,
  normalizePersistedWebSearchConfig,
  normalizeWebSearchConfig,
  getWebSearchCredentialEnvNames,
  getWebSearchExposureWarningLines,
  buildWebSearchConfigFragment,
  encodeDockerJsonArg,
  buildWebSearchDockerConfig,
} from "./web-search";

import type { WebSearchConfig, WebSearchProvider } from "./web-search";

describe("web-search module", () => {
  describe("constants", () => {
    it("exports credential env constants", () => {
      expect(BRAVE_API_KEY_ENV).toBe("BRAVE_API_KEY");
      expect(GEMINI_API_KEY_ENV).toBe("GEMINI_API_KEY");
      expect(TAVILY_API_KEY_ENV).toBe("TAVILY_API_KEY");
    });

    it("exports provider env constant", () => {
      expect(WEB_SEARCH_PROVIDER_ENV).toBe("NEMOCLAW_WEB_SEARCH_PROVIDER");
    });

    it("exports default Gemini model", () => {
      expect(DEFAULT_GEMINI_WEB_SEARCH_MODEL).toBe("gemini-2.5-flash");
    });
  });

  describe("listWebSearchProviders()", () => {
    it("returns all three providers", () => {
      const providers = listWebSearchProviders();
      expect(providers).toHaveLength(3);
      expect(providers.map((p) => p.provider).sort()).toEqual(["brave", "gemini", "tavily"]);
    });

    it("each provider has required metadata fields", () => {
      for (const p of listWebSearchProviders()) {
        expect(p.label).toBeTruthy();
        expect(p.helpUrl).toMatch(/^https:\/\//);
        expect(p.credentialEnv).toBeTruthy();
        expect(p.pluginEntry).toBeTruthy();
        expect(p.policyPreset).toBeTruthy();
      }
    });
  });

  describe("parseWebSearchProvider()", () => {
    it("parses valid provider strings", () => {
      expect(parseWebSearchProvider("brave")).toBe("brave");
      expect(parseWebSearchProvider("gemini")).toBe("gemini");
      expect(parseWebSearchProvider("tavily")).toBe("tavily");
    });

    it("normalizes case and whitespace", () => {
      expect(parseWebSearchProvider("BRAVE")).toBe("brave");
      expect(parseWebSearchProvider("  Gemini  ")).toBe("gemini");
      expect(parseWebSearchProvider("TAVILY")).toBe("tavily");
    });

    it("returns null for invalid values", () => {
      expect(parseWebSearchProvider("invalid")).toBeNull();
      expect(parseWebSearchProvider("")).toBeNull();
      expect(parseWebSearchProvider(null)).toBeNull();
      expect(parseWebSearchProvider(undefined)).toBeNull();
      expect(parseWebSearchProvider(123)).toBeNull();
      expect(parseWebSearchProvider({})).toBeNull();
    });
  });

  describe("getWebSearchProvider()", () => {
    it("returns metadata for brave", () => {
      const meta = getWebSearchProvider("brave");
      expect(meta.label).toBe("Brave Search");
      expect(meta.credentialEnv).toBe("BRAVE_API_KEY");
      expect(meta.pluginEntry).toBe("brave");
      expect(meta.policyPreset).toBe("brave");
    });

    it("returns metadata for gemini", () => {
      const meta = getWebSearchProvider("gemini");
      expect(meta.label).toBe("Google Gemini");
      expect(meta.credentialEnv).toBe("GEMINI_API_KEY");
      expect(meta.pluginEntry).toBe("google");
      expect(meta.policyPreset).toBe("gemini");
    });

    it("returns metadata for tavily", () => {
      const meta = getWebSearchProvider("tavily");
      expect(meta.label).toBe("Tavily");
      expect(meta.credentialEnv).toBe("TAVILY_API_KEY");
      expect(meta.pluginEntry).toBe("tavily");
      expect(meta.policyPreset).toBe("tavily");
    });
  });

  describe("normalizePersistedWebSearchConfig()", () => {
    it("returns null for non-objects", () => {
      expect(normalizePersistedWebSearchConfig(null)).toBeNull();
      expect(normalizePersistedWebSearchConfig(undefined)).toBeNull();
      expect(normalizePersistedWebSearchConfig("string")).toBeNull();
      expect(normalizePersistedWebSearchConfig(42)).toBeNull();
      expect(normalizePersistedWebSearchConfig([])).toBeNull();
    });

    it("returns null when fetchEnabled is missing", () => {
      expect(normalizePersistedWebSearchConfig({ provider: "brave" })).toBeNull();
    });

    it("handles enabled config with provider", () => {
      const result = normalizePersistedWebSearchConfig({
        provider: "gemini",
        fetchEnabled: true,
      });
      expect(result).toEqual({ provider: "gemini", fetchEnabled: true });
    });

    it("defaults to brave when provider is missing and fetchEnabled is true", () => {
      const result = normalizePersistedWebSearchConfig({ fetchEnabled: true });
      expect(result).toEqual({ provider: "brave", fetchEnabled: true });
    });

    it("returns null for invalid provider with fetchEnabled true", () => {
      expect(
        normalizePersistedWebSearchConfig({ provider: "invalid", fetchEnabled: true }),
      ).toBeNull();
    });

    it("handles disabled config without provider", () => {
      const result = normalizePersistedWebSearchConfig({ fetchEnabled: false });
      expect(result).toEqual({ fetchEnabled: false });
    });

    it("handles disabled config with valid provider", () => {
      const result = normalizePersistedWebSearchConfig({
        provider: "tavily",
        fetchEnabled: false,
      });
      expect(result).toEqual({ provider: "tavily", fetchEnabled: false });
    });

    it("returns null for disabled config with invalid provider", () => {
      expect(
        normalizePersistedWebSearchConfig({ provider: "invalid", fetchEnabled: false }),
      ).toBeNull();
    });
  });

  describe("normalizeWebSearchConfig()", () => {
    it("returns enabled config", () => {
      const result = normalizeWebSearchConfig({ provider: "tavily", fetchEnabled: true });
      expect(result).toEqual({ provider: "tavily", fetchEnabled: true });
    });

    it("returns null for disabled config", () => {
      expect(normalizeWebSearchConfig({ fetchEnabled: false })).toBeNull();
    });

    it("returns null for invalid input", () => {
      expect(normalizeWebSearchConfig(null)).toBeNull();
      expect(normalizeWebSearchConfig({})).toBeNull();
    });
  });

  describe("getWebSearchCredentialEnvNames()", () => {
    it("returns all credential env names", () => {
      const envNames = getWebSearchCredentialEnvNames();
      expect(envNames).toContain("BRAVE_API_KEY");
      expect(envNames).toContain("GEMINI_API_KEY");
      expect(envNames).toContain("TAVILY_API_KEY");
      expect(envNames).toHaveLength(3);
    });
  });

  describe("getWebSearchExposureWarningLines()", () => {
    it("returns provider-specific warning for brave", () => {
      const lines = getWebSearchExposureWarningLines("brave");
      expect(lines[0]).toContain("Brave Search");
      expect(lines).toHaveLength(2);
    });

    it("returns provider-specific warning for gemini", () => {
      const lines = getWebSearchExposureWarningLines("gemini");
      expect(lines[0]).toContain("Google Gemini");
    });

    it("returns provider-specific warning for tavily", () => {
      const lines = getWebSearchExposureWarningLines("tavily");
      expect(lines[0]).toContain("Tavily");
    });
  });

  describe("buildWebSearchConfigFragment()", () => {
    it("returns empty object for null config", () => {
      expect(buildWebSearchConfigFragment(null, null)).toEqual({});
    });

    it("returns empty object for disabled config", () => {
      const config = { provider: "brave", fetchEnabled: false } as unknown as WebSearchConfig;
      expect(buildWebSearchConfigFragment(config, null)).toEqual({});
    });

    it("builds brave config fragment", () => {
      const config: WebSearchConfig = { provider: "brave", fetchEnabled: true };
      const result = buildWebSearchConfigFragment(config, "test-key");
      expect(result).toEqual({
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "openshell:resolve:env:BRAVE_API_KEY",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: { enabled: true, provider: "brave" },
            fetch: { enabled: true },
          },
        },
      });
    });

    it("builds gemini config fragment with model", () => {
      const config: WebSearchConfig = { provider: "gemini", fetchEnabled: true };
      const result = buildWebSearchConfigFragment(config, "test-key");
      expect(result).toEqual({
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  model: DEFAULT_GEMINI_WEB_SEARCH_MODEL,
                  apiKey: "openshell:resolve:env:GEMINI_API_KEY",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: { enabled: true, provider: "gemini" },
            fetch: { enabled: true },
          },
        },
      });
    });

    it("builds tavily config fragment", () => {
      const config: WebSearchConfig = { provider: "tavily", fetchEnabled: true };
      const result = buildWebSearchConfigFragment(config, "test-key");
      expect(result).toEqual({
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "openshell:resolve:env:TAVILY_API_KEY",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: { enabled: true, provider: "tavily" },
            fetch: { enabled: true },
          },
        },
      });
    });

    it("omits apiKey from fragment when key is null", () => {
      const config: WebSearchConfig = { provider: "brave", fetchEnabled: true };
      const result = buildWebSearchConfigFragment(config, null);
      expect(
        (result as any).plugins.entries.brave.config.webSearch.apiKey,
      ).toBeUndefined();
    });
  });

  describe("encodeDockerJsonArg()", () => {
    it("encodes value as base64 JSON", () => {
      const result = encodeDockerJsonArg({ foo: "bar" });
      const decoded = JSON.parse(Buffer.from(result, "base64").toString("utf8"));
      expect(decoded).toEqual({ foo: "bar" });
    });

    it("handles null/undefined as empty object", () => {
      const result = encodeDockerJsonArg(null);
      const decoded = JSON.parse(Buffer.from(result, "base64").toString("utf8"));
      expect(decoded).toEqual({});
    });
  });

  describe("buildWebSearchDockerConfig()", () => {
    it("returns base64-encoded config fragment", () => {
      const config: WebSearchConfig = { provider: "brave", fetchEnabled: true };
      const result = buildWebSearchDockerConfig(config, "key");
      const decoded = JSON.parse(Buffer.from(result, "base64").toString("utf8"));
      expect(decoded.tools.web.search.provider).toBe("brave");
    });

    it("returns base64 empty object for null config", () => {
      const result = buildWebSearchDockerConfig(null, null);
      const decoded = JSON.parse(Buffer.from(result, "base64").toString("utf8"));
      expect(decoded).toEqual({});
    });
  });
});
