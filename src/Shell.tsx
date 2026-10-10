// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The app's chrome: title bar and footer. Modelled on the chart-accessibility demo's shell so
// the two read as one body of work — plum hairline, slim white bar, italic qualifier beside the
// name, muted nav with one accent link, a human byline at the bottom.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Menu, useMantineColorScheme, useComputedColorScheme } from "@mantine/core";
import {
  IconBrandGithub,
  IconExternalLink,
  IconFileImport,
  IconInfoCircle,
  IconMenu2,
  IconMoon,
  IconSun,
  IconVideo,
} from "@tabler/icons-react";
// Both bundled, not hotlinked from tomfluff.github.io. The landing screen promises "no upload,
// no account, no server" — a remote <img> would have the page phone out on every load, which is
// a small thing that makes a large promise false.
import avatar from "./assets/avatar.webp";
import icon from "./assets/icon.png";
import { stopPlayerHotkeys } from "./player/hotkeys";

// Publishes how much of the window this bar takes, as a CSS variable on <html>, for the player's
// width cap (player.css): the video is sized to fit the window MINUS the real chrome. It used to
// subtract a 160px guess, which stopped being true as the bars changed and left ~100px of the
// window empty under the player on Yotam's desktop. Measured, so it follows font size, zoom and
// any later change to either bar. No feedback loop: neither bar's height depends on the player.
// `edge` "bottom" measures from the top of the page to the bar's bottom edge (the plum hairline
// above the top bar included); "height" is just the bar's own height.
function useChromeVar(ref: RefObject<HTMLElement | null>, name: string, edge: "bottom" | "height") {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => {
      const r = el.getBoundingClientRect();
      const px = edge === "bottom" ? r.bottom + window.scrollY : r.height;
      root.style.setProperty(name, `${Math.ceil(px)}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name, edge]);
}

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
  // Pick a different file (App opens a picker; dismissing it changes nothing). Optional: the
  // landing screen itself has no video to change.
  onChangeVideo?: () => void;
  // Open a .veasyguide.json for the video already loaded. Optional for the same reason.
  onLoadMoments?: () => void;
}) {
  // setColorScheme flips Mantine's data attribute on <html>; index.css keys the token layer on
  // the same attribute, so the whole page follows from one switch. Mantine persists the choice
  // (localStorage) and "auto" tracks the OS until the viewer picks a side.
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  const headerRef = useRef<HTMLElement>(null);
  useChromeVar(headerRef, "--chrome-top", "bottom");
  const toggleScheme = () => setColorScheme(scheme === "dark" ? "light" : "dark");
  // The compact menu, controlled so it can be closed from outside. The player's F key still
  // works with the menu open (it is a document-level shortcut, and the menu's items are
  // buttons, not text fields), and fullscreen shows only the player — so a menu left open
  // there is open, invisible, and holding focus nobody can see.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = () => setMenuOpen(false);
    document.addEventListener("fullscreenchange", close);
    return () => document.removeEventListener("fullscreenchange", close);
  }, []);
  return (
    // Two layouts in one bar, switched by CSS (App.css, "Narrow top bar"): the full row, and a
    // compact one — mark, status, one Menu — for windows the full row does not fit. The row
    // used to simply overflow: on a phone, or at 400% zoom, the whole PAGE scrolled sideways
    // (860px of page in a 320px window) and the player's left edge was cut off. `with-file`
    // because the bar is far wider with a lecture open, so the two states break at different
    // widths. Elements marked wide-only / narrow-only are display:none in the other layout,
    // which also takes them out of the accessibility tree, so nothing is announced twice.
    <header className={file ? "top with-file" : "top"} ref={headerRef}>
      {/* The project mark is a finished tile — it brings its own colours and its own rounded
          corners, so it gets no background plate behind it. */}
      <img className="mark" src={icon} alt="" aria-hidden="true" />
      {/* The tagline is branding, and branding matters on the landing screen — not while a
          lecture is open, when the filename is the context and the bar needs the width. */}
      <h1 className="ttl">
        VeasyGuide {!file && <em>Lecture video, enhanced</em>}
      </h1>
      {file && <span className="filechip" title={file}>{file}</span>}
      {/* The only way to open a different video used to be F5: the drop zone unmounts for
          good once a video loads. Lives beside the filename it replaces. */}
      {file && onChangeVideo && (
        <button
          type="button"
          className="filechip-change wide-only"
          onClick={onChangeVideo}
          onKeyDown={stopPlayerHotkeys}
          aria-label="Change video"
        >
          Change
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
          className="filechip-change wide-only"
          onClick={onLoadMoments}
          onKeyDown={stopPlayerHotkeys}
          aria-label="Load moments file"
          title="Load a .veasyguide.json for this video and skip the analysis"
        >
          Moments file
        </button>
      )}
      <span className="grow" />
      {status}
      <nav className="nav wide-only">
        {/* A button, not an anchor: it opens a dialog, it does not navigate anywhere. An <a
            href="#about"> would put a dead fragment in the URL and lie to a screen reader. */}
        <button
          type="button"
          onClick={toggleScheme}
          onKeyDown={stopPlayerHotkeys}
          aria-label={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={scheme === "dark" ? "Light theme" : "Dark theme"}
        >
          {scheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
        </button>
        <button type="button" onClick={onAbout} onKeyDown={stopPlayerHotkeys}>About</button>
        {/* Icon-only: both destinations also live in the About panel, so a label here pays
            ~250px of bar for links a viewer rarely follows mid-lecture. 44px targets come
            from the .nav rules; title + aria-label carry the names. */}
        <a
          className="acc"
          href={PROJECT}
          target="_blank"
          rel="noreferrer"
          aria-label="Project page"
          title="Project page"
        >
          <IconExternalLink size={18} />
        </a>
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          aria-label="Code on GitHub"
          title="Code on GitHub"
        >
          <IconBrandGithub size={18} />
        </a>
      </nav>
      {/* The compact layout's one control. Everything the full row offers, in the same order,
          behind one 44px button. Mantine's Menu brings the roles, arrow keys, Escape and focus
          return; portalled to <body>, which is fine here — the top bar is never inside the
          fullscreened player. The keys a menu uses are kept from the player's document-level
          hotkeys, as on every other button in this bar. */}
      {/* returnFocus: choosing an item, or Escape, hands focus back to this button rather than
          dropping it on <body> — a keyboard user stays where they were. */}
      <Menu
        position="bottom-end"
        width={260}
        classNames={{ dropdown: "top-menu" }}
        returnFocus
        opened={menuOpen}
        onChange={setMenuOpen}
      >
        <Menu.Target>
          <button
            type="button"
            ref={menuBtnRef}
            className="top-menu-btn narrow-only"
            aria-label="Menu"
            onKeyDown={stopPlayerHotkeys}
          >
            <IconMenu2 size={22} />
          </button>
        </Menu.Target>
        <Menu.Dropdown onKeyDown={stopPlayerHotkeys}>
          {/* The full filename, which the compact bar truncates or drops. A label, not an
              item: it is information, and an item would be a stop that does nothing. */}
          {file && <Menu.Label className="top-menu-file">{file}</Menu.Label>}
          {file && onChangeVideo && (
            <Menu.Item leftSection={<IconVideo size={18} />} onClick={onChangeVideo}>
              Change video
            </Menu.Item>
          )}
          {file && onLoadMoments && (
            <Menu.Item leftSection={<IconFileImport size={18} />} onClick={onLoadMoments}>
              Load moments file
            </Menu.Item>
          )}
          {file && <Menu.Divider />}
          <Menu.Item
            leftSection={scheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
            onClick={toggleScheme}
          >
            {scheme === "dark" ? "Light theme" : "Dark theme"}
          </Menu.Item>
          {/* Focus the Menu button BEFORE the dialog opens. A modal <dialog> returns focus on
              close to whatever had it when showModal() ran — here the menu item, which is gone
              by then, so focus fell to <body> and one Tab landed in the player. */}
          <Menu.Item
            leftSection={<IconInfoCircle size={18} />}
            onClick={() => {
              menuBtnRef.current?.focus();
              onAbout();
            }}
          >
            About
          </Menu.Item>
          <Menu.Item
            component="a"
            href={PROJECT}
            target="_blank"
            rel="noreferrer"
            leftSection={<IconExternalLink size={18} />}
          >
            Project page
          </Menu.Item>
          <Menu.Item
            component="a"
            href={REPO}
            target="_blank"
            rel="noreferrer"
            leftSection={<IconBrandGithub size={18} />}
          >
            Code on GitHub
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {/* Not in the compact bar: the same profile link is in the footer. */}
      <a className="avatar-link wide-only" href={PROFILE} target="_blank" rel="noreferrer">
        <img className="avatar" src={avatar} alt="Yotam Sechayk" />
      </a>
    </header>
  );
}

export function Footer({ feedbackHref }: { feedbackHref: string }) {
  const footRef = useRef<HTMLElement>(null);
  useChromeVar(footRef, "--chrome-foot", "height");
  return (
    // A flex row, not a line of text with an inline-flex link in it: an inline-flex box takes
    // its baseline from its FIRST item — here the avatar, whose baseline is its bottom edge —
    // so the name inside it sat off the baseline of the words around it. Centring every part
    // against each other sidesteps baselines entirely.
    <footer className="foot" ref={footRef}>
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
