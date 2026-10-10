// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Ported from VeasyGuide VideoPlayer, adapted for streaming analysis. Study-only
// features stripped: prompt-to-click, action logging, ding audio, module wiring.
//
// Fixes vs original:
// - `leftShirt` typo; duplicated allowControls check in handleTimeShift
// - fullscreen requested on the player container, not document.body (the original
//   README documents a Chrome bug where body-fullscreen shifts non-16:9 video)
// - timeline tooltip guarded against NaN% before the container ref exists
// - settings popover width fixed (was window.devicePixelRatio * 17.5vw — the
//   panel width depended on the user's display scaling)
// - highlight/zoom tracking driven by requestVideoFrameCallback when available
//   (timeupdate only fires ~4 Hz, which made the highlight visibly lag the pen)
//
// New for streaming: analyzed-ranges shading in the timeline, playback gate and
// "analyzing this part" state, activity selection via analyzer/select.ts.
//
// A scene change notifies the viewer and otherwise leaves the player alone. It used to
// force a zoom-out and drop the stable activity; that traded a stale highlight for a
// worse disruption — being yanked out of a magnified view mid-explanation — and scene
// detection is a heuristic that fires on build animations and camera moves too.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, Group, UnstyledButton, Popover, Menu } from "@mantine/core";
import {
  useElementSize,
  useDisclosure,
  useHotkeys,
  type HotkeyItem,
  useMergedRef,
  useMouse,
  useTimeout,
} from "@mantine/hooks";
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconGauge,
  IconLayoutDistributeHorizontal,
  IconPlayerPlayFilled,
  IconPlayerPauseFilled,
  IconMaximize,
  IconMaximizeOff,
  IconSparkles,
  IconVolume as IconVolumeHigh,
  IconVolume2 as IconVolumeLow,
  IconVolumeOff as IconVolumeMute,
  IconArrowBigLeftLineFilled,
  IconArrowBigRightLineFilled,
  IconZoom,
  IconZoomInAreaFilled,
  IconSwitchHorizontal,
  IconPinFilled,
  IconX,
  IconPlayerTrackPrevFilled,
  IconPlayerTrackNextFilled,
  IconChevronDown,
  IconChevronUp,
  IconListDetails,
} from "@tabler/icons-react";
import classNames from "classnames";
import { convertSecondsToTimecode } from "../utils/misc";
import { selectActivity, type SelectOpts } from "../analyzer/select";
import { isAnalyzed } from "../analyzer/ranges";
import type { Activity, AnalysisMeta, Range, Scene } from "../analyzer/types";
import { toPlayerActivity } from "./types";
import { computeLetterbox } from "./geometry";
import { timelineMarkers, stepMoment, seekTargetFor } from "./moments";
import { momentDescription, momentPlace } from "./describe";
import { cropRect } from "../analyzer/snippets";
import MomentsSidebar from "../MomentsSidebar";
import AppearanceSheet from "./AppearanceSheet";
import HighlightIndicator from "./HighlightIndicator";
import MagnificationOverlay from "./MagnificationOverlay";
import SVGFilters from "./SVGFilters";
import { stopPlayerHotkeys } from "./hotkeys";
import PlayerTip from "./PlayerTip";
import { PlayerTipRoot } from "./tipRoot";
import { useMagnificationSettingsStore } from "../stores/MagnificationSettingsStore";
import {
  useViewSettingsStore, setPlaybackRate,
  setPinSize, setPinCorner, nextPinSize, nextPinCorner, PIN_SIZE_NAMES, PIN_CORNER_NAMES,
} from "../stores/ViewSettingsStore";

import "./player.css";

type Props = {
  src: string;
  meta: AnalysisMeta;
  // The moments: already filtered and sorted by App (analyzer/select.ts `validActivities`).
  // The player, the timeline markers and the moments sidebar all read this same list, so
  // they cannot disagree about which moments exist or what each one is numbered.
  activities: Activity[];
  scenes: Scene[];
  ranges: Range[];
  done: boolean;
  canPlay: boolean;
  // Analysis throughput, for the pre-playback scrim. Everything else the scrim shows
  // (coverage, moments found) the player can already derive from ranges/activities.
  xRealtime?: number;
  selectOpts: SelectOpts;
  // `byViewer` is false for the seeks the player makes on its own (the Appearance preview jump
  // and the step back from it). Those are not the viewer choosing a place, so App must not
  // treat them as an answer to the resume offer or as a position worth saving (D33).
  onSeeked?: (t: number, byViewer: boolean) => void;
  // While the Appearance preview has moved the playhead, where the viewer actually is — the
  // place it will step back to. null once it has. App saves THIS as the resume position if the
  // page goes away mid-preview, never the moment it was parked on to show the changes.
  // When it lets go (returnTo null), `nowAt` is where the playhead is going — the restore, or
  // the viewer's own seek — so App's bookmark has the right place even in the moment before
  // the seek lands and the time callback catches up (a save there used to record the preview).
  onPreviewJump?: (returnTo: number | null, nowAt?: number) => void;
  onTimeChange?: (t: number) => void;
  // Play/pause as the element reports it. App needs both edges for the resume position: play
  // is the viewer answering the resume offer by doing something else, and pause is a moment
  // worth saving where they are.
  onPlayingChange?: (playing: boolean) => void;
  // "Resume at 12:34?" (D33). App owns the saved position and decides when to offer it; the
  // player only draws it, on the video, so offering it moves nothing on the page.
  resumeOffer?: { at: number; onResume: () => void; onRestart: () => void } | null;
  // Fires only when the highlighted moment CHANGES — not per frame. The moments sidebar
  // needs to know which card is current, and only the player derives that (it runs
  // selectActivity on the rVFC loop; App sees time at a 0.2s throttle). Re-deriving it in
  // App would let the highlighted card drift from the highlight on the video.
  onActivityChange?: (activity: Activity | null) => void;
  // Moment thumbnails (App generates them; see App's snippet-worker effect). The player
  // needs them for the fullscreen moments overlay — the page sidebar is outside the
  // fullscreened container and simply is not there.
  thumbs?: ReadonlyMap<number, string>;
  // Assigned a seek function so external UI (debug views) can move the playhead.
  seekFnRef?: React.MutableRefObject<(t: number) => void>;
  extraHud?: ReactNode;
};

const EMPTY_THUMBS: ReadonlyMap<number, string> = new Map();

const FLASH_SPEED = 250;
const SCENE_NOTICE_MS = 2500;

// The keys that must NOT summon the control bar, because the control they operate is not in it:
// zoom is drawn on the video with its own indicator, [ / ] are navigation, and C / S move and
// resize the pinned snapshot, whose buttons live on the panel itself. Kept as one set so the
// hotkey table and the container's onKeyDown cannot drift apart and disagree. Both `z` and `Z`
// — the container sees the raw event.key, so Shift and CapsLock both reach it.
const NO_REVEAL_KEYS = new Set([
  "z", "Z", "p", "P", "c", "C", "s", "S", "ArrowUp", "ArrowDown", "[", "]",
]);

// Seconds of analysis before playback unlocks. Lives here because the pre-playback gate
// PROMISES this number on screen ("the first 10 seconds"), and App gates `canPlay` on it —
// two copies would be two chances for the promise and the behaviour to drift apart.
export const PLAYBACK_LEAD = 10;

// Whether this browser draws a range input vertically under `writing-mode: vertical-lr`.
// Chromium only does from 124 (2024), Safari and Firefox from about the same time; an older
// one keeps drawing it horizontally, squeezed into the volume popover's 24px-wide box, while
// aria-orientation still claims vertical. A CSS-only test cannot tell (writing-mode itself is
// supported everywhere), so measure an unstyled one: a vertical range is taller than wide.
// Once per page; the answer cannot change under us.
let verticalRangeSupport: boolean | null = null;
function supportsVerticalRange(): boolean {
  if (verticalRangeSupport !== null) return verticalRangeSupport;
  const probe = document.createElement("input");
  probe.type = "range";
  probe.style.cssText = "writing-mode: vertical-lr; position: absolute; visibility: hidden";
  document.body.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  verticalRangeSupport = r.height > r.width;
  return verticalRangeSupport;
}

