// Ported from VeasyGuide MagnificationOverlay. Fixes vs original:
// 1. The canvas render loop ran drawImage(video) on EVERY animation frame forever,
//    even with the overlay invisible — a constant per-frame readback tax on all
//    playback, on exactly the weak hardware this app targets. The loop now only
//    runs while the overlay is shown (zoomIn), plus one final frame on hide.
// 2. pause_on_zoom un-zoom called video.play() unconditionally — force-playing a
//    video the user had paused themselves. The overlay now only resumes playback
//    if it was the one that paused it.
// 3. Two overlapping useEffects both called setZoom on activity change; merged.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMagnificationSettingsStore } from "../stores/MagnificationSettingsStore";
import { sanitizeFilters } from "../stores/HighlightSettingsStore";
import { zoomTransform } from "./zoom";
import { GLEnhancer, driveFrames } from "./glEnhance";
import type { PlayerActivity } from "./types";

type Pos = { x: number; y: number };

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  scaleRatio: number;
  zoomIn: boolean;
  activity: PlayerActivity | null | undefined;
};

const MagnificationOverlay = (props: Props) => {
  const settings = useMagnificationSettingsStore();
  const animationSpeeds = useMemo(
    () => ({
      transform: 250 / settings.zoom_speed,
      opacity: 150 / settings.zoom_speed,
    }),
    [settings.zoom_speed]
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedByZoomRef = useRef(false);
  const wasZoomInRef = useRef(false); // previous value of props.zoomIn (the user's toggle)
  const glRef = useRef<GLEnhancer | null>(null);
  const glFailedRef = useRef(false);
  const redrawRef = useRef<() => void>(() => {});

  const [zoomFactor, setZoomFactor] = useState(1);
  const [zoomShift, setZoomShift] = useState<Pos>({ x: 0, y: 0 });
  const [opacityLevel, setOpacityLevel] = useState(0);

  // Mirror the video onto the canvas — only while the overlay is visible, only when the
  // video presents a new frame (driveFrames), and via WebGL when available so the
  // enhance filters + contrast run as shaders instead of the CPU SVG-filter path (D15).
  useEffect(() => {
    const video = props.videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !props.zoomIn) return;

    if (!glRef.current && !glFailedRef.current) {
      glRef.current = GLEnhancer.create(canvas);
      if (!glRef.current) glFailedRef.current = true;
    }
    const gl = glRef.current;
    const ctx2d = gl ? null : canvas.getContext("2d");

    const { stop, redraw } = driveFrames(video, () => {
      const s = useMagnificationSettingsStore.getState();
      if (gl) {
        gl.draw(video, { filters: sanitizeFilters(s.filter_style), contrast: s.contrast });
      } else if (ctx2d) {
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
    });
    redrawRef.current = redraw;
    return stop;
  }, [props.videoRef, props.zoomIn]);

  // Settings changed while paused: rVFC won't fire, so repaint on demand or the
  // canvas keeps showing the previous filter until playback resumes.
  useEffect(() => {
    redrawRef.current();
  }, [settings.filter_style, settings.contrast]);

  useEffect(() => {
    return () => {
      glRef.current?.dispose();
      glRef.current = null;
    };
  }, []);

  const resetZoom = () => {
    setZoomFactor(1);
    setZoomShift({ x: 0, y: 0 });
  };

  const setZoom = () => {
    const canvas = canvasRef.current;
    const video = props.videoRef.current;
    if (!video || !canvas || !canvas.width || !canvas.height) return;

    const activity = props.activity;
    if (!activity) return;

    const W = canvas.width;
    const H = canvas.height;

    // Centre of the activity, in canvas pixels.
    const cx = props.scaleRatio * (activity.pos.x + activity.dim.width / 2);
    const cy = props.scaleRatio * (activity.pos.y + activity.dim.height / 2);

    let videoWidth = video.videoWidth;
    // If the aspect ratio is not 16:9, adjust the width accordingly
    // (the player CSS letterboxes the element at 16:9, as in the original).
    if (videoWidth / video.videoHeight !== 16 / 9) {
      videoWidth = video.videoHeight * (16 / 9);
    }
    // How far to zoom: enough to fill the frame with the activity, capped.
    const zoomStrength = useMagnificationSettingsStore.getState().zoom_strength;
    const f =
      1 +
      zoomStrength *
        Math.min(
          videoWidth / activity.dim.width - 1,
          video.videoHeight / activity.dim.height - 1,
          3
        );

    // Transform-origin is pinned at 0 0 and everything lives in one transform.
    //
    // The old code animated transform-origin (150ms) and transform (200ms) together.
    // A point's rendered position depends on BOTH, so mid-tween the two disagreed:
    // correct at the endpoints, wrong in between — and visibly wrong exactly where the
    // edge clamp was active, since the clamp term is zero in the middle of the frame
    // and non-zero near an edge. One animated property, one duration, fixes it.
    const { tx, ty } = zoomTransform(
      { x: cx - 0.5, y: cy - 0.5, width: 1, height: 1 }, // centre-only; box size is in `f`
      { width: W, height: H },
      f
    );

    setZoomShift({ x: tx, y: ty });
    setZoomFactor(f);
  };

  // Zoom state machine: enter, retarget on activity change, exit.
  useEffect(() => {
    const video = props.videoRef.current;
    // pause_on_zoom means "pause when the viewer zooms in", so it fires on the edge where
    // they turn zoom ON — not on every run of this effect. The effect also re-runs each
    // time the activity changes, and while zoom stays on the zoom merely retargets to the
    // new activity; pausing there would stop playback the viewer had resumed, again and
    // again. (handleZoom() won't let zoom turn on without an activity, so this edge always
    // coincides with a real zoom.)
    const zoomedInNow = props.zoomIn && !wasZoomInRef.current;
    wasZoomInRef.current = props.zoomIn;

    if (props.zoomIn && props.activity) {
      setZoom();
      setOpacityLevel(1);
      if (zoomedInNow && settings.pause_on_zoom && video && !video.paused) {
        video.pause();
        pausedByZoomRef.current = true;
      }
    } else {
      setOpacityLevel(0);
      resetZoom();
      // Only resume if this overlay paused it — never steal a user's pause.
      if (pausedByZoomRef.current) {
        pausedByZoomRef.current = false;
        if (video?.paused) void video.play();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.zoomIn, props.activity, props.scaleRatio, settings.zoom_strength]);

  const zoomTransitionOpacity = {
    transition: `opacity ${animationSpeeds.opacity}ms ease-in-out`,
  };

  // Only `transform` animates — see setZoom(). Animating transform-origin alongside it
  // (as the original did, at a different duration) is what made the motion jump.
  const zoomTransitionPosition = {
    transition: `transform ${animationSpeeds.transform}ms ease-in-out`,
  };

  return (
    <div
      className="magnification-wrapper"
      style={{
        opacity: opacityLevel,
        // The wrapper blocks the view when transparent otherwise
        pointerEvents: "none",
        ...zoomTransitionOpacity,
      }}
    >
      <div
        className="magnification-content"
        style={{
          // Fallback only: with WebGL, filters are baked into the canvas pixels (D15).
          filter: glFailedRef.current
            ? sanitizeFilters(settings.filter_style)
                .map((filter) => `url(#svgf-${filter})`)
                .join(" ")
            : undefined,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            transformOrigin: "0 0",
            transform: `translate(${zoomShift.x}px, ${zoomShift.y}px) scale(${zoomFactor})`,
            ...zoomTransitionPosition,
            filter: glFailedRef.current ? `contrast(${settings.contrast})` : undefined,
          }}
          width={(props.videoRef.current?.videoWidth ?? 0) * props.scaleRatio || 0}
          height={(props.videoRef.current?.videoHeight ?? 0) * props.scaleRatio || 0}
        />
      </div>
    </div>
  );
};

export default MagnificationOverlay;
