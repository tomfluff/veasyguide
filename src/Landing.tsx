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

      {error && (
        <div className="landing-error" role="alert">
          <b>That didn't work.</b> {error}
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
