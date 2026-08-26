// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
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

/**
 * The display's current devicePixelRatio, re-read when it changes — which it does when the
 * window moves between monitors, or when the viewer changes their OS scaling or browser zoom.
 * A canvas sized for the old ratio would stay soft until something else happened to re-render.
 */
function useDevicePixelRatio(): number {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined") return () => {};
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1),
    () => 1
  );
}

const EnhanceCanvas = ({ videoRef, filters, source, width, height, className }: Props) => {
  const dpr = useDevicePixelRatio();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<GLEnhancer | null>(null);
  const glFailedRef = useRef(false);
  const redrawRef = useRef<() => void>(() => {});
  // Latest props in refs so the frame loop never needs tearing down mid-activity —
  // and so an on-demand redraw always paints with the current filters/source.
  const srcRef = useRef(source);
  srcRef.current = source;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const dprRef = useRef(dpr);
  dprRef.current = dpr;

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

    const { stop, redraw } = driveFrames(video, () => {
      const s = srcRef.current;
      if (!video.videoWidth || s.width <= 0 || s.height <= 0) return;
      if (gl) {
        gl.draw(video, { filters: filtersRef.current, source: s, pixelRatio: dprRef.current });
      } else if (ctx2d) {
        ctx2d.drawImage(video, s.x, s.y, s.width, s.height, 0, 0, canvas.width, canvas.height);
      }
    });
    redrawRef.current = redraw;
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, filters.length === 0]);

  // rVFC doesn't fire while the video is paused, so a filter toggled (or the region
  // changing) would otherwise keep showing the previous render until playback resumed.
  useEffect(() => {
    redrawRef.current();
  }, [filters.join(","), source.x, source.y, source.width, source.height, width, height, dpr]);

  useEffect(() => {
    return () => {
      glRef.current?.dispose();
      glRef.current = null;
    };
  }, []);

  if (filters.length === 0) return null;

  // The canvas is sized TWICE, and the two sizes are not the same number.
  //
  // Its CSS box is the exact, unrounded extent it was asked for. That matters because the
  // crop is drawn to fill the whole canvas: display it at a rounded width and every copied
  // pixel is stretched by roundedWidth/width, so the enhanced patch stops sitting 1:1 on the
  // frame beneath it. On a 65.625px circle that is a 0.57% stretch — under half a pixel in
  // the middle, but it accumulates outward and the edges of the ink visibly slide off the
  // writing they came from. It also left the clip revealing 52.8px of a 52.5px ring.
  //
  // Its BACKING STORE is that box in device pixels. A CSS-sized bitmap on a 150% or 200%
  // display is upscaled by the compositor — a blurred copy of the lecture laid over the sharp
  // original, which is the opposite of what an enhance filter is for.
  const cssWidth = Math.max(1, width);
  const cssHeight = Math.max(1, height);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={Math.max(1, Math.round(cssWidth * dpr))}
      height={Math.max(1, Math.round(cssHeight * dpr))}
      style={{
        width: `${cssWidth}px`,
        height: `${cssHeight}px`,
        // CSS SVG filters only on the fallback path — the GL path bakes them in.
        ...(glFailedRef.current
          ? { filter: filters.map((f) => `url(#svgf-${f})`).join(" ") }
          : {}),
      }}
    />
  );
};

export default EnhanceCanvas;
