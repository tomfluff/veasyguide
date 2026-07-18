// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// "Use this moments file?" — the one gate between a dropped sidecar and the analysis it
// replaces.
//
// A native <dialog> for the same reason About is one: showModal() brings focus trapping,
// Esc-to-close and a backdrop, and a confirm that can be missed or tabbed behind is worse
// than no confirm at all. Cancel is the autofocused, default action: the risk here is
// destroying twenty minutes of analysis with a stray Enter, not the cost of one more click.
import { useEffect, useRef } from "react";
import type { MomentsFile } from "./analyzer/momentsFile";
import { validActivities } from "./analyzer/select";
import { convertSecondsToTimecode } from "./utils/misc";

export default function ConfirmSidecar({
  file,
  analyzing,
  onCancel,
  onConfirm,
}: {
  // Null when nothing is pending — the dialog is closed and renders no content.
  file: MomentsFile | null;
  // Mid-analysis the trade is honest but different: you lose progress, not a finished run.
  analyzing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (file && !d.open) d.showModal();
    if (!file && d.open) d.close();
  }, [file]);

  // The number the sidebar will show, counted the way the sidebar counts it. isValid alone
  // reads 26 where the app then displays 20 — the display floor (minDuration) is half the
  // rule, and validActivities is the one place that owns it (D22 fixed the same drift in
  // the notes export). A confirm that misstates what you're about to get is worse than none.
  const count = file ? validActivities(file.activities, file.params?.minDuration ?? 0).length : 0;

  return (
    <dialog
      ref={ref}
      className="confirm"
      // Esc and backdrop both mean cancel: the safe answer is the easy one to give.
      onClose={onCancel}
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
      aria-labelledby="confirm-h"
    >
      {file && (
        <>
          <h2 id="confirm-h">Use this moments file?</h2>
          <p>
            It holds <b>{count} moments</b> across{" "}
            <b>{convertSecondsToTimecode(file.video.duration)}</b>, analyzed{" "}
            {file.savedAt.slice(0, 10)}. It matches the video you're watching.
          </p>
          <p className="confirm-cost">
            {analyzing
              ? "This replaces the analysis still running — you'd stop waiting and get the whole lecture now."
              : "This replaces the finished analysis you already have."}
          </p>
          <div className="confirm-row">
            <button type="button" className="confirm-no" onClick={onCancel} autoFocus>
              Keep what I have
            </button>
            <button type="button" className="confirm-yes" onClick={onConfirm}>
              Use the file
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
