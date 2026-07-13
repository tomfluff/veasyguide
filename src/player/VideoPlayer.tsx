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
  IconZoomInAreaFilled,
  IconArrowBigLeftLineFilled,
  IconArrowBigRightLineFilled,
  IconZoom,
  IconSwitchHorizontal,
  IconPlayerTrackPrevFilled,
  IconPlayerTrackNextFilled,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import classNames from "classnames";
import { convertSecondsToTimecode } from "../utils/misc";
import { selectActivity, type SelectOpts } from "../analyzer/select";
import { isAnalyzed } from "../analyzer/ranges";
import type { Activity, AnalysisMeta, Range, Scene } from "../analyzer/types";
import { toPlayerActivity } from "./types";
import { computeLetterbox } from "./geometry";
import { timelineMarkers, stepMoment, seekTargetFor } from "./moments";
import HighlightIndicator from "./HighlightIndicator";
import MagnificationOverlay from "./MagnificationOverlay";
import SVGFilters from "./SVGFilters";
import HighlightIndicatorSettings from "./HighlightIndicatorSettings";
import MagnificationOverlaySettings from "./MagnificationOverlaySettings";
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
  selectOpts: SelectOpts;
  onSeeked?: (t: number) => void;
  onTimeChange?: (t: number) => void;
  // Fires only when the highlighted moment CHANGES — not per frame. The moments sidebar
  // needs to know which card is current, and only the player derives that (it runs
  // selectActivity on the rVFC loop; App sees time at a 0.2s throttle). Re-deriving it in
  // App would let the highlighted card drift from the highlight on the video.
  onActivityChange?: (activity: Activity | null) => void;
  // Assigned a seek function so external UI (debug views) can move the playhead.
  seekFnRef?: React.MutableRefObject<(t: number) => void>;
  extraHud?: ReactNode;
};

const FLASH_SPEED = 250;
const SCENE_NOTICE_MS = 2500;

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
  const [popoverOpacity, setPopoverOpacity] = useState(0.5);
  const [sceneNotice, setSceneNotice] = useState(false);
  const currSceneIdRef = useRef<number | null>(null);
  const prevTimeRef = useRef(0);
  const lastReportedActivityRef = useRef<number | null>(null);
  const chromeTimeRef = useRef(-1);

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
    useTimeout(() => handleHideControls.open(), 2000);
  const { start: startSceneNoticeTimeout, clear: clearSceneNoticeTimeout } = useTimeout(
    () => setSceneNotice(false),
    SCENE_NOTICE_MS
  );
  useHotkeys([
    ["Space", () => handlePlayPause()],
    ["F", () => handleFullscreen()],
    ["M", () => handleMute()],
    ["Z", () => handleZoom()],
    ["ArrowLeft", () => handleTimeShift(-5)],
    ["ArrowRight", () => handleTimeShift(5)],
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
    showControls();
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

    const scene = props.scenes.find((s) => t >= s.start && t <= s.end) ?? null;
    if (scene && scene.id !== currSceneIdRef.current) {
      const isFirst = currSceneIdRef.current === null;
      currSceneIdRef.current = scene.id;
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
    currSceneIdRef.current = null;
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

  return (
    <Box
      className={videoContainerClasses}
      ref={containerRef}
      onMouseMove={showControls}
      // The reveal triggers that make auto-hide safe. Pointer movement alone would delete the
      // moments and the controls for a keyboard or screen-reader user; focus and keypress
      // bring them back for everyone. (Pause is handled by the `clear` class, which is gated
      // on isPlaying.)
      onKeyDown={showControls}
      onFocusCapture={showControls}
    >
      <Box className="video-controls-container" py="sm">
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

        <Group className="controls" gap={6} align="center" mt={8}>
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
                onClick={() => handleStepMoment(-1)}
                onKeyDown={stopPlayerHotkeys}
                disabled={!props.canPlay}
                aria-label="Previous moment"
                title="Previous moment ( [ )"
              >
                <IconPlayerTrackPrevFilled />
              </UnstyledButton>
              <UnstyledButton
                className="collapse-hide"
                onClick={() => handleStepMoment(1)}
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
          <Popover width={360} position="top-end" shadow="md">
            <Popover.Target>
              <UnstyledButton className="collapse-hide" aria-label="Magnification settings">
                <IconZoomInAreaFilled />
              </UnstyledButton>
            </Popover.Target>
            <Popover.Dropdown
              style={{ transition: "opacity 0.2s" }}
              opacity={popoverOpacity}
              onMouseEnter={() => setPopoverOpacity(1)}
              onMouseLeave={() => setPopoverOpacity(0.5)}
            >
              <MagnificationOverlaySettings />
            </Popover.Dropdown>
          </Popover>
          <Popover width={420} position="top-end" shadow="md">
            <Popover.Target>
              <UnstyledButton className="collapse-hide" aria-label="Highlight settings">
                <IconSparkles />
              </UnstyledButton>
            </Popover.Target>
            <Popover.Dropdown
              style={{ transition: "opacity 0.2s" }}
              opacity={popoverOpacity}
              onMouseEnter={() => setPopoverOpacity(1)}
              onMouseLeave={() => setPopoverOpacity(0.5)}
            >
              <HighlightIndicatorSettings />
            </Popover.Dropdown>
          </Popover>
          <UnstyledButton onClick={handleFullscreen} aria-label="Fullscreen">
            {isFullscreen ? <IconMaximizeOff /> : <IconMaximize />}
          </UnstyledButton>
          <UnstyledButton
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
        {!props.canPlay && (
          <Box className="overlay-gate">Analyzing… playback starts shortly</Box>
        )}
        {props.canPlay && atUnanalyzed && (
          <Box className="overlay-catching-up">Analyzing this part…</Box>
        )}
        {sceneNotice && (
          <Box className={classNames("overlay-scene", { stacked: atUnanalyzed })} role="status">
            <IconSwitchHorizontal size={16} />
            Possible scene change
          </Box>
        )}
      </Box>
      <SVGFilters />
    </Box>
  );
};

export default VideoPlayer;