const VideoPlayer = (props: Props) => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  // Fullscreen is requested on the container; the overlay geometry measures the <video>
  // element. They are NOT the same rectangle: windowed, the control bar sits in flow below the
  // video, inside the container. That is safe because nothing measures the container — the
  // highlight math reads the <video> box, and every layer drawn over the picture lives in
  // .video-stage, which is exactly the video's box.
  const containerRef = useRef<HTMLDivElement>(null);
  // The same element again, as STATE, for the tooltips to portal into (tipRoot.ts). A ref
  // would not do: the tips render before the container has mounted, and only a re-render
  // hands them the element once it exists.
  const [tipRoot, setTipRoot] = useState<HTMLDivElement | null>(null);
  const containerMergedRef = useMergedRef(containerRef, setTipRoot);
  const {
    ref: videoSizeRef,
    width: boxWidth,
    height: boxHeight,
  } = useElementSize<HTMLVideoElement>();
  const videoMergedRef = useMergedRef(videoRef, videoSizeRef);
  // The moments overlay anchors just above the control bar, whose height depends on
  // collapsed state and the window's width (the controls wrap) — so it is measured.
  const { ref: barSizeRef, height: barHeight } = useElementSize<HTMLDivElement>();

  // State
  const [volume, setVolume] = useState(1);
  const [currTime, setCurrTime] = useState(0);
  const [currActivity, setCurrActivity] = useState<Activity | null>(null);
  const [stableActivity, setStableActivity] = useState<Activity | null>(null);
  const [backShiftRequest, setBackShiftRequest] = useState(false);
  const [forwardShiftRequest, setForwardShiftRequest] = useState(false);
  const [isPlaying, handleIsPlaying] = useDisclosure(false);
  const [isEnded, handleIsEnded] = useDisclosure(false);
  const [isMuted, handleIsMuted] = useDisclosure(false);
  const [isZoomIn, handleIsZoomIn] = useDisclosure(false);
  const [isFullscreen, handleIsFullscreen] = useDisclosure(false);
  const [hideControls, handleHideControls] = useDisclosure(false);
  // Fullscreen only (D32). Windowed, the bar is in flow under the picture, so collapsing it
  // changed the bar's height — and the player's width cap subtracts that height, so the whole
  // player resized under the viewer's pointer. Windowed is always expanded; this state is only
  // ever true while fullscreen, and is never persisted.
  const [collapsed, handleCollapsed] = useDisclosure(false);
  // Fullscreen-only: the moments list summoned as an overlay inside the player.
  const [momentsOpen, handleMomentsOpen] = useDisclosure(false);
  const [sceneNoticeVisible, setSceneNoticeVisible] = useState(false);
  const currSceneStartRef = useRef<number | null>(null);
  const prevTimeRef = useRef(0);
  const lastReportedActivityRef = useRef<number | null>(null);
  const chromeTimeRef = useRef(-1);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  // Tracked only so the resume card knows to wait while it is open (see .resume-slot).
  const [speedOpen, setSpeedOpen] = useState(false);
  const [previewJumped, setPreviewJumped] = useState(false);
  // For the "Magnifier on · 1.7×" chip; same 1 + strength display the Appearance sheet uses.
  const zoomStrength = useMagnificationSettingsStore((s) => s.zoom_strength);
  // Study pace: persisted playback rate + what happens at a moment's end (tempo engine).
  const playbackRate = useViewSettingsStore((s) => s.playbackRate);
  // Gates the pill at RENDER as well as at the trigger, so switching it off takes one
  // already-showing notice off the screen instead of leaving it for its 2.5 seconds.
  const sceneNotice = useViewSettingsStore((s) => s.sceneNotice);
  const pinSize = useViewSettingsStore((s) => s.pinSize);
  const pinCorner = useViewSettingsStore((s) => s.pinCorner);
  // WCAG 2.1.4: every single-character shortcut can be switched off (the sidebar's footer).
  // A speech-input user saying an ordinary word otherwise fires a dozen player actions.
  const letterShortcuts = useViewSettingsStore((s) => s.letterShortcuts);
  const insideMomentRef = useRef<Activity | null>(null); // raw in-moment tracking (no lead/linger)
  // Pinned snapshot: a full-res crop of a moment's final ink, captured from the live video
  // element the instant playback crosses the moment's end (the end frame is what's on screen
  // right then — no seeking needed). The newest capture is kept even when nothing is pinned,
  // so P after a moment has passed still shows what was just written.
  const lastEndFrameRef = useRef<{ activity: Activity; url: string } | null>(null);
  const [pinned, setPinned] = useState<{ activity: Activity; url: string } | null>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  // Where the viewer was before we jumped them to a moment to preview against.
  const preAppearanceTimeRef = useRef<number | null>(null);
  // The target of a seek the player made itself, so its `seeked` can be told apart from one
  // the viewer made. Matched by time rather than a boolean: a viewer seek that lands while
  // ours is still in flight must still count as theirs.
  const ownSeekRef = useRef<number | null>(null);

  // The bar only ever hides in fullscreen. Windowed, it sits BELOW the video, in flow, and covers
  // nothing — it used to overlay the bottom of the picture, which on a lecture is exactly where
  // the instructor writes last, and viewers reported it masking the writing. Fullscreen has no
  // room below the picture, so there it overlays, and it hides even while paused: a paused
  // frame is a frame someone is READING, and the bar over its bottom strip is the same mask.
  // Any pointer movement, key or focus brings it back (see the container's handlers). D32.
  const barHidden = hideControls && isFullscreen;
  const videoContainerClasses = classNames("video-container", {
    clear: barHidden,
    collapsed: collapsed && isFullscreen,
    fullscreen: isFullscreen,
  });
  // How much of the picture's bottom edge the bar covers. Windowed it covers none of it, so
  // the things docked at the bottom of the picture (the pinned snapshot, the preview notice)
  // sit at the same small inset as their top-docked counterparts instead of a bar's height up.
  const barOverlap = isFullscreen ? barHeight : 0;

  // Hooks and interactivity
  const { ref: timelineContainerRef, x: timelineX } = useMouse<HTMLDivElement>();
  // Marker layout needs the track's real pixel width: a moment's mark gets a minimum width,
  // and whether two marks collide depends on how wide the track actually is.
  const { ref: trackSizeRef, width: trackWidth } = useElementSize<HTMLDivElement>();
  const trackRef = useMergedRef(timelineContainerRef, trackSizeRef);
  const { start: startBackShiftTimeout, clear: clearBackShiftTimeout } = useTimeout(
    () => setBackShiftRequest(false),
    FLASH_SPEED
  );
  const { start: startForwardShiftTimeout, clear: clearForwardShiftTimeout } =
    useTimeout(() => setForwardShiftRequest(false), FLASH_SPEED);
  const { start: startHideControlsTimeout, clear: clearHideControlsTimeout } =
    // Never hide the bar out from under keyboard focus: a keyboard user parked on a control
    // is USING the bar even though no events are firing. Just skip — re-arming from inside
    // the callback is a no-op (Mantine's useTimeout still holds its ref while the callback
    // runs); the container's onBlurCapture restarts the timer when focus leaves.
    //
    // Nor out from under a resting pointer. A pointer parked on a bar button, or on the tip it
    // opened, is someone reading the tip — and the tip goes with the bar, which made it fail
    // WCAG 1.4.13's "persistent" (it vanished after 1.6s with the pointer still on it). Moving
    // off the bar onto the picture is a mousemove, which restarts this timer as usual.
    //
    // KEYBOARD focus, that is: `:focus-visible`. A mouse click on a bar button leaves focus on
    // it too, and counting that as "using the bar" meant entering fullscreen by clicking the
    // button parked focus on "Exit fullscreen" and the bar never hid again. And never while
    // one of the bar's own dropdowns (the Appearance sheet, the speed menu) is open: they live
    // inside the bar, so hiding it would take the sheet away from someone reading it.
    useTimeout(() => {
      const bar = barSizeRef.current;
      const active = document.activeElement;
      if (bar && active && bar.contains(active) && active.matches(":focus-visible")) return;
      if (bar?.querySelector(".ap-pop, .bar-pop")) return;
      if (bar?.matches(":hover") || containerRef.current?.querySelector(".player-tip:hover")) return;
      handleHideControls.open();
    }, 2000);
  const { start: startSceneNoticeTimeout, clear: clearSceneNoticeTimeout } = useTimeout(
    () => setSceneNoticeVisible(false),
    SCENE_NOTICE_MS
  );
  // A key reveals the bar only when THE CONTROL IT OPERATED LIVES IN THE BAR. That is the whole
  // test. Play/pause, mute, the scrubber and fullscreen are all in there, so those keys show you
  // what they just changed. Zoom and moment-stepping are not: the magnifier has its own on-video
  // indicator and the bar carries no zoom control at all, while stepping is navigation. Popping
  // the chrome up for those covers the lecture and tells you nothing about what happened.
  //
  // The reveal sits on the actions rather than on a document-wide keydown listener, which would
  // summon the bar for keys that have nothing to do with the player. (It used to sit on the
  // container's onKeyDown, which missed the ordinary case entirely: clicking the video surface
  // to play leaves focus on <body>, because that surface is a plain div and takes no focus.)
  //
  // The handlers below are `const` arrows declared further down the component, so `fn` must be
  // called lazily — passing the identifier here instead would read it in its temporal dead zone
  // and throw on the first render.
  const reveal = (fn: () => void) => () => {
    showControls();
    fn();
  };
  // Two tables, because WCAG 2.1.4 draws the line between them (D31). Space and the arrows are not
  // character keys — a spoken word never produces them — and they are how the player is driven
  // at all without a pointer, so they are always on. Every printable-character key is in the
  // second table, which the viewer can switch off.
  useHotkeys([
    ["Space", reveal(() => handlePlayPause())],
    ["ArrowLeft", reveal(() => handleTimeShift(-5))],
    ["ArrowRight", reveal(() => handleTimeShift(5))],
    // No reveal — the magnifier is drawn on the video and has its own indicator; the bar has
    // no zoom control to show you. Kept in step with NO_REVEAL_KEYS above.
    ["ArrowUp", () => handleZoomShift(0.1)],
    ["ArrowDown", () => handleZoomShift(-0.1)],
    ...(letterShortcuts
      ? ([
          ["F", reveal(() => handleFullscreen())],
          ["M", reveal(() => handleMute())],
          ["Z", () => handleZoom()],
          ["P", () => handlePin()],
          // Appearance and the moments list both open from the bar, so both reveal it: a
          // hidden bar is opacity 0 and pointer-events none, and the sheet is anchored inside it.
          ["A", reveal(() => handleAppearanceOpen(!appearanceOpen))],
          ["L", () => handleMomentsKey()],
          // The snapshot's own buttons, as keys. Only while something is pinned — with no panel
          // there is nothing to move, and silently rewriting a stored preference the viewer
          // cannot see change would be worse than doing nothing. No reveal: the panel is not in
          // the bar, and it shows its own change. Read from the store, not the render closure,
          // so key-repeat cycles rather than recomputing one step from a stale value.
          ["C", () => {
            if (pinnedRef.current) setPinCorner(nextPinCorner(useViewSettingsStore.getState().pinCorner));
          }],
          ["S", () => {
            if (pinnedRef.current) setPinSize(nextPinSize(useViewSettingsStore.getState().pinSize));
          }],
          // Mantine matches on event.key, which for these is literally "[" and "]" — not the
          // KeyboardEvent.code names ("BracketLeft"/"BracketRight"), which never match.
          ["[", () => handleStepMoment(-1)],
          ["]", () => handleStepMoment(1)],
          // Shift+comma/period arrive as "<"/">" in event.key — but the Shift modifier must ALSO
          // be declared, or Mantine rejects the match for having an undeclared modifier down.
          ["shift+<", reveal(() => handleRateStep(-1))],
          ["shift+>", reveal(() => handleRateStep(1))],
        ] as HotkeyItem[])
      : []),
  ]);

  // The rates every mainstream player offers, plus a study-slow 0.5. Stepping clamps at the
  // ends rather than wrapping — "faster" must never surprise you with half speed. Reads the
  // store, not the render closure: key-repeat outruns re-render, and N repeats from a stale
  // value would all compute the same single step.
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const handleRateStep = (dir: 1 | -1) => {
    const cur = useViewSettingsStore.getState().playbackRate;
    const i = RATES.findIndex((r) => r >= cur - 1e-6);
    const at = i === -1 ? RATES.length - 1 : i;
    setPlaybackRate(RATES[Math.min(RATES.length - 1, Math.max(0, at + dir))]);
  };

  // Computed
  const totalTime = props.meta.duration;
  const videoWidth = props.meta.videoWidth;
  const videoHeight = props.meta.videoHeight;
  const { leftShift, topShift, scaleRatio } = useMemo(
    () => computeLetterbox(boxWidth, boxHeight, videoWidth, videoHeight),
    [boxWidth, boxHeight, videoWidth, videoHeight]
  );

  const atUnanalyzed = !props.done && !isAnalyzed(props.ranges, currTime);

  // The marks under the scrubber. Recomputed only when the moment list or the track width
  // changes — NOT on every presented frame.
  const markers = useMemo(
    () => timelineMarkers(props.activities, totalTime, trackWidth),
    [props.activities, totalTime, trackWidth]
  );
  // Which moment is current, taken from the player's own selection rather than re-derived —
  // otherwise the lit-up mark and the highlight on the video disagree by `lead` seconds.
  const currIndex = currActivity ? props.activities.indexOf(currActivity) : -1;

  // The status region's moment sentence (see it in the bar below). Set when a moment starts and
  // left alone when it ends, so each moment is one announcement. "Next at" is the moment after
  // THIS one — from the list, not from the playhead, which sits `lead` seconds before the start
  // when the moment is selected and would name the current moment as the next.
  //
  // Keyed on ENTERING a moment — the activity object becoming current — not on its index. An
  // index shifts when a backfill finds an earlier moment while the viewer sits in this one, and
  // that is not news; going back into the same moment after a gap IS, even though the sentence
  // is the same — so each entry bumps `momentEntry`, which remounts the text node and makes it
  // a fresh addition to the live region rather than a no-op rewrite of identical text.
  const [momentSpoken, setMomentSpoken] = useState("");
  const [momentEntry, setMomentEntry] = useState(0);
  useEffect(() => {
    if (!currActivity || currIndex < 0) return;
    const a = currActivity;
    const next = props.activities[currIndex + 1];
    // "Next at ..." is a lie while the video after this moment is still unanalyzed: the next
    // moment by time may simply not exist yet. Say nothing rather than point at the wrong one.
    const known = next && (props.done || isAnalyzed(props.ranges, next.start));
    setMomentSpoken(
      `Moment ${currIndex + 1}${props.done ? ` of ${props.activities.length}` : ""}, ` +
        `${momentPlace(a, props.meta.analysisWidth, props.meta.analysisHeight)}, ` +
        `${convertSecondsToTimecode(a.start)}, ${(a.end - a.start).toFixed(1)} seconds.` +
        (known ? ` Next at ${convertSecondsToTimecode(next.start)}.` : "")
    );
    setMomentEntry((n) => n + 1);
    // Only on entering a moment: re-announcing because the analysis found another moment, or
    // the playhead moved, is exactly the churn this exists to stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currActivity]);

  // The magnifier's own announcement, in its own live region (below). A role=status region is
  // atomic, so sharing one with the moment sentence re-read the whole sentence on every Z, and
  // switching it off just removed the words — silence where "off" should be. Empty until the
  // first change, so loading a video announces nothing about a magnifier nobody touched.
  // A strength change counts only while magnifying (↑/↓, or the sheet's slider with the
  // magnifier on); with it off, moving the slider is not the magnifier changing.
  const [zoomSpoken, setZoomSpoken] = useState("");
  const prevZoomRef = useRef(isZoomIn);
  useEffect(() => {
    const toggled = prevZoomRef.current !== isZoomIn;
    prevZoomRef.current = isZoomIn;
    if (!toggled && !isZoomIn) return;
    if (!toggled && zoomSpoken === "") return; // first run: nothing has changed yet
    setZoomSpoken(isZoomIn ? `Magnifier on, ${(1 + zoomStrength).toFixed(1)} times.` : "Magnifier off.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isZoomIn, zoomStrength]);

  // Helper functions
  const showControls = () => {
    clearHideControlsTimeout();
    handleHideControls.close();
    startHideControlsTimeout();
  };

  // Auto-hide is only safe because it is NOT pointer-only. A keyboard user who tabs in, a
  // viewer who pauses, and anyone who presses a key all get the bar back. Hidden-until-you-
  // move-a-mouse would delete this feature for exactly the people it is built for.
  const handleStepMoment = (dir: 1 | -1) => {
    const video = videoRef.current;
    if (!video || !props.canPlay) return;
    // Read the playhead from the ELEMENT, not from `currTime`. That state is throttled to
    // ~10Hz and only catches up when the video presents a frame — so while paused, or on
    // rapid repeated presses, it is stale, and every press after the first recomputes from
    // the same old time and lands on the same moment. The element is always current.
    const t = video.currentTime;
    const target = stepMoment(props.activities, t, props.selectOpts.lead, dir);
    if (!target) return; // at the ends: a no-op, not a wrap-around
    // Deliberately does NOT reveal the bar. Stepping between moments is watching, not
    // operating the player: someone jumping through a lecture with [ and ] wants the lecture,
    // and having the chrome flash back over it on every press is the opposite of what they
    // asked for. The Prev/Next BUTTONS reveal it themselves (below) — they live in the bar, so
    // it must not vanish out from under the cursor that is clicking them.
    const seekTo = seekTargetFor(target, props.selectOpts.lead);
    viewerSeek(video, seekTo);
    // Keep the chrome in step immediately rather than waiting for the next presented frame,
    // so the status and the lit mark move with the key rather than a beat behind it.
    chromeTimeRef.current = seekTo;
    setCurrTime(seekTo);
  };

  // Draw the moment's crop (snippets.cropRect: box + 15% pad, native video px) from the
  // video element into a canvas and keep it as an object URL. Kept even when nothing is
  // pinned, so P after a moment has passed still shows what was just written.
  //
  // A live panel does NOT follow the newest capture. It used to, and that quietly undid the
  // point of the feature: a pin exists so the reader can take their time while the lecture
  // takes its own, and a panel that swaps itself out mid-read hands the instructor's pace
  // back. What you pinned is what stays until you dismiss it or pin again.
  //
  // The two "is this url the one on screen?" guards below and in handleUnpin are what make
  // that safe: once a pin outlives the latest capture, exactly one of the two owns each url.
  // ponytail: holds ONE frame; per-moment history would need a store and an eviction policy.
  const captureEndFrame = (a: Activity, video: HTMLVideoElement) => {
    const r = cropRect(a, props.meta);
    if (r.w < 2 || r.h < 2) return;
    const c = document.createElement("canvas");
    c.width = r.w;
    c.height = r.h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const old = lastEndFrameRef.current;
      if (old && old.url !== pinnedRef.current?.url) URL.revokeObjectURL(old.url);
      lastEndFrameRef.current = { activity: a, url };
    }, "image/png");
  };

  // Pin the current moment's ink as it stands right now, or — between moments — the final
  // ink of the last one that ended. Toggles off if already showing.
  const handlePin = () => {
    if (pinnedRef.current) {
      handleUnpin();
      return;
    }
    const video = videoRef.current;
    const inside = insideMomentRef.current;
    if (video && inside) captureEndFrame(inside, video);
    // captureEndFrame is async (toBlob); pin whatever is newest once it lands. For the
    // between-moments case the capture already exists.
    setTimeout(() => {
      if (lastEndFrameRef.current) setPinned(lastEndFrameRef.current);
    }, 60);
  };

  const handleUnpin = () => {
    const shown = pinnedRef.current;
    if (shown && shown.url !== lastEndFrameRef.current?.url) URL.revokeObjectURL(shown.url);
    setPinned(null);
  };

  // Core per-time update: selection, stable activity, scene tracking. Kept in a ref
  // so the rVFC loop always calls the freshest closure.
  const updateAtTime = (t: number) => {
    // The chrome (scrubber, timecode, status, current mark) updates at ~10Hz, not at the
    // display's frame rate. Only the highlight and the magnifier need frame accuracy — a
    // highlight 100ms behind the pen is the bug the rVFC loop exists to fix; a mark lighting
    // up 100ms late is invisible. This caps React's work on a main thread already shared
    // with the magnifier's per-frame canvas blit and the analyzer worker.
    //
    // currActivity/stableActivity are set every frame below, but selectActivity returns the
    // SAME object while you stay in a moment, so React bails out of those renders for free.
    if (Math.abs(t - chromeTimeRef.current) >= 0.1) {
      chromeTimeRef.current = t;
      setCurrTime(t);
    }
    handleIsEnded.close();

    const activity = selectActivity(props.activities, t, props.selectOpts);
    if (activity) setStableActivity(activity);
    setCurrActivity(activity);

    // Publish only on change, not on every presented frame.
    if ((activity?.id ?? null) !== lastReportedActivityRef.current) {
      lastReportedActivityRef.current = activity?.id ?? null;
      props.onActivityChange?.(activity);
    }

    // Scene change: tell the viewer, but don't touch their zoom. Yanking them out of a
    // magnified view is a bigger disruption than a briefly stale target — and scene
    // detection is a heuristic, so it fires on things that aren't really slide changes
    // (a build animation, a camera move). The enhancements re-target themselves as soon
    // as the new scene produces an activity; the notice covers the gap.
    // A seek lands in a different scene too, but the viewer did that on purpose and doesn't
    // need to be told. Only a boundary crossed by playback itself is news, so ignore scene
    // changes that coincide with a jump in the playhead.
    const jumped = Math.abs(t - prevTimeRef.current) > 1;
    prevTimeRef.current = t;

    // Track which moment playback is inside, on raw start/end rather than the lead/linger-
    // padded selection above: linger keeps a moment "selected" past its end, and the pinned
    // snapshot needs that boundary sharp to know when the ink is finished.
    const video = videoRef.current;
    const inside = props.activities.find((a) => t >= a.start && t <= a.end) ?? null;
    const prevInside = insideMomentRef.current;
    insideMomentRef.current = inside;
    // Capture the finished ink as playback leaves a moment — but never on a seek: the frame
    // on screen after a jump belongs to the destination, not to the moment left behind.
    if (video && !jumped && prevInside && (!inside || inside.id !== prevInside.id) && t >= prevInside.end) {
      captureEndFrame(prevInside, video);
    }

    // Track the scene by its START, not its id: scenes are a partition that re-derives when
    // analysis finds a new cut, and ids shift by one when a cut lands earlier in the video —
    // the id changing under a stationary playhead is not a scene change.
    const scene = props.scenes.find((s) => t >= s.start && t <= s.end) ?? null;
    if (scene && scene.start !== currSceneStartRef.current) {
      const isFirst = currSceneStartRef.current === null;
      currSceneStartRef.current = scene.start;
      // Read from the store rather than a render closure: this runs from the frame loop,
      // which outruns re-render, and a viewer who just switched the cue off should not get
      // one more of them.
      if (!isFirst && !jumped && useViewSettingsStore.getState().sceneNotice) {
        setSceneNoticeVisible(true);
        clearSceneNoticeTimeout();
        startSceneNoticeTimeout();
      }
    }

    props.onTimeChange?.(t);
  };
  const updateAtTimeRef = useRef(updateAtTime);
  updateAtTimeRef.current = updateAtTime;

  // Selection only re-runs when the time moves (rVFC, timeupdate). A moment the analysis finds
  // UNDER a paused playhead — the viewer seeked ahead and waited — was therefore never selected:
  // no highlight, nothing announced, until they nudged the time. Re-run it when the list grows
  // while paused. (Playing, the frame loop picks it up within a frame anyway.)
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.paused) updateAtTimeRef.current(v.currentTime);
  }, [props.activities]);

  // The persisted rate survives reloads and new videos; the element resets to 1 whenever
  // src changes, so re-apply on both.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate, props.src]);

  // Smooth tracking: requestVideoFrameCallback fires per presented frame (timeupdate
  // is only ~4 Hz). Falls back silently where rVFC is unavailable.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !("requestVideoFrameCallback" in video)) return;
    let handle = 0;
    const loop = () => {
      updateAtTimeRef.current(video.currentTime);
      handle = video.requestVideoFrameCallback(loop);
    };
    handle = video.requestVideoFrameCallback(loop);
    return () => video.cancelVideoFrameCallback(handle);
  }, [props.src]);

  // Event handlers
  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video || !props.canPlay) return;
    if (isPlaying) {
      showControls();
      video.pause();
    } else {
      void video.play();
    }
  };

  const handleVolumeChange = (value: number) => {
    if (videoRef.current) videoRef.current.volume = value;
    if (value === 0) handleIsMuted.open();
    else handleIsMuted.close();
    setVolume(value);
  };

  const handleMute = () => handleIsMuted.toggle();

  // Opening Appearance while parked on nothing means every slider changes a box that is not
  // on screen — you would be tuning blind. So if the video is paused and no moment is
  // showing, jump to the nearest one, and step back to where the viewer was when they close.
  // Never move the playhead while the video is playing: that would be the app yanking them
  // out of the lecture.
  // Every seek the VIEWER makes goes through here. If the Appearance preview has parked the
  // playhead on a moment, the viewer moving it is them choosing a place, so the preview lets go
  // first — synchronously, before the seek. It used to let go on `seeked`, which is too late: a
  // click on the scrubber is also an outside-click that closes the sheet, the close restored
  // the pre-preview time before `seeked` arrived, and the viewer's seek was undone (and the
  // bookmark kept the old place). Same race for ] followed quickly by Escape.
  const cancelPreview = (nowAt?: number) => {
    if (preAppearanceTimeRef.current === null) return;
    preAppearanceTimeRef.current = null;
    setPreviewJumped(false);
    props.onPreviewJump?.(null, nowAt);
  };
  const viewerSeek = (video: HTMLVideoElement, t: number) => {
    cancelPreview(t);
    // And forget a preview jump still in flight: ownership is matched by landing time, so a
    // viewer seek landing within 0.05s of that target before its `seeked` would otherwise be
    // taken for the player's own and leave the resume offer and the bookmark untouched.
    ownSeekRef.current = null;
    video.currentTime = t;
  };

  const handleAppearanceOpen = (open: boolean) => {
    const video = videoRef.current;
    setAppearanceOpen(open);
    if (!video) return;

    if (open) {
      if (!isPlaying && !currActivity && props.activities.length > 0) {
        const target =
          stepMoment(props.activities, video.currentTime, props.selectOpts.lead, 1) ??
          stepMoment(props.activities, video.currentTime, props.selectOpts.lead, -1);
        if (target) {
          preAppearanceTimeRef.current = video.currentTime;
          // Clamped inside the moment and the video: a moment in the last fraction of a second
          // would put the target past the end, the browser would clamp the seek, and the
          // landing time would no longer match ownSeekRef — the player's own preview jump
          // would then count as the viewer's, dismissing the resume offer.
          const end = Math.min(target.end, (video.duration || totalTime) - 0.05);
          const t = Math.max(
            target.start,
            Math.min(end, seekTargetFor(target, props.selectOpts.lead) + props.selectOpts.lead + 0.2)
          );
          ownSeekRef.current = t;
          video.currentTime = t;
          setPreviewJumped(true);
          props.onPreviewJump?.(preAppearanceTimeRef.current);
        }
      }
    } else if (preAppearanceTimeRef.current !== null) {
      const back = preAppearanceTimeRef.current;
      ownSeekRef.current = back;
      video.currentTime = back;
      preAppearanceTimeRef.current = null;
      setPreviewJumped(false);
      props.onPreviewJump?.(null, back);
    }
  };

  const handleFullscreen = () => {
    if (isFullscreen) {
      if (document.fullscreenElement) void document.exitFullscreen();
    } else {
      // Fullscreen the player container, not document.body (Chrome shifts
      // non-16:9 video in body-fullscreen; documented in the original README).
      void containerRef.current?.requestFullscreen();
    }
  };

  // The moments list, one toggle for the button and the L key. Opening it collapses the bar, so
  // the list gets the height the expanded bar would have taken.
  const toggleMomentsOverlay = () => {
    if (!momentsOpen) handleCollapsed.open();
    handleMomentsOpen.toggle();
  };

  // L means "take me to the moments", which is a different thing in the two layouts. In
  // fullscreen the list is an overlay the key opens and closes, exactly like its button (and
  // the bar is revealed, since that button lives in it). Windowed, the list is already on the
  // page, so there is nothing to open: the key moves focus to it — to the row playing now, so
  // the reader starts where the lecture is, else to the first row that can take focus.
  const handleMomentsKey = () => {
    const container = containerRef.current;
    if (isFullscreen) {
      showControls();
      // Closing from inside the list would drop focus on <body> as the overlay unmounts —
      // hand it back to the toggle, as Escape does.
      const inside = !!container?.querySelector(".moments-side.overlay")?.contains(document.activeElement);
      toggleMomentsOverlay();
      if (momentsOpen && inside) {
        container?.querySelector<HTMLButtonElement>('button[aria-label="Moments list"]')?.focus();
      }
      return;
    }
    const side = document.querySelector<HTMLElement>(".moments-side:not(.overlay)");
    if (!side) return;
    // "Can take focus" means enabled AND rendered: a row inside a folded scene is in the DOM
    // but has no box, and focus() on it silently does nothing. A folded scene's own summary
    // is the fallback, since that is where its rows are.
    const rows = [
      side.querySelector<HTMLElement>('.side-row[aria-current="true"]'),
      ...side.querySelectorAll<HTMLElement>(".side-row:not(:disabled)"),
      side.querySelector<HTMLElement>(".side-scene summary"),
    ];
    rows.find((r) => r && r.getClientRects().length > 0)?.focus();
  };

  // The one-row bar's height, for the page's width cap (--video-cap, index.css). Published only
  // while the controls ARE one row: that height depends on the font size (the timecode's line
  // box) but not on the player's width, so feeding it back cannot loop — a wrapped bar is the
  // one measurement that depends on the width, and it is never published. The cap used a fixed
  // 89px before, true at a 16px root and 7px short at 20px, which scrolled the page.
  useEffect(() => {
    const bar = barSizeRef.current;
    // The DOM's word, not the state's: `barHeight` (ResizeObserver) and `isFullscreen` (the
    // fullscreenchange event) settle at different moments, and on leaving fullscreen with the
    // bar expanded there, the state still held the FULLSCREEN bar's height for a frame — it got
    // published, the windowed player narrowed by 1.8px, and on a player within that much of the
    // wrap threshold the row wrapped and the guard below never published the right value again.
    // So: skip while anything is fullscreen, and measure the bar here, at the moment of the
    // one-row check, so the two describe the same layout.
    if (!bar || isFullscreen || document.fullscreenElement) return;
    const tops = [...bar.querySelectorAll<HTMLElement>(".controls > button")]
      .filter((b) => b.getClientRects().length > 0)
      .map((b) => Math.round(b.getBoundingClientRect().top));
    if (new Set(tops).size !== 1) return;
    const h = bar.getBoundingClientRect().height;
    if (h <= 0) return;
    document.documentElement.style.setProperty("--bar-one-row", `${Math.ceil(h)}px`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barHeight, isFullscreen]);
  useEffect(() => () => {
    document.documentElement.style.removeProperty("--bar-one-row");
  }, []);

  // Fullscreen starts collapsed: the bar overlays the picture there, and the one-line bar covers
  // the least of it. Leaving always returns to the expanded bar, the only windowed one (D32).
  useEffect(() => {
    const sync = () => {
      if (document.fullscreenElement) {
        handleCollapsed.open();
        handleIsFullscreen.open();
      } else {
        handleCollapsed.close();
        handleIsFullscreen.close();
      }
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleZoomShift = (shift: number) => {
    // ↑ with the magnifier off turns it on — "more zoom" from none. ↓ with it off does nothing:
    // it used to turn it ON too, so "zoom out" zoomed in.
    if (!isZoomIn) {
      if (shift > 0) handleZoom();
      return;
    }
    useMagnificationSettingsStore.setState((state) => ({
      ...state,
      zoom_strength: Math.min(1, Math.max(0, state.zoom_strength + shift)),
    }));
  };

  const handleTimeShift = (shift: number) => {
    const video = videoRef.current;
    if (!video || !props.canPlay) return;
    // From the ELEMENT, like handleStepMoment and for the same reason: `currTime` is throttled
    // state that only catches up when a frame is presented, so while paused, or on quick
    // repeated presses, it is stale — three presses of ← became one, and a press right after
    // a seek jumped from wherever the state last was (measured: 30s → 0s).
    const oldValue = video.currentTime;
    const newValue = Math.max(0, Math.min(totalTime, oldValue + shift));
    viewerSeek(video, newValue);

    if (oldValue < newValue) {
      clearForwardShiftTimeout();
      setForwardShiftRequest(true);
      startForwardShiftTimeout();
    }
    if (oldValue > newValue) {
      clearBackShiftTimeout();
      setBackShiftRequest(true);
      startBackShiftTimeout();
    }
  };

  const handleSeek = (event: React.MouseEvent) => {
    event.preventDefault();
    if (event.buttons !== 1) return;
    const video = videoRef.current;
    const timeline = timelineContainerRef.current;
    if (!video || !timeline || !props.canPlay) return;
    // From the event, not from useMouse's `timelineX`: that is state, updated on mousemove and
    // read here from the last render, so a quick move-and-click (or a click with no move over
    // the strip at all) seeked to wherever the pointer USED to be — 0:00, measured.
    const rect = timeline.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / (rect.width || 1)));
    viewerSeek(video, frac * video.duration);
  };

  const handleZoom = () => {
    if (!isZoomIn && !stableActivity) return;
    handleIsZoomIn.toggle();
  };

  const handleVideoEnded = () => {
    handleIsEnded.open();
  };

  useEffect(() => {
    handleIsEnded.close();
    currSceneStartRef.current = null;
    prevTimeRef.current = 0;
    setSceneNoticeVisible(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.src]);

  // Opening the fullscreen moments overlay moves focus into it — without this a keyboard
  // user opens a panel they then have to Tab hunt for (it is several stops away).
  useEffect(() => {
    if (!momentsOpen) return;
    containerRef.current
      ?.querySelector<HTMLElement>(".moments-side.overlay .side-row")
      ?.focus();
  }, [momentsOpen]);

  useEffect(() => {
    if (props.seekFnRef) {
      // `play` is for moment navigation ("go watch this"): a jump that lands paused hands a
      // blind user literal silence and costs everyone a second click. Debug callers (scene
      // strip, analyzer view) omit it and keep their inspect-in-place behavior.
      props.seekFnRef.current = (t: number, play?: boolean) => {
        const v = videoRef.current;
        if (!v) return;
        viewerSeek(v, t);
        if (play && props.canPlay) void v.play();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.seekFnRef, props.canPlay]);

  const tooltipTime = timelineContainerRef.current
    ? (timelineX / (timelineContainerRef.current.clientWidth || 1)) * totalTime
    : 0;

  const playerActivity = currActivity ? toPlayerActivity(currActivity, props.meta) : null;
  const zoomActivity = currActivity ?? stableActivity;

  // The gate's bar fills toward the UNLOCK (the first PLAYBACK_LEAD seconds), not toward the
  // end of the video — the promise on screen is "playback starts as soon as the first 10
  // seconds are ready", and a bar creeping toward 100% of a 75-minute lecture would flatly
  // contradict it. Analysis restarts wherever the viewer seeks, so "analyzed" is a set of
  // ranges; total covered seconds is the honest measure of progress toward that unlock.
  const analyzedSec = props.ranges.reduce((s, r) => s + (r.end - r.start), 0);
  const gatePct = (analyzedSec / PLAYBACK_LEAD) * 100;

  return (
    <PlayerTipRoot.Provider value={tipRoot}>
    <Box
      className={videoContainerClasses}
      ref={containerMergedRef}
      onMouseMove={showControls}
      // The reveal triggers that make auto-hide safe (auto-hide is fullscreen-only). Pointer
      // movement alone would delete the moments and the controls for a keyboard or
      // screen-reader user; focus and keypress bring them back for everyone.
      //
      // Except the keys whose control is not IN the bar (zoom, moment-stepping) — see
      // NO_REVEAL_KEYS and the hotkey table. Every other key still reveals it, so the bar is
      // never unreachable from the keyboard.
      onKeyDown={(e) => {
        if (!NO_REVEAL_KEYS.has(e.key)) showControls();
      }}
      onFocusCapture={showControls}
      // Blur is the only signal that keyboard focus LEFT the bar (leaving fires no key or
      // pointer event), and the hide timer above refuses to fire while focus is inside —
      // so this restart is what lets the bar hide again afterwards.
      onBlurCapture={showControls}
    >
      {/* The resume offer, ON the video. It was a strip above the player, which pushed the whole
          player down the moment it appeared — the page moving under the viewer, the very thing
          this round removed everywhere else (Yotam). Centred: clear of the top-centre notices
          and of every corner the pinned snapshot can take, and over the picture the viewer has
          not started yet.
          Still a question the viewer may ignore, not a dialog: nothing takes focus, play or a
          seek answers it as surely as either button, and both buttons are in the tab order
          (after the bar's controls, Resume first). The live region stays mounted and the card
          appears INSIDE it, because a region inserted together with its content is not
          announced. Space and Enter press its buttons, never the player; and its clicks stop
          here, so pressing it cannot reach the click-to-pause surface underneath.
          FIRST in the player's DOM, so first in its tab order, while drawn over the picture:
          after the bar it sat behind every moment mark in the lane (each a tab stop — 36 on a
          36-moment lecture) before a keyboard user could reach Resume. Positioned over the
          picture's box: the whole container less the bar where the bar sits below it
          (windowed); in fullscreen, where the bar overlays, the picture above the bar. */}
      <Box
        className={classNames("resume-slot", {
          // While the fullscreen moments list or any of the bar's popovers is open, the offer
          // waits: hidden, but still mounted (the live region stays), and back when they close
          // if it is still unanswered. Those all open over the picture, where the card is; with
          // both up, one would cover the other and its focusable controls.
          waiting: (isFullscreen && momentsOpen) || appearanceOpen || volumeOpen || speedOpen,
        })}
        role="status"
        // The card's area is the picture LESS the bar, always — never under it, never over it, by
        // layout rather than by stacking (the pinned snapshot's rule). Windowed the bar is below
        // the picture; in fullscreen it overlays the picture's bottom, so the area stops a gap
        // above it, and the card compacts to fit (player.css). An earlier version lifted the card
        // ABOVE the bar instead, and every layer that opens over the picture — the bar's popovers,
        // the fullscreen list, a focused bar control — then had to be argued with one by one.
        style={{ bottom: isFullscreen ? barHeight + 8 : barHeight }}
      >
        {props.resumeOffer && (
          <div
            className="resume-card"
            role="group"
            aria-label="Resume where you left off"
            onKeyDown={stopPlayerHotkeys}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <p className="resume-q">
              Resume at <b>{convertSecondsToTimecode(props.resumeOffer.at)}</b>?
            </p>
            <div className="resume-actions">
              <button type="button" className="resume-yes" onClick={props.resumeOffer.onResume}>
                Resume
              </button>
              <button type="button" className="resume-no" onClick={props.resumeOffer.onRestart}>
                Start from the beginning
              </button>
            </div>
          </div>
        )}
      </Box>
      {/* No py prop: it lands as an inline style and silently overrides the stylesheet's
          padding, so the bar's vertical rhythm ends up owned by two places. CSS owns it. */}
      {/* The keys a focused bar control USES belong to that control — the same rule the
          moments sidebar applies. Without this, Space on the focused Mute button toggles
          playback instead of mute, and ArrowLeft on the volume slider nudges the volume AND
          seeks −5s (the document-level hotkeys see every bubbled keydown). The reveal is
          re-applied here because the stop also hides those keys from the container's own
          reveal handler.
          Scoped to those keys (stopPlayerHotkeys), not every key. This was a blanket
          stopPropagation, which made every letter shortcut dead while focus sat on ANY bar
          control — including right after clicking one with the mouse, so F, P, A and L
          silently did nothing until you clicked the video. Found testing D31's keys. */}
      <Box
        className="video-controls-container"
        ref={barSizeRef}
        onKeyDown={(e) => {
          showControls();
          stopPlayerHotkeys(e);
        }}
      >
        {/* The scrubber is a slider to the keyboard and AT, not just a mouse strip: it was
            the one player control with no non-pointer equivalent beyond the global ±5s keys.
            Arrow keys reuse handleTimeShift so the flash indicators and clamping match; the
            bar's stopPropagation keeps the same press from also reaching the global hotkeys. */}
        <Box
          className="timeline-container"
          ref={trackRef}
          my={6}
          onMouseMove={handleSeek}
          onMouseDown={handleSeek}
          tabIndex={0}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalTime)}
          aria-valuenow={Math.round(currTime)}
          aria-valuetext={`${convertSecondsToTimecode(currTime)} of ${convertSecondsToTimecode(totalTime)}`}
          aria-disabled={!props.canPlay || undefined}
          onKeyDown={(e) => {
            const video = videoRef.current;
            if (!video || !props.canPlay) return;
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              handleTimeShift(e.key === "ArrowLeft" ? -5 : 5);
            } else if (e.key === "Home") {
              e.preventDefault();
              viewerSeek(video, 0);
            } else if (e.key === "End") {
              e.preventDefault();
              viewerSeek(video, totalTime);
            }
          }}
        >
          <Box className="timeline">
            {/* Analyzed coverage (striped) behind the playback progress. */}
            {props.ranges.map((r, i) => (
              <Box
                key={i}
                className="timeline-analyzed"
                style={{
                  left: `${(r.start / totalTime) * 100}%`,
                  width: `${((r.end - r.start) / totalTime) * 100}%`,
                }}
              />
            ))}
            <Box
              className="timeline-progress"
              style={{ width: `${(currTime / totalTime) * 100}%` }}
            />
            <Box
              className="timeline-tooltip"
              style={{
                left: `${timelineContainerRef.current
                  ? (timelineX / (timelineContainerRef.current.clientWidth || 1)) * 100
                  : 0}%`,
              }}
            >
              <Text>{convertSecondsToTimecode(tooltipTime)}</Text>
            </Box>
            <Box
              className="timeline-thumb"
              style={{ left: `${(currTime / totalTime) * 100}%` }}
            />
          </Box>
        </Box>
        {/* The moment lane. Its own row, under the scrubber: each mark is a real button you
            can click and Tab to, and scrubbing never competes with jumping. Drawing the marks
            INSIDE the track (YouTube-chapter style) is cheaper in space but a mark under the
            playhead becomes invisible and there is nothing separate to focus. */}
        {/* Rendered from the first frame, empty until the first moment arrives. It used to mount
            when the analysis found something, which grew the bar mid-analysis and, windowed,
            resized the player under the viewer (D32). An empty lane is hidden from AT: a group
            of nothing is noise. */}
        <Box
          className="moment-lane"
          role={markers.length > 0 ? "group" : undefined}
          aria-label={markers.length > 0 ? "Moments in this lecture" : undefined}
          aria-hidden={markers.length > 0 ? undefined : true}
        >
            {markers.map((m) => {
              const isNow = currIndex >= 0 && m.activities.some((a) => a === currActivity);
              const label =
                m.activities.length === 1
                  ? `Moment ${m.index}, ${momentDescription(m.activities[0], props.meta.analysisWidth, props.meta.analysisHeight)}, ${convertSecondsToTimecode(m.activities[0].start)}, ${(
                      m.activities[0].end - m.activities[0].start
                    ).toFixed(1)} seconds`
                  : `Moments ${m.index} to ${m.index + m.activities.length - 1}, from ${convertSecondsToTimecode(
                      m.activities[0].start
                    )}`;
              return (
                <UnstyledButton
                  key={m.index}
                  className={classNames("moment-mark", { now: isNow })}
                  style={{ left: `${m.leftPct}%`, width: `${m.widthPct}%` }}
                  aria-label={label}
                  disabled={!props.canPlay}
                  onKeyDown={stopPlayerHotkeys}
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v || !props.canPlay) return;
                    viewerSeek(v, seekTargetFor(m.activities[0], props.selectOpts.lead));
                    void v.play(); // a jump is "go watch this" — landing paused costs a second click
                  }}
                />
              );
            })}
        </Box>

        {/* What is happening, for a screen reader: a visually hidden live region, mounted from
            the first frame (a region inserted together with its text is not announced). It
            speaks when a moment STARTS — once, with where the next one is — and when the
            magnifier changes, in its own text node so only that part is read. It says nothing
            when a moment ends: it used to switch to "36 moments in this lecture. Next at …"
            there, so every moment was two announcements, and at speed the end of one and the
            start of the next landed 100ms apart and clipped each other.
            It used to be a visible status line here too, "Moment 3 of 36 · top right · 01:23,
            2.6s … Next at 01:40". Yotam removed it (D32): it cost the bar a row and the picture
            the height of that row, it made the bar's height depend on how its sentence wrapped
            (which took reserved-height sizers to keep the player still), and what it said is
            already on screen — the lit mark in the lane, the current row in the moments list,
            the timecode, and the magnifier button's amber pressed state. "No moments found"
            has its visible home in the moments list. */}
        <Box className="now-status" role="status">
          <span key={momentEntry}>
            {props.activities.length === 0
              ? props.done
                ? "No moments found."
                : "Looking for moments…"
              : momentSpoken}
          </span>
        </Box>
        <Box className="now-status" role="status">
          {zoomSpoken}
        </Box>

        <Group className="controls" gap={4} align="center" mt={4}>
          {/* aria-disabled, not disabled: the click is already a guarded no-op while gated,
              and a hard disabled would throw keyboard focus somewhere else the moment the
              gate lifts. This way AT hears "dimmed" instead of a button that eats presses
              silently. */}
          <UnstyledButton
            onClick={handlePlayPause}
            onKeyDown={stopPlayerHotkeys}
            aria-label={isPlaying ? "Pause" : "Play"}
            aria-disabled={!props.canPlay || undefined}
          >
            {isPlaying ? <IconPlayerPauseFilled /> : <IconPlayerPlayFilled />}
          </UnstyledButton>
          {/* Always rendered, dimmed until there is a moment to step to: two buttons
              appearing mid-analysis could push the row to wrap on a narrow window, which is the
              same resize the lane above no longer causes. */}
          <UnstyledButton
            className="collapse-hide"
            onClick={() => { showControls(); handleStepMoment(-1); }}
            onKeyDown={stopPlayerHotkeys}
            disabled={!props.canPlay || props.activities.length === 0}
            aria-label="Previous moment"
            title="Previous moment ( [ )"
          >
            <IconPlayerTrackPrevFilled />
          </UnstyledButton>
          <UnstyledButton
            className="collapse-hide"
            onClick={() => { showControls(); handleStepMoment(1); }}
            onKeyDown={stopPlayerHotkeys}
            disabled={!props.canPlay || props.activities.length === 0}
            aria-label="Next moment"
            title="Next moment ( ] )"
          >
            <IconPlayerTrackNextFilled />
          </UnstyledButton>
          {/* Volume: a button that opens a vertical slider, not a slider always in the row. The
              always-visible horizontal slider cost the row 92px (Yotam asked for it out, D32).
              It once expanded on HOVER, which hid it from keyboard, screen-reader and touch
              users — so this opens on click, Enter or Space and on nothing else. Focus lands on
              the slider; Escape closes and returns focus to the button. withinPortal={false}
              for the same reason as the speed menu and Appearance: portalled to body it would
              be invisible in fullscreen. The icon keeps showing muted / low / high, and M still
              mutes without opening anything. */}
          <Popover
              position="top"
              withinPortal={false}
              classNames={{ dropdown: supportsVerticalRange() ? "bar-pop vol-pop" : "bar-pop vol-pop flat" }}
              opened={volumeOpen}
              onChange={setVolumeOpen}
              trapFocus
              returnFocus
            >
              {/* The tip wraps the Target, inside the Popover — never the Popover itself, which
                  is not an element: wrapped from outside, the tip had no box to anchor to and
                  drew itself at the player's top-left corner (see PlayerTip on the order). */}
              <PlayerTip label="Volume" hotkey="M" disabled={volumeOpen || barHidden}>
                <Popover.Target>
                  <UnstyledButton
                    className="collapse-hide"
                    onClick={() => setVolumeOpen((o) => !o)}
                    onKeyDown={stopPlayerHotkeys}
                    aria-label={`Volume: ${isMuted ? "muted" : `${Math.round(volume * 100)}%`}`}
                    aria-keyshortcuts={letterShortcuts ? "M" : undefined}
                    aria-expanded={volumeOpen}
                  >
                    {isMuted ? (
                      <IconVolumeMute />
                    ) : volume > 0.5 ? (
                      <IconVolumeHigh />
                    ) : (
                      <IconVolumeLow />
                    )}
                  </UnstyledButton>
                </Popover.Target>
              </PlayerTip>
              <Popover.Dropdown onKeyDown={stopPlayerHotkeys}>
                {/* A native range, vertical by writing-mode: Mantine's Slider has no vertical
                    mode, and the native control brings the arrow keys (up = louder), Home/End
                    and the slider role for free. 0-100, not the element's 0-1: "35 percent"
                    is comprehensible where "0.35" is not. data-autofocus is where Mantine's
                    focus trap puts focus on open. */}
                <input
                  type="range"
                  className="vol-range"
                  data-autofocus
                  min={0}
                  max={100}
                  step={5}
                  value={isMuted ? 0 : Math.round(volume * 100)}
                  onChange={(e) => handleVolumeChange(Number(e.currentTarget.value) / 100)}
                  aria-label="Volume"
                  aria-valuetext={`${isMuted ? 0 : Math.round(volume * 100)}%`}
                  aria-orientation={supportsVerticalRange() ? "vertical" : "horizontal"}
                />
                {/* Label + pressed state both flip: an icon swap alone is invisible to AT, and
                    "Mute" on a muted player reads as the current state instead of the action. */}
                <UnstyledButton className="vol-mute" onClick={handleMute} aria-pressed={isMuted}>
                  {isMuted ? "Unmute" : "Mute"}
                </UnstyledButton>
              </Popover.Dropdown>
          </Popover>
          <Group className="duration-container" gap="xs">
            <Text>{convertSecondsToTimecode(currTime)}</Text>
            <Text>/</Text>
            <Text>{convertSecondsToTimecode(totalTime)}</Text>
          </Group>
          {/* Speed, as an icon that opens its values. This replaced a native <select>, whose
              free keyboard and screen-reader behaviour was the reason it was chosen — the bar
              had run out of room, and a labelled select showing its widest option was paying
              for that in width on every frame. Mantine's Menu carries the roles, arrow keys,
              Escape and focus return; what is genuinely lost is the native mobile picker and
              the select's "1×, 2 of 7" announcement, so the trigger's own label carries the
              current rate instead.
              withinPortal={false} is not a style choice: portalled to body, this dropdown is
              invisible in fullscreen — the same reason the Appearance popover sets it.
              The rate shows next to the icon, always. Icon-only at every rate would hide a
              non-default state on the one control that silently changes how the whole lecture
              behaves — the exact bug the visible-magnifier work already fixed once; off-default
              it also turns amber. It used to show only off 1×, to keep the bar narrow, but the
              button now holds a fixed width for the widest rate (a width that changed with the
              rate could wrap the row — player.css), so at 1× that room would sit empty. */}
          <Menu
            position="top"
            withinPortal={false}
            classNames={{ dropdown: "bar-pop" }}
            onOpen={() => setSpeedOpen(true)}
            onClose={() => setSpeedOpen(false)}
          >
            <Menu.Target>
              <UnstyledButton
                className={classNames("collapse-end", "bar-speed", { on: playbackRate !== 1 })}
                onKeyDown={stopPlayerHotkeys}
                aria-label={`Playback speed: ${playbackRate}×`}
                title={`Playback speed: ${playbackRate}×`}
              >
                <IconGauge />
                <span className="bar-speed-v">{playbackRate}×</span>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown onKeyDown={stopPlayerHotkeys}>
              {RATES.map((r) => (
                <Menu.Item
                  key={r}
                  className={r === playbackRate ? "on" : ""}
                  onClick={() => setPlaybackRate(r)}
                >
                  {r}×
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          {props.extraHud}
          {/* The magnifier gets an on-screen toggle: it was keyboard-only (Z), which made
              it unreachable on touch and its STATE invisible — the core user toggled it off
              by accident and diagnosed a black screen for thirty seconds. aria-pressed and
              the amber pressed style are the always-visible answer to "is it on?". */}
          <UnstyledButton
            className={classNames("collapse-end", "zoom-toggle", { on: isZoomIn })}
            onClick={() => { showControls(); handleZoom(); }}
            onKeyDown={stopPlayerHotkeys}
            aria-label={isZoomIn ? "Stop magnifying" : "Magnify the highlighted area"}
            aria-pressed={isZoomIn}
            aria-disabled={!isZoomIn && !stableActivity ? true : undefined}
            title={isZoomIn ? "Stop magnifying (Z)" : "Magnify (Z)"}
          >
            <IconZoomInAreaFilled />
          </UnstyledButton>
          {/* Pin: keep the last-written ink readable while the lecture moves on. The core
              user reads at a third of normal speed — this is her time to read, decoupled
              from the instructor's time to talk. */}
          <UnstyledButton
            className={classNames("collapse-end", "zoom-toggle", { on: !!pinned })}
            onClick={() => { showControls(); handlePin(); }}
            onKeyDown={stopPlayerHotkeys}
            aria-label={pinned ? "Dismiss the pinned snapshot" : "Pin a snapshot of the latest writing"}
            aria-pressed={!!pinned}
            aria-disabled={!pinned && !lastEndFrameRef.current && !insideMomentRef.current ? true : undefined}
            title={pinned ? "Dismiss pinned snapshot (P)" : "Pin the latest writing (P)"}
          >
            <IconPinFilled />
          </UnstyledButton>
          <Popover
            position="top-end"
            withinPortal={false}
            classNames={{ dropdown: "ap-pop" }}
            opened={appearanceOpen}
            onChange={handleAppearanceOpen}
            trapFocus
          >
            {/* The name says what is IN the sheet. "Appearance" alone read as the app's theme,
                and the sparkles glyph says nothing at all. */}
            <PlayerTip label="Appearance: highlight and magnifier" hotkey="A" disabled={appearanceOpen || barHidden}>
              <Popover.Target>
                <UnstyledButton
                  className="collapse-end"
                  onClick={() => handleAppearanceOpen(!appearanceOpen)}
                  onKeyDown={stopPlayerHotkeys}
                  aria-label="Appearance: highlight and magnifier"
                  aria-keyshortcuts={letterShortcuts ? "A" : undefined}
                  aria-expanded={appearanceOpen}
                >
                  <IconSparkles />
                </UnstyledButton>
              </Popover.Target>
            </PlayerTip>
            {/* One guard for the whole sheet: every control inside it is a <button> or a
                range, and Space/arrows on those would otherwise bubble to the player hotkeys
                and toggle play or seek while you are adjusting a slider. */}
            <Popover.Dropdown onKeyDown={stopPlayerHotkeys}>
              <AppearanceSheet />
            </Popover.Dropdown>
          </Popover>
          {/* Fullscreen only: windowed, the moments list is always on the page beside the
              player, and a second copy would be noise. collapse-end (not collapse-hide),
              because opening the overlay collapses the bar — hiding the button that closes
              it inside the very collapse it causes would strand the viewer. */}
          {isFullscreen && (
            <PlayerTip label="Moments list" hotkey="L" disabled={momentsOpen || barHidden}>
              <UnstyledButton
                className="collapse-end"
                onClick={toggleMomentsOverlay}
                onKeyDown={stopPlayerHotkeys}
                // Exactly this string: onEscape finds the button by it to hand focus back.
                aria-label="Moments list"
                aria-keyshortcuts={letterShortcuts ? "L" : undefined}
                aria-expanded={momentsOpen}
              >
                <IconListDetails />
              </UnstyledButton>
            </PlayerTip>
          )}
          {/* collapse-end: the controls that stay to the RIGHT of the scrubber when the bar
              collapses to a single line. See the Collapsed block in player.css. */}
          <UnstyledButton
            className="collapse-end"
            onClick={handleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <IconMaximizeOff /> : <IconMaximize />}
          </UnstyledButton>
          {/* Fullscreen only, like collapsing itself (D32): windowed, a shorter bar meant a
              resized player. */}
          {isFullscreen && (
            <UnstyledButton
              className="collapse-end"
              onClick={() => handleCollapsed.toggle()}
              onKeyDown={stopPlayerHotkeys}
              aria-label={collapsed ? "Expand controls" : "Collapse controls"}
              aria-expanded={!collapsed}
            >
              {collapsed ? <IconChevronUp /> : <IconChevronDown />}
            </UnstyledButton>
          )}
        </Group>
      </Box>
      {/* The picture and everything drawn ON it. Its box is the video's box, so the layers
          inside size to the video rather than to the container, which also holds the bar.
          (It was 100% of the container while the bar overlaid the video; with the bar in flow
          below, that would have stretched every layer over the bar too.) The bar stays first
          in the DOM, so it keeps its place in the tab order; CSS orders it below. D32. */}
      <Box className="video-stage">
      <video
        ref={videoMergedRef}
        src={props.src}
        onTimeUpdate={() => {
          // Fallback for browsers without rVFC + covers paused seeks.
          const v = videoRef.current;
          if (v) updateAtTimeRef.current(v.currentTime);
        }}
        onSeeked={() => {
          const t = videoRef.current?.currentTime ?? 0;
          const own = ownSeekRef.current !== null && Math.abs(t - ownSeekRef.current) < 0.05;
          if (own) ownSeekRef.current = null;
          // The viewer navigating while the Appearance preview is parked on a moment (] from a
          // preset button, a click on the lane) has chosen a place: the preview must not drag
          // them back to where they were when they opened the sheet, and a save must record
          // where they went, not that old place.
          // (A backstop only: every viewer seek path already let go of the preview, synchronously,
          // in viewerSeek. This catches a seek from somewhere that does not — the browser's own
          // media keys, say.)
          if (!own) cancelPreview(t);
          props.onSeeked?.(t, !own);
        }}
        onPlay={() => { handleIsPlaying.open(); props.onPlayingChange?.(true); }}
        onPause={() => { handleIsPlaying.close(); props.onPlayingChange?.(false); }}
        onEnded={handleVideoEnded}
        muted={isMuted}
      ></video>
      <Box className="video-highlights">
        <HighlightIndicator
          leftShift={leftShift}
          topShift={topShift}
          scaleRatio={scaleRatio}
          activity={playerActivity}
          videoRef={videoRef}
        />
      </Box>
      <Box className="video-magnification">
        <MagnificationOverlay
          videoRef={videoRef}
          scaleRatio={scaleRatio}
          activity={zoomActivity ? toPlayerActivity(zoomActivity, props.meta) : null}
          zoomIn={isZoomIn}
        />
      </Box>
      <Box
        className="video-overlay"
        style={{ ["--flash-speed" as string]: `${FLASH_SPEED}ms` }}
      >
        <Box
          className="overlay-play-pause"
          onClick={() => handlePlayPause()}
          onDoubleClick={() => handleFullscreen()}
        />
        <Box className="time-shift back-shift" opacity={backShiftRequest ? 1 : 0}>
          <IconArrowBigLeftLineFilled />
        </Box>
        <Box className="time-shift forward-shift" opacity={forwardShiftRequest ? 1 : 0}>
          <IconArrowBigRightLineFilled />
        </Box>
        <Box className="overlay-item zoom-indicator" opacity={isZoomIn ? 1 : 0}>
          <IconZoom />
        </Box>
        <Box className="overlay-end" hidden={!isEnded}></Box>
        {/* The only moment the app makes anyone wait. So it says what it is doing, shows it
            moving, and says when it ends — a bare "Analyzing…" gives a viewer no way to tell
            a slow machine from a hung one. */}
        {!props.canPlay && (
          <Box className="overlay-gate" role="status">
            <div className="gate-h">Finding the moments…</div>
            <div className="gate-sub">
              Playback starts as soon as the first {PLAYBACK_LEAD} seconds are ready.
            </div>
            <div className="gate-bar">
              <div className="gate-fill" style={{ width: `${Math.min(100, gatePct)}%` }} />
            </div>
            <div className="gate-stats">
              {props.xRealtime ? <>running at <b>{props.xRealtime.toFixed(1)}× realtime</b> · </> : null}
              <b>{props.activities.length}</b> moment{props.activities.length === 1 ? "" : "s"} found so far
            </div>
          </Box>
        )}
        {/* The three transient notices stay MOUNTED and toggle their content instead of
            mounting populated: a live region inserted together with its text is not a
            change, and most screen reader/browser pairs never announce it. The :empty
            state is hidden with opacity (player.css) — visibility/display would drop the
            region from the accessibility tree and lose the announcement the same way. */}
        <Box className="overlay-catching-up" role="status">
          {props.canPlay && atUnanalyzed ? "Analyzing this part…" : null}
        </Box>
        {/* Moving someone's playhead without saying so feels like a glitch. Say so.
            In fullscreen, anchored above the MEASURED bar height: the pill only ever shows
            while the Appearance sheet is open, which is exactly when the bar is up — a fixed
            bottom offset put it behind the bar, illegible at every zoom. Windowed, the bar is
            below the picture and the pill sits at the ordinary inset. */}
        <Box
          className="overlay-preview-jump"
          role="status"
          style={{ bottom: barOverlap + 12 }}
        >
          {previewJumped ? "Jumped to a moment so you can see your changes · returns when you close" : null}
        </Box>
        <Box className={classNames("overlay-scene", { stacked: atUnanalyzed })} role="status">
          {sceneNoticeVisible && sceneNotice ? (
            <>
              <IconSwitchHorizontal size={16} />
              Possible scene change
            </>
          ) : null}
        </Box>
      </Box>
      {/* The pinned snapshot: a still, magnified crop of a moment's final ink, docked in a
          corner while the video plays on underneath. The viewer reads at their own speed;
          the lecture keeps the instructor's. It holds the moment you pinned — it does not
          follow later ones, because a panel that swaps itself out mid-read is just the
          lecture's pace again. Corner and size are the reader's to choose and persist: one default
          cannot be right for both a reader who wants it out of the live action and one who
          needs it big enough to read. The top-center stays reserved either way — the
          catching-up and scene notices own it — and in fullscreen a bottom-docked panel clears
          the measured bar, so no choice can bury the controls or the notices. */}
      {pinned && (
        <Box
          className={classNames("pin-panel", `size-${pinSize}`, `at-${pinCorner}`)}
          // In fullscreen the bar is measured, and it sits ABOVE this panel: anything the panel
          // grows into, the bar covers. Capping the height at the space the bar leaves is what
          // keeps the panel's own caption controls clickable at every size. Windowed, the bar
          // is below the picture and the panel has the whole of it, less the insets.
          style={{
            maxHeight: `calc(100% - ${barOverlap + 24}px)`,
            ...(pinCorner === "bl" || pinCorner === "br" ? { bottom: barOverlap + 12 } : {}),
          }}
          role="group"
          aria-label={`Pinned snapshot: ${momentDescription(pinned.activity, props.meta.analysisWidth, props.meta.analysisHeight)}, ${convertSecondsToTimecode(pinned.activity.start)}`}
        >
          <img
            src={pinned.url}
            alt={`Final ink: ${momentDescription(pinned.activity, props.meta.analysisWidth, props.meta.analysisHeight)}`}
          />
          <Box className="pin-cap">
            <Text>
              {momentPlace(pinned.activity, props.meta.analysisWidth, props.meta.analysisHeight)}
              {" · "}
              {convertSecondsToTimecode(pinned.activity.start)}
            </Text>
            {/* Cycles, not menus: a picker would open over the very video the panel is
                already covering. Each label names where the next press lands, so the
                choice is knowable without sight and without trying it. The accessible
                names START with the words the tip shows (WCAG 2.5.3), so a speech-input
                user can say what they see. */}
            <PlayerTip label="Snapshot size" hotkey="S">
              <UnstyledButton
                aria-label={`Snapshot size: ${PIN_SIZE_NAMES[pinSize]}. Change to ${PIN_SIZE_NAMES[nextPinSize(pinSize)]}.`}
                aria-keyshortcuts={letterShortcuts ? "S" : undefined}
                onClick={() => setPinSize(nextPinSize(pinSize))}
                onKeyDown={stopPlayerHotkeys}
              >
                {pinSize === "l" ? <IconArrowsDiagonalMinimize2 size={20} /> : <IconArrowsDiagonal size={20} />}
              </UnstyledButton>
            </PlayerTip>
            <PlayerTip label="Move snapshot" hotkey="C">
              <UnstyledButton
                aria-label={`Move snapshot: now ${PIN_CORNER_NAMES[pinCorner]}. Move to ${PIN_CORNER_NAMES[nextPinCorner(pinCorner)]}.`}
                aria-keyshortcuts={letterShortcuts ? "C" : undefined}
                onClick={() => setPinCorner(nextPinCorner(pinCorner))}
                onKeyDown={stopPlayerHotkeys}
              >
                <IconLayoutDistributeHorizontal size={20} />
              </UnstyledButton>
            </PlayerTip>
            <UnstyledButton aria-label="Dismiss pinned snapshot" onClick={handleUnpin} onKeyDown={stopPlayerHotkeys}>
              <IconX size={20} />
            </UnstyledButton>
          </Box>
        </Box>
      )}
      {/* The fullscreen mount of the moments list. Same component as the page sidebar —
          the current row and the on-video highlight come from this player's own
          currActivity, so they cannot disagree. Anchored above the measured bar so it
          never covers the controls, whichever state the bar is in. */}
      {isFullscreen && momentsOpen && (
        <MomentsSidebar
          className="overlay"
          onEscape={() => {
            handleMomentsOpen.close();
            // Return focus to the toggle that opened it, like the Appearance popover does.
            containerRef.current
              ?.querySelector<HTMLButtonElement>('button[aria-label="Moments list"]')
              ?.focus();
          }}
          activities={props.activities}
          scenes={props.scenes}
          frameW={props.meta.analysisWidth}
          frameH={props.meta.analysisHeight}
          thumbs={props.thumbs ?? EMPTY_THUMBS}
          current={currActivity}
          done={props.done}
          canPlay={props.canPlay}
          lead={props.selectOpts.lead}
          onJump={(t) => {
            const v = videoRef.current;
            if (!v || !props.canPlay) return;
            viewerSeek(v, t);
            void v.play();
          }}
          style={{ bottom: barHeight + 24, maxHeight: `calc(100% - ${barHeight + 48}px)` }}
        />
      )}
      </Box>
      <SVGFilters />
    </Box>
    </PlayerTipRoot.Provider>
  );
};

export default VideoPlayer;
