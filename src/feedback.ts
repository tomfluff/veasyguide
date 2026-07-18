// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The feedback email, prefilled with what a bug report always needs and never includes.
//
// mailto:, not a form or a widget: no third-party script in an app that calls no external
// host, no account, and — the property that matters — the sender SEES the draft before
// anything is sent. Nothing leaves silently, which is the same promise the analyzer makes.
//
// The address is assembled here at call time rather than sitting in the markup as a
// mailto: literal, which keeps it out of the reach of the laziest address scrapers.
// It is still ultimately public — that is inherent to publishing a contact.
const USER = "ysechayk";
const HOST = "acm.org";

export type Diagnostics = {
  fileName?: string | null;
  duration?: number; // seconds
  videoWidth?: number;
  videoHeight?: number;
  validMoments?: number;
  totalActivities?: number;
  scenes?: number;
  xRealtime?: number;
  done?: boolean;
};

declare const __COMMIT__: string;
// typeof-guarded: __COMMIT__ is injected by Vite's `define`, and a runtime that missed the
// injection (a dev server started before the config change, a bare test runner) must degrade
// to "dev", not throw a ReferenceError from inside the page footer.
const COMMIT = typeof __COMMIT__ !== "undefined" ? __COMMIT__ : "dev";

export function feedbackMailto(d: Diagnostics): string {
  const lines: string[] = [
    "", // where they type
    "",
    "--- diagnostics (edit or delete freely) ---",
    `VeasyGuide ${COMMIT}`,
    navigator.userAgent,
  ];

  if (d.duration) {
    // The file EXTENSION only, never the name: a file name can identify a course, a
    // student, or worse, and the sender should not have to remember to scrub it.
    const ext = d.fileName?.includes(".") ? d.fileName.slice(d.fileName.lastIndexOf(".") + 1) : "?";
    const mm = Math.floor(d.duration / 60);
    const ss = Math.round(d.duration % 60).toString().padStart(2, "0");
    lines.push(`video: ${mm}:${ss}, ${d.videoWidth}×${d.videoHeight} (${ext})`);
    lines.push(
      `moments: ${d.validMoments} valid / ${d.totalActivities} · ${d.scenes} scene${d.scenes === 1 ? "" : "s"}` +
        (d.done ? "" : " (analysis still running)")
    );
    if (d.xRealtime) lines.push(`analysis: ${d.xRealtime.toFixed(1)}× realtime`);
  }

  const subject = encodeURIComponent("VeasyGuide feedback");
  const body = encodeURIComponent(lines.join("\n"));
  return `mailto:${USER}@${HOST}?subject=${subject}&body=${body}`;
}
