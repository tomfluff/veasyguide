// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where the viewer left off, per video, so reopening a lecture can OFFER to take them back.
//
// Offered, never automatic: someone reopening a lecture may be coming back to it, or may be
// starting it over for the exam, and only they know which. Landing mid-lecture without asking
// is the app deciding for them — and for a screen-reader user it is silence at an unexplained
// timestamp.
//
// Keyed by videoKey (momentsFile.ts: size + duration + frame size), the same identity the
// analysis cache uses, so a renamed copy of the same file still finds its place. localStorage
// rather than the IndexedDB cache: an entry is two numbers, it must survive a video whose
// analysis was never cached (one closed mid-analysis), and it is written on pagehide, where
// an async IndexedDB transaction may never get to commit.
//
// Pure apart from the Storage it is handed, so the rules below are unit-tested (resume.test.ts).

export const RESUME_STORAGE_KEY = "veasyguide.resume";
// Within this many seconds of either end there is nothing worth offering: "Resume at 0:07?"
// costs a decision to save seven seconds, and near the end the viewer has finished — offering
// to resume the closing credits would be offering to replay nothing.
export const RESUME_EDGE = 10;
// Newest first; the rest are dropped. Fifty lectures is a long way back, and the store must
// stay small enough that reading it on every open is free.
export const RESUME_KEEP = 50;

type Entry = { t: number; at: number };
export type ResumeStore = Pick<Storage, "getItem" | "setItem">;

function read(store: ResumeStore): Record<string, Entry> {
  try {
    const raw = JSON.parse(store.getItem(RESUME_STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, Entry> = {};
    // Validated, not trusted: anything else on this origin could have written the key, and a
    // malformed entry must cost that entry, never the player.
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const e = v as Partial<Entry> | null;
      if (e && Number.isFinite(e.t) && Number.isFinite(e.at)) out[k] = { t: e.t!, at: e.at! };
    }
    return out;
  } catch {
    return {};
  }
}

function write(store: ResumeStore, all: Record<string, Entry>) {
  try {
    store.setItem(RESUME_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Quota or a storage-denied context. Resuming is a convenience; it must never be the
    // reason anything else fails.
  }
}

// Whether a position is one worth offering to go back to.
export function isResumable(t: number, duration: number): boolean {
  return t >= RESUME_EDGE && t < duration - RESUME_EDGE;
}

// Record where the viewer is now. A position near either end CLEARS the entry rather than
// being skipped: it is still the newest truth about where they are — someone who went back
// to the start to rewatch the intro, or who reached the end, should not be offered the place
// they were at before that.
export function savePosition(
  store: ResumeStore,
  key: string,
  t: number,
  duration: number,
  now = Date.now()
): void {
  const all = read(store);
  if (isResumable(t, duration)) all[key] = { t, at: now };
  else delete all[key];
  const newestFirst = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const k of newestFirst.slice(RESUME_KEEP)) delete all[k];
  write(store, all);
}

// The saved position for this video, if there is one still worth offering. Re-checked against
// the edges here as well: the duration can differ by a rounding step from the one it was saved
// against, and an entry written by an older build may predate the rule.
export function loadPosition(store: ResumeStore, key: string, duration: number): number | null {
  const e = read(store)[key];
  return e && isResumable(e.t, duration) ? e.t : null;
}

// localStorage, or nothing. The accessor itself throws in some storage-denied contexts.
export function resumeStore(): ResumeStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
