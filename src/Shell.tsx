// The app's chrome: title bar and footer. Modelled on the chart-accessibility demo's shell so
// the two read as one body of work — plum hairline, slim white bar, italic qualifier beside the
// name, muted nav with one accent link, a human byline at the bottom.
import type { ReactNode } from "react";
import { IconBrandGithub, IconExternalLink } from "@tabler/icons-react";
// Bundled, not hotlinked from tomfluff.github.io. The landing screen promises "no upload, no
// account, no server" — a remote <img> would have the page phone out on every load, which is a
// small thing that makes a large promise false.
import avatar from "./assets/avatar.webp";

export function TopBar({ file, status }: { file?: string | null; status?: ReactNode }) {
  return (
    <header className="top">
      <span className="mark" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="1" y="1" width="14" height="14" rx="1.5" />
          <path d="M1 6h14M6 1v14" />
        </svg>
      </span>
      <h1 className="ttl">
        veasyguide <em>Lecture video, enhanced</em>
      </h1>
      {file && <span className="filechip" title={file}>{file}</span>}
      <span className="grow" />
      {status}
      <nav className="nav">
        <a href="#about">About</a>
        <a className="acc" href="https://github.com/" target="_blank" rel="noreferrer">
          <IconExternalLink size={16} /> Project Page
        </a>
        <a href="https://github.com/" target="_blank" rel="noreferrer">
          <IconBrandGithub size={16} /> Code on GitHub
        </a>
      </nav>
      <img className="avatar" src={avatar} alt="Yotam Sechayk" />
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      Created with love and care by{" "}
      <img className="foot-av" src={avatar} alt="" aria-hidden="true" />
      <b>Yotam Sechayk</b> — reach out with any questions.
    </footer>
  );
}
