// The app's chrome: title bar and footer. Modelled on the chart-accessibility demo's shell so
// the two read as one body of work — plum hairline, slim white bar, italic qualifier beside the
// name, muted nav with one accent link, a human byline at the bottom.
import type { ReactNode } from "react";
import { IconBrandGithub, IconExternalLink } from "@tabler/icons-react";
// Both bundled, not hotlinked from tomfluff.github.io. The landing screen promises "no upload,
// no account, no server" — a remote <img> would have the page phone out on every load, which is
// a small thing that makes a large promise false.
import avatar from "./assets/avatar.webp";
import icon from "./assets/icon.png";

const PROFILE = "https://tomfluff.github.io/";

export function TopBar({ file, status }: { file?: string | null; status?: ReactNode }) {
  return (
    <header className="top">
      {/* The project mark is a finished tile — it brings its own colours and its own rounded
          corners, so it gets no background plate behind it. */}
      <img className="mark" src={icon} alt="" aria-hidden="true" />
      <h1 className="ttl">
        veasyguide <em>Lecture video, enhanced</em>
      </h1>
      {file && <span className="filechip" title={file}>{file}</span>}
      <span className="grow" />
      {status}
      <nav className="nav">
        <a href="#about">About</a>
        <a className="acc" href={PROFILE} target="_blank" rel="noreferrer">
          <IconExternalLink size={16} /> Project Page
        </a>
        <a href="https://github.com/tomfluff" target="_blank" rel="noreferrer">
          <IconBrandGithub size={16} /> Code on GitHub
        </a>
      </nav>
      <a className="avatar-link" href={PROFILE} target="_blank" rel="noreferrer">
        <img className="avatar" src={avatar} alt="Yotam Sechayk" />
      </a>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      Created with love and care by{" "}
      <a className="foot-link" href={PROFILE} target="_blank" rel="noreferrer">
        <img className="foot-av" src={avatar} alt="" aria-hidden="true" />
        <b>Yotam Sechayk</b>
      </a>{" "}
      — reach out with any questions.
    </footer>
  );
}
