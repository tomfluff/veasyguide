// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bookkeeping for which parts of the video have been analyzed. Segments are
// independent (a seek starts a fresh one), so coverage is a set of ranges, not a
// single frontier.

import type { Range } from "./types";

export function addRange(ranges: Range[], r: Range): Range[] {
  const merged = [...ranges, r].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const cur of merged) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end + 1e-6) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

export function isAnalyzed(ranges: Range[], t: number): boolean {
  return ranges.some((r) => t >= r.start && t <= r.end);
}

// The range containing t, if any (used to stop a segment once it runs into
// already-analyzed territory).
export function rangeAt(ranges: Range[], t: number): Range | null {
  return ranges.find((r) => t >= r.start && t <= r.end) ?? null;
}

// Earliest unanalyzed instant at or after `from`, or null if covered to `duration`.
export function nextGap(ranges: Range[], duration: number, from = 0): number | null {
  let t = from;
  // Ranges are sorted and disjoint after addRange.
  for (const r of ranges) {
    if (t < r.start) return t;
    if (t <= r.end) t = r.end;
  }
  return t < duration - 1e-6 ? t : null;
}

export function coverage(ranges: Range[], duration: number): number {
  if (duration <= 0) return 0;
  const covered = ranges.reduce((s, r) => s + (r.end - r.start), 0);
  return Math.min(1, covered / duration);
}
