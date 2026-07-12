// Mirrors a region of the video into a canvas and applies the enhance filters to it.
//
// This exists because `backdrop-filter: url(#svg-filter)` — what the study player used
// for the highlight's filters — is unsupported in Firefox and Safari, and in Firefox it
// makes the element vanish entirely rather than degrade (docs/decisions.md D14).
//
// Rendering is WebGL when available (D15): SVG reference filters like feConvolveMatrix
// run in the browser's SOFTWARE filter path, re-executed per frame — visibly loading the
// CPU. The same effects as fragment shaders cost microseconds of GPU. The 2D canvas +
// CSS `filter: url(#…)` path remains as the no-WebGL fallback.
//
// Redraws are driven by requestVideoFrameCallback: only when the video presents a NEW
// frame (30/s for typical lectures, zero while paused) instead of every display refresh.
import { useEffect, useRef, type RefObject } from "react";
import type { TFilterStyle } from "../stores/HighlightSettingsStore";
import { GLEnhancer, driveFrames } from "./glEnhance";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  filters: TFilterStyle[];
  /** Source region in native video pixels. */
  source: { x: number; y: number; width: number; height: number };
  /** Rendered size in CSS pixels. */
  width: number;
  height: number;
  className?: string;
};

const EnhanceCanvas = ({ videoRef, filters, source, width, height, className }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<GLEnhancer | null>(null);
  const glFailedRef = useRef(false);
  // Latest props in refs so the frame loop never needs tearing down mid-activity.
  const srcRef = useRef(source);
  srcRef.current = source;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || filters.length === 0) return;

    if (!glRef.current && !glFailedRef.current) {
      glRef.current = GLEnhancer.create(canvas);
      if (!glRef.current) glFailedRef.current = true;
    }
    const gl = glRef.current;
    const ctx2d = gl ? null : canvas.getContext("2d");

    const stop = driveFrames(video, () => {
      const s = srcRef.current;
      if (!video.videoWidth || s.width <= 0 || s.height <= 0) return;
      if (gl) {
        gl.draw(video, { filters: filtersRef.current, source: s });
      } else if (ctx2d) {
        ctx2d.drawImage(video, s.x, s.y, s.width, s.height, 0, 0, canvas.width, canvas.height);
      }
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, filters.length === 0]);

  useEffect(() => {
    return () => {
      glRef.current?.dispose();
      glRef.current = null;
    };
  }, []);

  if (filters.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={Math.max(1, Math.round(width))}
      height={Math.max(1, Math.round(height))}
      // CSS SVG filters only on the fallback path — the GL path bakes them in.
      style={
        glFailedRef.current
          ? { filter: filters.map((f) => `url(#svgf-${f})`).join(" ") }
          : undefined
      }
    />
  );
};

export default EnhanceCanvas;
