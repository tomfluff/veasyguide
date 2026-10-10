// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The ONE place the viewer would want to come back to, for the resume bookmark (resume.ts saves
// it; docs/decisions.md D33). It changes only on the viewer's intent: playing through the
// lecture, a seek of theirs, answering the resume offer. The player's own moves — the Appearance
// preview parking the playhead on a moment, and stepping it back — never write it.
//
// Why a module and not a few refs in App: the bookmark used to be "the playhead, unless a flag
// says otherwise", with the flags set from events that land in an order nobody controls (a seek
// is a request; `seeked` and the next time report come later). Four review rounds found four
// windows where a save landed between the request and the report and recorded the wrong place —
// the preview's time, 0:00 before a Resume seek landed, the pre-preview time after the viewer
// had moved on. Here the viewer's choice is written the moment it is MADE, and time reports that
// arrive before the playhead reaches it are ignored, so a save at any instant reads the right
// value by construction. Pure, so those sequences are unit-tested (bookmark.test.ts).

export type Bookmark = {
  // Where the viewer is, as far as coming back is concerned. null until anything is known.
  place: number | null;
  // Whether the viewer has done anything here yet. Nothing is saved for a video they only
  // opened: saving "0:00" for that would erase the place they actually were at.
  touched: boolean;
  // A seek the viewer (or the player stepping back from a preview) asked for that has not
  // landed yet: time reports are ignored until one arrives near it. A report from before the
  // seek landed describes where the playhead WAS, not where anyone wants to be.
  pending: number | null;
  // The Appearance preview has parked the playhead somewhere the viewer did not choose.
  previewing: boolean;
};

// How close a time report must be to a pending seek to count as it having landed. Generous: a
// playing video moves on between the seek landing and the next report.
const LANDED = 0.5;

export const initialBookmark = (): Bookmark => ({
  place: null,
  touched: false,
  pending: null,
  previewing: false,
});

// A time report from the player (per presented frame, or a paused seek's timeupdate).
export function bookmarkTime(b: Bookmark, t: number): Bookmark {
  if (b.previewing) return b;
  if (b.pending !== null) {
    if (Math.abs(t - b.pending) > LANDED) return b;
    return { ...b, pending: null, place: t };
  }
  return b.place === t ? b : { ...b, place: t };
}

// The viewer chose a place: a seek of theirs, or Resume. Written at once — before it lands.
// Also ends a preview: the viewer moving the playhead has let go of it.
export function bookmarkViewerSeek(_b: Bookmark, t: number): Bookmark {
  return { place: t, touched: true, pending: t, previewing: false };
}

// The viewer pressed play: they are watching now, so this video counts as touched.
export function bookmarkPlay(b: Bookmark): Bookmark {
  return b.touched ? b : { ...b, touched: true };
}

// The Appearance preview parked the playhead on a moment. The place is untouched.
export function bookmarkPreviewStart(b: Bookmark): Bookmark {
  return { ...b, previewing: true };
}

// The preview let go by stepping back to where the viewer was (`back`). The place was never
// changed, so it is still right; reports from the preview's position, until the step-back
// lands, are ignored.
export function bookmarkPreviewEnd(b: Bookmark, back: number): Bookmark {
  if (!b.previewing) return b;
  return { ...b, previewing: false, pending: back };
}

// What to save right now, or null for "save nothing".
export function bookmarkToSave(b: Bookmark): number | null {
  return b.touched ? b.place : null;
}
