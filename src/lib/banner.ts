// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Render content lines inside a dynamically-sized Unicode box.
 *
 * Computes the inner width as:
 *   min(terminalColumns - 4, max(minInner, longestLine + 2))
 *
 * The `- 4` accounts for the two-space indent plus `│` borders on each side.
 * This ensures:
 *   1. Long content (e.g. cloudflare URLs) never causes the closing `│` to be
 *      adjacent to URL text (which terminals Punycode-encode, breaking links).
 *   2. The box never overflows the terminal width.
 *
 * @param lines - Content strings to render, or `null` for blank separator rows.
 * @param options - Configuration options.
 * @param options.minInner - Minimum inner box width (default: 53).
 * @returns Array of formatted box lines ready for console output.
 */
export function renderBox(
  lines: (string | null)[],
  { minInner = 53 }: { minInner?: number } = {},
): string[] {
  const detectedCols = process.stdout.columns;
  const termCols = detectedCols !== undefined && detectedCols > 0 ? detectedCols : 100;
  const maxInner = Math.max(0, termCols - 4);
  const contentMax = lines.reduce<number>(
    (max, line) => (line === null ? max : Math.max(max, line.length + 2)),
    minInner,
  );
  const inner = Math.min(maxInner, contentMax);

  const pad = (s: string): string => {
    if (s.length > inner) return s.slice(0, inner);
    return s + " ".repeat(inner - s.length);
  };
  const hBar = "─".repeat(inner);
  const blank = " ".repeat(inner);

  return [
    `  ┌${hBar}┐`,
    ...lines.map((line) => (line === null ? `  │${blank}│` : `  │${pad(line)}│`)),
    `  └${hBar}┘`,
  ];
}
