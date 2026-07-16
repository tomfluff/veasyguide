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
import { Box, Text, Group, UnstyledButton, Slider, Popover } from "@mantine/core";
import {
  useElementSize,
  useDisclosure,
  useHotkeys,
  useMergedRef,
  useMouse,
  useTimeout,
} from "@mantine/hooks";
import {
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
  IconSwitchHorizontal,
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
import MomentsSidebar from "../MomentsSidebar";
import AppearanceSheet from "./AppearanceSheet";
import HighlightIndicator from "./HighlightIndicator";
import MagnificationOverlay from "./MagnificationOverlay";
import SVGFilters from "./SVGFilters";
import { useMagnificationSettingsStore } from "../stores/MagnificationSettingsStore";

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
  onSeeked?: (t: number) => void;
  onTimeChange?: (t: number) => void;
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
// zoom is drawn on the video with its own indicator, and [ / ] are navigation. Kept as one set
// so the hotkey table and the container's onKeyDown cannot drift apart and disagree. Both `z`
// and `Z` — the container sees the raw event.key, so Shift and CapsLock both reach it.
const NO_REVEAL_KEYS = new Set(["z", "Z", "ArrowUp", "ArrowDown", "[", "]"]);

// Seconds of analysis before playback unlocks. Lives here because the pre-playback gate
// PROMISES this number on screen ("the first 10 seconds"), and App gates `canPlay` on it —
// two copies would be two chances for the promise and the behaviour to drift apart.
export const PLAYBACK_LEAD = 10;

const VideoPlayer = (props: Props) => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  // Fullscreen is requested on the container; the overlay geometry measures the <video>
  // element. They are the same rectangle today (the video is the container's only in-flow
  // child), but only by accident — anything else placed in that flow would break the
  // container measurement while the video measurement stays correct.
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    ref: videoSizeRef,
    width: boxWidth,
    height: boxHeight,
  } = useElementSize<HTMLVideoElement>();
  const videoMergedRef = useMergedRef(videoRef, videoSizeRef);
  // The moments overlay anchors just above the control bar, whose height depends on
  // collapsed state and which rows (lane, now-line) are present — so it is measured.
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
  const [collapsed, handleCollapsed] = useDisclosure(false);
  // Fullscreen-only: the moments list summoned as an overlay inside the player.
  const [momentsOpen, handleMomentsOpen] = useDisclosure(false);
  const [sceneNotice, setSceneNotice] = useState(false);
  const currSceneStartRef = useRef<number | null>(null);
  const prevTimeRef = useRef(0);
  const lastReportedActivityRef = useRef<number | null>(null);
  const chromeTimeRef = useRef(-1);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [previewJumped, setPreviewJumped] = useState(false);
  // Where the viewer was before we jumped them to a moment to preview against.
  const preAppearanceTimeRef = useRef<number | null>(null);

  const videoContainerClasses = classNames("video-container", {
    // The bar only ever hides while playing. Paused, it stays — you paused BECAUSE you want
    // to do something, and hunting for the controls you just summoned is not that something.
    clear: hideControls && isPlaying,
    paused: !isPlaying,
    collapsed,
    fullscreen: isFullscreen,
  });

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
    useTimeout(() => {
      const bar = barSizeRef.current;
      if (bar && bar.contains(document.activeElement)) return;
      handleHideControls.open();
    }, 2000);
  const { start: startSceneNoticeTimeout, clear: clearSceneNoticeTimeout } = useTimeout(
    () => setSceneNotice(false),
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
  useHotkeys([
    ["Space", reveal(() => handlePlayPause())],
    ["F", reveal(() => handleFullscreen())],
    ["M", reveal(() => handleMute())],
    ["ArrowLeft", reveal(() => handleTimeShift(-5))],
    ["ArrowRight", reveal(() => handleTimeShift(5))],
    // No reveal — the magnifier is drawn on the video and has its own indicator; the bar has
    // no zoom control to show you. Kept in step with NO_REVEAL_KEYS below.
    ["Z", () => handleZoom()],
    ["ArrowUp", () => handleZoomShift(0.1)],
    ["ArrowDown", () => handleZoomShift(-0.1)],
    // Mantine matches on event.key, which for these is literally "[" and "]" — not the
    // KeyboardEvent.code names ("BracketLeft"/"BracketRight"), which never match.
    ["[", () => handleStepMoment(-1)],
    ["]", () => handleStepMoment(1)],
  ]);

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
  const upcoming = stepMoment(props.activities, currTime, props.selectOpts.lead, 1);
  // "Next at ..." is a lie while the video after the playhead is still unanalyzed: the next
  // moment by time may simply not exist yet. Say nothing rather than point at the wrong one.
  const nextIsKnown = props.done || isAnalyzed(props.ranges, upcoming?.start ?? currTime);

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
    video.currentTime = seekTo;
    // Keep the chrome in step immediately rather than waiting for the next presented frame,
    // so the now-line and the lit mark move with the key rather than a beat behind it.
    chromeTimeRef.current = seekTo;
    setCurrTime(seekTo);
  };

  // Core per-time update: selection, stable activity, scene tracking. Kept in a ref
  // so the rVFC loop always calls the freshest closure.
  const updateAtTime = (t: number) => {
    // The chrome (scrubber, timecode, now-line, current mark) updates at ~10Hz, not at the
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

    // Track the scene by its START, not its id: scenes are a partition that re-derives when
    // analysis finds a new cut, and ids shift by one when a cut lands earlier in the video —
    // the id changing under a stationary playhead is not a scene change.
    const scene = props.scenes.find((s) => t >= s.start && t <= s.end) ?? null;
    if (scene && scene.start !== currSceneStartRef.current) {
      const isFirst = currSceneStartRef.current === null;
      currSceneStartRef.current = scene.start;
      if (!isFirst && !jumped) {
        setSceneNotice(true);
        clearSceneNoticeTimeout();
        startSceneNoticeTimeout();
      }
    }

    props.onTimeChange?.(t);
  };
  const updateAtTimeRef = useRef(updateAtTime);
  updateAtTimeRef.current = updateAtTime;

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
          const t = seekTargetFor(target, props.selectOpts.lead) + props.selectOpts.lead + 0.2;
          video.currentTime = t;
          setPreviewJumped(true);
        }
      }
    } else if (preAppearanceTimeRef.current !== null) {
      video.currentTime = preAppearanceTimeRef.current;
      preAppearanceTimeRef.current = null;
      setPreviewJumped(false);
    }
  };

  // Mantine's useHotkeys ignores events from inputs and textareas — NOT from buttons. So
  // without this, Space on a focused control both activates it AND toggles play/pause, and
  // arrow keys on a moment mark both move focus AND seek/zoom. The headline "usable by
  // keyboard alone" criterion fails on contact.
  const stopPlayerHotkeys = (e: React.KeyboardEvent) => {
    if ([" ", "Spacebar", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.stopPropagation();
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

  useEffect(() => {
    const sync = () => {
      if (document.fullscreenElement) handleIsFullscreen.open();
      else handleIsFullscreen.close();
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleZoomShift = (shift: number) => {
    if (!isZoomIn) {
      handleZoom();
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
    const oldValue = video.currentTime;
    const newValue = Math.max(0, Math.min(totalTime, currTime + shift));
    video.currentTime = newValue;

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
    const timelineWidth = timeline.clientWidth || 1;
    video.currentTime = (timelineX / timelineWidth) * video.duration;
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
    setSceneNotice(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.src]);

  useEffect(() => {
    if (props.seekFnRef) {
      props.seekFnRef.current = (t: number) => {
        if (videoRef.current) videoRef.current.currentTime = t;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.seekFnRef]);

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
    <Box
      className={videoContainerClasses}
      ref={containerRef}
      onMouseMove={showControls}
      // The reveal triggers that make auto-hide safe. Pointer movement alone would delete the
      // moments and the controls for a keyboard or screen-reader user; focus and keypress
      // bring them back for everyone. (Pause is handled by the `clear` class, which is gated
      // on isPlaying.)
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
      {/* No py prop: it lands as an inline style and silently overrides the stylesheet's
          padding, so the bar's vertical rhythm ends up owned by two places. CSS owns it. */}
      {/* Keys pressed while focus is on a control in the bar belong to THAT control — the
          same rule the moments sidebar already applies. Without this, Space on the focused
          Mute button toggles playback instead of mute, and ArrowLeft on the volume slider
          nudges the volume AND seeks −5s (the document-level hotkeys see every bubbled
          keydown). The reveal is re-applied here because the stop also hides the event from
          the container's own reveal handler. */}
      <Box
        className="video-controls-container"
        ref={barSizeRef}
        onKeyDown={(e) => {
          showControls();
          e.stopPropagation();
        }}
      >
        <Box
          className="timeline-container"
          ref={trackRef}
          my={6}
          onMouseMove={handleSeek}
          onMouseDown={handleSeek}
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
        {markers.length > 0 && (
          <Box className="moment-lane" role="group" aria-label="Moments in this lecture">
            {markers.map((m) => {
              const isNow = currIndex >= 0 && m.activities.some((a) => a === currActivity);
              const label =
                m.activities.length === 1
                  ? `Moment ${m.index}, ${convertSecondsToTimecode(m.activities[0].start)}, ${(
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
                    if (v && props.canPlay) v.currentTime = seekTargetFor(m.activities[0], props.selectOpts.lead);
                  }}
                />
              );
            })}
          </Box>
        )}

        {/* The label is TEXT, in a live region — not a hover tooltip. The lane is a map; a row
            of identical rectangles tells a viewer nothing, and hover is invisible to a keyboard
            user, a screen reader, and anyone driving a magnifier. */}
        {props.activities.length > 0 && (
          <Box className="now-line" role="status">
            <span className={classNames("now-dot", { on: currIndex >= 0 })} />
            <Text>
              {currIndex >= 0 ? (
                <>
                  Moment <b>{currIndex + 1}</b>
                  {props.done ? <> of <b>{props.activities.length}</b></> : null}
                  {" · "}
                  <b>{convertSecondsToTimecode(props.activities[currIndex].start)}</b>,{" "}
                  {(props.activities[currIndex].end - props.activities[currIndex].start).toFixed(1)}s
                </>
              ) : props.done ? (
                <>
                  <b>{props.activities.length}</b> moments in this lecture
                </>
              ) : (
                <>
                  <b>{props.activities.length}</b> moments so far — still looking…
                </>
              )}
            </Text>
            {upcoming && nextIsKnown && (
              <Text className="now-next">
                Next at <b>{convertSecondsToTimecode(upcoming.start)}</b>
              </Text>
            )}
          </Box>
        )}

        {props.done && props.activities.length === 0 && (
          <Box className="now-line empty" role="status">
            <Text>
              No annotation moments found in this video — the highlight and magnifier have
              nothing to follow.
            </Text>
          </Box>
        )}

        <Group className="controls" gap={3} align="center" mt={4}>
          <UnstyledButton
            onClick={handlePlayPause}
            onKeyDown={stopPlayerHotkeys}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <IconPlayerPauseFilled /> : <IconPlayerPlayFilled />}
          </UnstyledButton>
          {props.activities.length > 0 && (
            <>
              <UnstyledButton
                className="collapse-hide"
                onClick={() => { showControls(); handleStepMoment(-1); }}
                onKeyDown={stopPlayerHotkeys}
                disabled={!props.canPlay}
                aria-label="Previous moment"
                title="Previous moment ( [ )"
              >
                <IconPlayerTrackPrevFilled />
              </UnstyledButton>
              <UnstyledButton
                className="collapse-hide"
                onClick={() => { showControls(); handleStepMoment(1); }}
                onKeyDown={stopPlayerHotkeys}
                disabled={!props.canPlay}
                aria-label="Next moment"
                title="Next moment ( ] )"
              >
                <IconPlayerTrackNextFilled />
              </UnstyledButton>
            </>
          )}
          <Box className="volume-container">
            <UnstyledButton onClick={handleMute} aria-label="Mute">
              {isMuted ? (
                <IconVolumeMute />
              ) : volume > 0.5 ? (
                <IconVolumeHigh />
              ) : (
                <IconVolumeLow />
              )}
            </UnstyledButton>
            <Slider
              className="volume-slider"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              min={0}
              max={1}
              step={0.01}
              label={() => `${Math.round(volume * 100)}%`}
            />
          </Box>
          <Group className="duration-container" gap="xs">
            <Text>{convertSecondsToTimecode(currTime)}</Text>
            <Text>/</Text>
            <Text>{convertSecondsToTimecode(totalTime)}</Text>
          </Group>
          {props.extraHud}
          <Popover
            position="top-end"
            withinPortal={false}
            classNames={{ dropdown: "ap-pop" }}
            opened={appearanceOpen}
            onChange={handleAppearanceOpen}
            trapFocus
          >
            <Popover.Target>
              <UnstyledButton
                className="collapse-hide"
                onClick={() => handleAppearanceOpen(!appearanceOpen)}
                onKeyDown={stopPlayerHotkeys}
                aria-label="Appearance"
                aria-expanded={appearanceOpen}
              >
                <IconSparkles />
              </UnstyledButton>
            </Popover.Target>
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
            <UnstyledButton
              className="collapse-end"
              onClick={() => {
                if (!momentsOpen) handleCollapsed.open();
                handleMomentsOpen.toggle();
              }}
              onKeyDown={stopPlayerHotkeys}
              aria-label="Moments list"
              aria-expanded={momentsOpen}
            >
              <IconListDetails />
            </UnstyledButton>
          )}
          {/* collapse-end: the controls that stay to the RIGHT of the scrubber when the bar
              collapses to a single line. See the Collapsed block in player.css. */}
          <UnstyledButton
            className="collapse-end"
            onClick={handleFullscreen}
            aria-label="Fullscreen"
          >
            {isFullscreen ? <IconMaximizeOff /> : <IconMaximize />}
          </UnstyledButton>
          <UnstyledButton
            className="collapse-end"
            onClick={() => handleCollapsed.toggle()}
            onKeyDown={stopPlayerHotkeys}
            aria-label={collapsed ? "Expand controls" : "Collapse controls"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <IconChevronUp /> : <IconChevronDown />}
          </UnstyledButton>
        </Group>
      </Box>
      <video
        ref={videoMergedRef}
        src={props.src}
        onTimeUpdate={() => {
          // Fallback for browsers without rVFC + covers paused seeks.
          const v = videoRef.current;
          if (v) updateAtTimeRef.current(v.currentTime);
        }}
        onSeeked={() => props.onSeeked?.(videoRef.current?.currentTime ?? 0)}
        onPlay={handleIsPlaying.open}
        onPause={handleIsPlaying.close}
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
        {props.canPlay && atUnanalyzed && (
          <Box className="overlay-catching-up">Analyzing this part…</Box>
        )}
        {/* Moving someone's playhead without saying so feels like a glitch. Say so. */}
        {previewJumped && (
          <Box className="overlay-preview-jump" role="status">
            Jumped to a moment so you can see your changes · returns when you close
          </Box>
        )}
        {sceneNotice && (
          <Box className={classNames("overlay-scene", { stacked: atUnanalyzed })} role="status">
            <IconSwitchHorizontal size={16} />
            Possible scene change
          </Box>
        )}
      </Box>
      {/* The fullscreen mount of the moments list. Same component as the page sidebar —
          the current row and the on-video highlight come from this player's own
          currActivity, so they cannot disagree. Anchored above the measured bar so it
          never covers the controls, whichever state the bar is in. */}
      {isFullscreen && momentsOpen && (
        <MomentsSidebar
          className="overlay"
          activities={props.activities}
          scenes={props.scenes}
          thumbs={props.thumbs ?? EMPTY_THUMBS}
          current={currActivity}
          done={props.done}
          canPlay={props.canPlay}
          lead={props.selectOpts.lead}
          onJump={(t) => {
            const v = videoRef.current;
            if (v && props.canPlay) v.currentTime = t;
          }}
          style={{ bottom: barHeight + 24, maxHeight: `calc(100% - ${barHeight + 48}px)` }}
        />
      )}
      <SVGFilters />
    </Box>
  );
};

export default VideoPlayer;
