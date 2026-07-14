// First contact. Someone is about to hand a stranger's website their lecture, so the privacy
// promise gets a real box, not a footnote — it is the reason they'd trust this at all.
//
// The three-step explainer from the mockup is deliberately cut: it explained the app to people
// who have not used it yet, which is the one audience that cannot check whether it is true. The
// drop zone and the promise are what the screen is for.
import { useRef, useState } from "react";
import { IconLock, IconUpload } from "@tabler/icons-react";

export default function Landing({ onFile, error }: { onFile: (f: File) => void; error?: string | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  // The zone said "Drop a lecture video here" and only ever handled a click — dropping one did
  // nothing except make the browser navigate away to the file. These handlers are what make the
  // sentence true.
  const take = (f: File | undefined) => {
    if (f) onFile(f);
  };

  return (
    <div className="landing">
      <h2 className="landing-h">Watch lecture videos, enhanced.</h2>
      <p className="landing-sub">
        Highlights and smart magnification that follow the instructor's pen, so you never lose
        the place they're pointing at. Built for low-vision learners.
      </p>

      {error && (
        <div className="landing-error" role="alert">
          <b>That video didn't work.</b> {error}
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
          take(e.dataTransfer.files[0]);
        }}
      >
        <IconUpload size={30} />
        <span className="drop-h">Drop a lecture video here</span>
        <small>MP4, WebM or MKV — playback starts in seconds while analysis keeps running</small>
        <span className="drop-btn">Choose a file</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => take(e.target.files?.[0])}
      />

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
