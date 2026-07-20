// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// First contact. Someone is about to hand a stranger's website their lecture, so the privacy
// promise gets a real box, not a footnote — it is the reason they'd trust this at all.
//
// The three-step explainer from the mockup is deliberately cut: it explained the app to people
// who have not used it yet, which is the one audience that cannot check whether it is true. The
// drop zone and the promise are what the screen is for.
import { useRef, useState } from "react";
import { IconLock, IconUpload } from "@tabler/icons-react";

export default function Landing({ onFiles, error }: { onFiles: (fs: File[]) => void; error?: string | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [sampleErr, setSampleErr] = useState<string | null>(null);

  // Nobody arrives at a drop zone holding a lecture video. The sample is the only way to see
  // what the app does before deciding to trust it with your own file. It goes down the exact
  // same path as a dropped file — fetched to a File, then handed to onFiles — so what you try
  // is what you'd get.
  const trySample = () => {
    setFetching(true);
    setSampleErr(null);
    fetch(`${import.meta.env.BASE_URL}sample-lecture.mp4`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.blob();
      })
      .then((b) => onFiles([new File([b], "sample-lecture.mp4", { type: "video/mp4" })]))
      .catch(() => {
        setFetching(false);
        setSampleErr("The sample video couldn't be downloaded. Check your connection and try again.");
      });
  };

  // The zone said "Drop a lecture video here" and only ever handled a click — dropping one did
  // nothing except make the browser navigate away to the file. These handlers are what make the
  // sentence true.
  const take = (fs: FileList | null | undefined) => {
    if (fs && fs.length > 0) onFiles([...fs]);
  };

  return (
    <div className="landing">
      <h2 className="landing-h">Watch lecture videos, enhanced.</h2>
      <p className="landing-sub">
        Highlights and smart magnification that follow the instructor's pen, so you never lose
        the place they're pointing at. Built for low-vision learners.
      </p>

      {(error || sampleErr) && (
        <div className="landing-error" role="alert">
          <b>That didn't work.</b> {error || sampleErr}
        </div>
      )}

      <button
        type="button"
        className={over ? "drop over" : "drop"}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
      >
        <IconUpload size={24} />
        <span className="drop-h">Drop a lecture video here</span>
        <small>
          MP4, WebM or MKV — playback starts in seconds while analysis keeps running.
          Have a <b>.veasyguide.json</b> moments file for it? Drop both together and skip
          the analysis.
        </small>
        <span className="drop-btn">Choose a file</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.json"
        multiple
        hidden
        onChange={(e) => take(e.target.files)}
      />

      <p className="sample">
        No video handy?{" "}
        <button type="button" className="sample-btn" onClick={trySample} disabled={fetching}>
          {fetching ? "Loading sample…" : "Try a sample lecture"}
        </button>
        {!fetching && <span className="sample-size"> (23 MB download)</span>}
      </p>

      <div className="privacy">
        <IconLock size={20} />
        <p>
          <b>Your video never leaves this device.</b> Every frame is analyzed in your browser.
          No upload, no account, no server.
        </p>
      </div>
    </div>
  );
}
