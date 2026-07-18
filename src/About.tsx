// About, as a native <dialog>.
//
// Not a route: a route would unmount the player, and with it the analysis — you would lose a
// half-analyzed lecture by reading about the tool that was analyzing it. <dialog> also brings
// focus trapping, Esc-to-close and a backdrop for free, which is the whole reason not to
// hand-roll an overlay.
import { useEffect, useRef } from "react";
import { IconX } from "@tabler/icons-react";

const KEYS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← / →", "Back / forward 5 seconds"],
  ["[ / ]", "Previous / next moment"],
  ["< / >", "Slower / faster playback"],
  ["Z", "Toggle magnification"],
  ["P", "Pin / dismiss a snapshot of the latest writing"],
  ["↑ / ↓", "Zoom in / out"],
  ["M", "Mute"],
  ["F", "Fullscreen"],
];

export default function About({
  open,
  onClose,
  feedbackHref,
}: {
  open: boolean;
  onClose: () => void;
  // Built lazily by the caller: the mailto body carries analysis diagnostics that change as
  // the analyzer runs, so the href is composed at render, not baked in.
  feedbackHref: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // showModal() is what makes it modal — a plain `open` attribute renders the dialog inline,
  // with no backdrop, no focus trap and no Esc.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about"
      onClose={onClose}
      // Esc is free; clicking the backdrop is not. The backdrop is not a separate element — it
      // is the dialog's own ::backdrop — so a click out there still targets the dialog itself,
      // which is exactly what distinguishes it from a click on the content inside.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <button type="button" className="about-x" onClick={onClose} aria-label="Close">
        <IconX size={18} />
      </button>

      <h2>About VeasyGuide</h2>
      <p className="about-lede">
        Lecture videos are hard to follow when you cannot see where the instructor is pointing.
        VeasyGuide watches the video for you: it finds every moment the instructor writes,
        points, or sketches, then highlights that spot and magnifies it as you watch. Built for
        low-vision learners; useful to anyone who has lost the thread of a lecture.
      </p>

      <h3>How it works</h3>
      <p>
        Conventional wisdom says content-aware video accessibility needs a machine-learning model,
        and therefore a server. For slide-based lecture video it doesn't: on a slide,{" "}
        <b>whatever changes is whatever matters</b>. A pen stroke, a cursor, a sketch — they are
        the only things moving against a static slide. So VeasyGuide compares sampled frames,
        groups the changed regions into events, and that is the detection. No model, no training,
        nothing to download.
      </p>
      <p>
        That constraint is the feature. Because there is no model, the whole thing runs in your
        browser — which is why <b>your video never leaves this device</b>. It is not uploaded, not
        stored, and no server ever sees it. There is no account, and there is no backend to have
        one.
      </p>

      <h3>Keyboard</h3>
      <dl className="about-keys">
        {KEYS.map(([k, what]) => (
          <div key={k}>
            <dt><kbd>{k}</kbd></dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>

      <h3>Moments files</h3>
      <p>
        When analysis finishes, the sidebar can save a small <b>.veasyguide.json</b> moments
        file. Drop it in with the same video later — or hand it to a classmate — and playback
        starts instantly, no re-analysis. If a video is already open you can drop the file on
        its own, even mid-analysis, and it takes over. Finished analyses are also remembered
        on this device. Either way the file holds timestamps and coordinates, never the video;
        there's a Markdown export too, for notes.
      </p>

      <h3>What it needs</h3>
      <p>
        A Chromium browser — Chrome, Edge or Arc — is what it's built and tested against, so
        that's the smoothest ride. Other modern browsers generally work; you may just find
        analysis slower or the odd rough edge, since decoding leans on WebCodecs and support for
        it is newer outside Chromium.
      </p>
      <p>
        Your video also has to be in a codec your machine can decode: H.264, VP9 and AV1 work;
        HEVC/H.265 often doesn't. If it can't be decoded you're told so by name, rather than left
        waiting.
      </p>
      <p className="about-note">
        Analysis speed depends on your hardware. Playback starts as soon as the first 10 seconds
        are ready and the analysis keeps running ahead of you, so a long lecture doesn't mean a
        long wait.
      </p>

      <h3>Where it came from</h3>
      <p>
        VeasyGuide is the successor to a research study on lecture-video accessibility for
        low-vision learners. The detection pipeline and the player were validated in that study
        and then locked inside a lab rig — analysis ran as an offline script, results were
        pre-computed, and nobody outside the study could use any of it. This is that work, rebuilt
        so that anyone can just open it and drop in a video.
      </p>
      <p>
        Built by{" "}
        <a href="https://tomfluff.github.io/" target="_blank" rel="noreferrer">
          Yotam Sechayk
        </a>
        . The source is{" "}
        <a href="https://github.com/tomfluff" target="_blank" rel="noreferrer">
          on GitHub
        </a>
        .
      </p>

      <h3>Feedback</h3>
      <p>
        Found a bug, or a lecture it handles badly?{" "}
        <a href={feedbackHref}>Send feedback by email</a>. The draft includes a few technical
        details (browser, video length and resolution, what the analysis found — never the video
        or its name); it opens in your own mail app, so you can read and edit everything before
        deciding to send it.
      </p>
    </dialog>
  );
}
