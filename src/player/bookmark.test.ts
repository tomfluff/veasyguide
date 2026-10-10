// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  initialBookmark,
  bookmarkTime,
  bookmarkViewerSeek,
  bookmarkPlay,
  bookmarkPreviewStart,
  bookmarkPreviewEnd,
  bookmarkSeeked,
  bookmarkToSave,
  type Bookmark,
} from "./bookmark";

// Apply a list of steps and return the state, so a test reads as the event sequence it covers.
type Step = ["time", number] | ["seek", number] | ["play"] | ["previewStart"] | ["previewEnd", number];
const run = (steps: Step[], b: Bookmark = initialBookmark()) =>
  steps.reduce((s, step) => {
    switch (step[0]) {
      case "time": return bookmarkTime(s, step[1]);
      case "seek": return bookmarkViewerSeek(s, step[1]);
      case "play": return bookmarkPlay(s);
      case "previewStart": return bookmarkPreviewStart(s);
      case "previewEnd": return bookmarkPreviewEnd(s, step[1]);
    }
  }, b);

describe("the resume bookmark", () => {
  it("saves nothing for a video the viewer only opened", () => {
    expect(bookmarkToSave(run([["time", 0], ["time", 0]]))).toBeNull();
  });

  it("follows playback once the viewer has played", () => {
    expect(bookmarkToSave(run([["play"], ["time", 1], ["time", 42.5]]))).toBe(42.5);
  });

  it("writes a viewer seek at once, before it lands", () => {
    // Leaving the page in the instant after the seek, with the old time still being reported.
    expect(bookmarkToSave(run([["play"], ["time", 10], ["seek", 100], ["time", 10.1]]))).toBe(100);
  });

  it("resumes the playhead's reports once the seek has landed", () => {
    expect(bookmarkToSave(run([["seek", 100], ["time", 100.02], ["time", 101]]))).toBe(101);
  });

  it("round 9: Resume, then leave before the seek lands", () => {
    // Pressing Resume marks the video touched while the playhead is still at 0:00; the save in
    // that window used to delete the bookmark.
    const b = run([["time", 0], ["seek", 124]]);
    expect(bookmarkToSave(b)).toBe(124);
    expect(bookmarkToSave(bookmarkTime(b, 0))).toBe(124);
  });

  it("never records the Appearance preview's parked position", () => {
    const b = run([["seek", 30], ["time", 30], ["previewStart"], ["time", 47.8]]);
    expect(bookmarkToSave(b)).toBe(30);
  });

  it("round 6: close the preview, then leave before the step-back lands", () => {
    const closed = run([["seek", 30], ["time", 30], ["previewStart"], ["time", 47.8], ["previewEnd", 30]]);
    // A late report from the preview's position must not move it.
    expect(bookmarkToSave(bookmarkTime(closed, 47.8))).toBe(30);
    // And once the step-back lands, playback carries on from there.
    expect(bookmarkToSave(run([["time", 30], ["time", 31]], closed))).toBe(31);
  });

  it("round 4: the viewer moves during the preview, and then the sheet closes", () => {
    // ] (or a scrubber click) during the preview is the viewer choosing a place; the preview
    // lets go without stepping back, and the step-back must not come back later to undo it.
    const b = run([["seek", 30], ["time", 30], ["previewStart"], ["time", 47.8], ["seek", 52.8]]);
    expect(bookmarkToSave(b)).toBe(52.8);
    expect(bookmarkToSave(bookmarkPreviewEnd(b, 30))).toBe(52.8); // no preview left to end
    expect(bookmarkToSave(bookmarkTime(b, 47.8))).toBe(52.8); // stale report ignored
  });

  it("round 4: a scrubber click during the preview saves where it was clicked", () => {
    expect(bookmarkToSave(run([["seek", 30], ["previewStart"], ["time", 47.8], ["seek", 100]]))).toBe(100);
  });

  it("does not count the preview as the viewer touching the video", () => {
    // Opening Appearance on a video they have not played is not a place to come back to.
    expect(bookmarkToSave(run([["time", 0], ["previewStart"], ["time", 47.8], ["previewEnd", 0]]))).toBeNull();
  });
});

describe("the resume bookmark across a seek's landing", () => {
  it("does not freeze when the next report comes long after the landing", () => {
    // timeupdate -> seeked -> a frame report delayed past the landing tolerance (3x speed, or a
    // backgrounded tab throttling frame callbacks). The landing clears the pending seek, so the
    // late report still moves the bookmark.
    let b = run([["play"], ["time", 10], ["seek", 100]]);
    b = bookmarkSeeked(b, 100, true);
    b = bookmarkTime(b, 103.2);
    expect(bookmarkToSave(b)).toBe(103.2);
    expect(bookmarkToSave(bookmarkTime(b, 110))).toBe(110);
  });

  it("records a seek it never saw requested (media keys) when it lands", () => {
    const b = bookmarkSeeked(run([["time", 0]]), 75, true);
    expect(bookmarkToSave(b)).toBe(75);
  });

  it("ignores the preview's own landing, and takes the step-back's landing as arrival", () => {
    let b = run([["seek", 30], ["time", 30], ["previewStart"]]);
    b = bookmarkSeeked(b, 47.8, false);
    expect(bookmarkToSave(b)).toBe(30);
    b = bookmarkPreviewEnd(b, 30);
    b = bookmarkSeeked(b, 30, false);
    expect(bookmarkToSave(bookmarkTime(b, 31.5))).toBe(31.5);
  });
});
