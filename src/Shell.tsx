// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The app's chrome: title bar and footer. Modelled on the chart-accessibility demo's shell so
// the two read as one body of work — plum hairline, slim white bar, italic qualifier beside the
// name, muted nav with one accent link, a human byline at the bottom.
import type { ReactNode } from "react";
import { useMantineColorScheme, useComputedColorScheme } from "@mantine/core";
import { IconBrandGithub, IconExternalLink, IconMoon, IconSun } from "@tabler/icons-react";
// Both bundled, not hotlinked from tomfluff.github.io. The landing screen promises "no upload,
// no account, no server" — a remote <img> would have the page phone out on every load, which is
// a small thing that makes a large promise false.
import avatar from "./assets/avatar.webp";
import icon from "./assets/icon.png";
import { stopPlayerHotkeys } from "./player/hotkeys";

const PROFILE = "https://tomfluff.github.io/";
const PROJECT = "https://veasyguide.github.io/";
const REPO = "https://github.com/tomfluff/veasyguide";

export function TopBar({
  file,
  status,
  onAbout,
  onChangeVideo,
  onLoadMoments,
}: {
  file?: string | null;
  status?: ReactNode;
  onAbout: () => void;
  // Back to the landing screen to pick a different file. Optional: the landing screen
  // itself has no video to change.
  onChangeVideo?: () => void;
  // Open a .veasyguide.json for the video already loaded. Optional for the same reason.
  onLoadMoments?: () => void;
}) {
  // setColorScheme flips Mantine's data attribute on <html>; index.css keys the token layer on
  // the same attribute, so the whole page follows from one switch. Mantine persists the choice
  // (localStorage) and "auto" tracks the OS until the viewer picks a side.
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  return (
    <header className="top">
      {/* The project mark is a finished tile — it brings its own colours and its own rounded
          corners, so it gets no background plate behind it. */}
      <img className="mark" src={icon} alt="" aria-hidden="true" />
      <h1 className="ttl">
        VeasyGuide <em>Lecture video, enhanced</em>
      </h1>
      {file && <span className="filechip" title={file}>{file}</span>}
      {/* The only way to open a different video used to be F5: the drop zone unmounts for
          good once a video loads. Lives beside the filename it replaces. */}
      {file && onChangeVideo && (
        <button type="button" className="filechip-change" onClick={onChangeVideo}>
          Change video
        </button>
      )}
      {/* Loading a moments file was possible but invisible: you had to already know you could
          drop one on the page. A feature nobody can find is a feature nobody has — and this
          is the one that turns a 25-minute wait into nothing, which is exactly the person
          who will not go hunting for it. Beside "Change video" because both are things you
          do TO the lecture that is open. */}
      {file && onLoadMoments && (
        <button
          type="button"
          className="filechip-change"
          onClick={onLoadMoments}
          title="Load a .veasyguide.json for this video and skip the analysis"
        >
          Load moments file
        </button>
      )}
      <span className="grow" />
      {status}
      <nav className="nav">
        {/* A button, not an anchor: it opens a dialog, it does not navigate anywhere. An <a
            href="#about"> would put a dead fragment in the URL and lie to a screen reader. */}
        <button
          type="button"
          onClick={() => setColorScheme(scheme === "dark" ? "light" : "dark")}
          onKeyDown={stopPlayerHotkeys}
          aria-label={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={scheme === "dark" ? "Light theme" : "Dark theme"}
        >
          {scheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
        </button>
        <button type="button" onClick={onAbout} onKeyDown={stopPlayerHotkeys}>About</button>
        <a className="acc" href={PROJECT} target="_blank" rel="noreferrer">
          <IconExternalLink size={16} /> Project Page
        </a>
        <a href={REPO} target="_blank" rel="noreferrer">
          <IconBrandGithub size={16} /> Code on GitHub
        </a>
      </nav>
      <a className="avatar-link" href={PROFILE} target="_blank" rel="noreferrer">
        <img className="avatar" src={avatar} alt="Yotam Sechayk" />
      </a>
    </header>
  );
}

export function Footer({ feedbackHref }: { feedbackHref: string }) {
  return (
    // A flex row, not a line of text with an inline-flex link in it: an inline-flex box takes
    // its baseline from its FIRST item — here the avatar, whose baseline is its bottom edge —
    // so the name inside it sat off the baseline of the words around it. Centring every part
    // against each other sidesteps baselines entirely.
    <footer className="foot">
      <span>Created with love and care by</span>
      <a className="foot-link" href={PROFILE} target="_blank" rel="noreferrer">
        <img className="foot-av" src={avatar} alt="" aria-hidden="true" />
        <b>Yotam Sechayk</b>
      </a>
      <span>
        — <a className="foot-mail" href={feedbackHref}>reach out</a> with any questions.
      </span>
    </footer>
  );
}
