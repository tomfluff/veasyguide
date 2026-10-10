// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// "Switch to another video?" — asked only when switching would throw away an analysis that is
// still running.
//
// A finished analysis needs no confirm: it is already in the IndexedDB cache
// (utils/analysisCache.ts), so opening that video again restores it at once. A running one is
// not cached until it finishes, and switching away loses every minute it has spent so far.
// Same native <dialog> pattern as ConfirmSidecar, for the same reasons: focus trapping,
// Esc-to-close and a backdrop for free, and Cancel autofocused, because the risk is a stray
// Enter destroying twenty minutes of work.
import { useEffect, useRef } from "react";

export default function ConfirmSwitch({
  next,
  current,
  onCancel,
  onConfirm,
}: {
  // The file the viewer picked. Null when nothing is pending: the dialog is closed.
  next: string | null;
  current: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (next && !d.open) d.showModal();
    if (!next && d.open) d.close();
  }, [next]);

  return (
    <dialog
      ref={ref}
      className="confirm"
      // Esc and backdrop both mean cancel: the safe answer is the easy one to give.
      onClose={onCancel}
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
      aria-labelledby="confirm-switch-h"
    >
      {next && (
        <>
          <h2 id="confirm-switch-h">Switch to another video?</h2>
          <p>
            <b>{current ?? "This video"}</b> is still being analyzed. Switching to{" "}
            <b>{next}</b> stops that analysis.
          </p>
          <p className="confirm-cost">
            Only a finished analysis is kept. Open this video again later and it starts over.
          </p>
          <div className="confirm-row">
            <button type="button" className="confirm-no" onClick={onCancel} autoFocus>
              Keep watching
            </button>
            <button type="button" className="confirm-yes" onClick={onConfirm}>
              Switch video
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
