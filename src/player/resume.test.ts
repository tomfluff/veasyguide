// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import {
  savePosition,
  loadPosition,
  isResumable,
  RESUME_EDGE,
  RESUME_KEEP,
  RESUME_STORAGE_KEY,
  type ResumeStore,
} from "./resume";

class MemStore implements ResumeStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const DUR = 600; // a ten-minute lecture

describe("the resume position", () => {
  let store: MemStore;
  beforeEach(() => {
    store = new MemStore();
  });

  it("comes back for the same video, and only that one", () => {
    savePosition(store, "a", 300, DUR, 1);
    expect(loadPosition(store, "a", DUR)).toBe(300);
    expect(loadPosition(store, "b", DUR)).toBeNull();
  });

  it("is not offered within the first ten seconds", () => {
    savePosition(store, "a", RESUME_EDGE - 0.5, DUR, 1);
    expect(loadPosition(store, "a", DUR)).toBeNull();
    expect(isResumable(RESUME_EDGE, DUR)).toBe(true);
  });

  it("is cleared, not kept, when the viewer goes back to the start", () => {
    // They rewatched the intro and left: the place they were before that is no longer where
    // they are.
    savePosition(store, "a", 300, DUR, 1);
    savePosition(store, "a", 3, DUR, 2);
    expect(loadPosition(store, "a", DUR)).toBeNull();
  });

  it("is cleared within ten seconds of the end", () => {
    savePosition(store, "a", 300, DUR, 1);
    savePosition(store, "a", DUR - RESUME_EDGE + 1, DUR, 2);
    expect(loadPosition(store, "a", DUR)).toBeNull();
    expect(isResumable(DUR - RESUME_EDGE - 1, DUR)).toBe(true);
  });

  it("follows the newest save", () => {
    savePosition(store, "a", 100, DUR, 1);
    savePosition(store, "a", 250, DUR, 2);
    expect(loadPosition(store, "a", DUR)).toBe(250);
  });

  it("keeps only the newest fifty videos", () => {
    for (let i = 0; i < RESUME_KEEP + 5; i++) savePosition(store, `v${i}`, 100, DUR, i);
    const kept = Object.keys(JSON.parse(store.getItem(RESUME_STORAGE_KEY)!));
    expect(kept).toHaveLength(RESUME_KEEP);
    expect(loadPosition(store, "v0", DUR)).toBeNull(); // the oldest went
    expect(loadPosition(store, `v${RESUME_KEEP + 4}`, DUR)).toBe(100); // the newest stayed
  });

  it("evicts by when a video was last watched, not by when it was first saved", () => {
    for (let i = 0; i < RESUME_KEEP; i++) savePosition(store, `v${i}`, 100, DUR, i);
    savePosition(store, "v0", 120, DUR, 1000); // the oldest is watched again
    savePosition(store, "new", 100, DUR, 1001);
    expect(loadPosition(store, "v0", DUR)).toBe(120);
    expect(loadPosition(store, "v1", DUR)).toBeNull();
  });

  it("survives garbage in storage", () => {
    store.setItem(RESUME_STORAGE_KEY, "not json");
    expect(loadPosition(store, "a", DUR)).toBeNull();
    store.setItem(RESUME_STORAGE_KEY, JSON.stringify({ a: { t: "x" }, b: { t: 200, at: 1 } }));
    expect(loadPosition(store, "a", DUR)).toBeNull();
    expect(loadPosition(store, "b", DUR)).toBe(200);
    savePosition(store, "c", 300, DUR, 2); // and writing over it works
    expect(loadPosition(store, "c", DUR)).toBe(300);
  });

  it("never throws when storage refuses the write", () => {
    const full: ResumeStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => savePosition(full, "a", 300, DUR)).not.toThrow();
  });
});
