// Frame-diff pipeline, pure functions on pixel buffers. Ports the used subset of
// the Python analyzer (analyzer.py _detect_contours + _contours_to_roi_nodes):
// grayscale absdiff -> threshold -> dilate -> connected-component boxes.
// OpenCV.js is intentionally NOT used: at analysis resolution these are ~100 lines.

import type { Box } from "./types";

// OpenCV BGR2GRAY weights (applied to RGBA input).
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0;
  }
  return g;
}

// |a - b| per pixel, thresholded to a 0/1 mask. (Python: absdiff -> GaussianBlur ->
// threshold@25. The blur mainly de-noises; at low res a 3x3 box blur is enough and
// cheaper — ponytail: swap in separable Gaussian if golden validation needs it.)
export function diffMask(a: Uint8Array, b: Uint8Array, w: number, h: number, thresh = 25): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    const d = a[i] - b[i];
    mask[i] = (d < 0 ? -d : d) >= thresh ? 1 : 0;
  }
  return box3Blur(mask, w, h);
}

// 3x3 majority-ish smoothing on the binary mask (stand-in for pre-threshold blur).
function box3Blur(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let s = 0;
      s += mask[i - w - 1] + mask[i - w] + mask[i - w + 1];
      s += mask[i - 1] + mask[i] + mask[i + 1];
      s += mask[i + w - 1] + mask[i + w] + mask[i + w + 1];
      out[i] = s >= 3 ? 1 : 0;
    }
  }
  return out;
}

// Dilate the mask in place-ish (Python: cv2.dilate iterations=3). 3x3 max, N passes.
export function dilate(mask: Uint8Array, w: number, h: number, iters = 3): Uint8Array {
  let cur = mask;
  for (let k = 0; k < iters; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (
          cur[i] ||
          cur[i - 1] ||
          cur[i + 1] ||
          cur[i - w] ||
          cur[i + w] ||
          cur[i - w - 1] ||
          cur[i - w + 1] ||
          cur[i + w - 1] ||
          cur[i + w + 1]
        ) {
          out[i] = 1;
        }
      }
    }
    cur = out;
  }
  return cur;
}

// Connected-component bounding boxes via iterative flood fill (4-connectivity).
// Filters by area fraction of the frame, matching contour_area_low/high.
export function componentBoxes(
  mask: Uint8Array,
  w: number,
  h: number,
  areaLowFrac = 0.00015,
  areaHighFrac = 0.5
): Box[] {
  const seen = new Uint8Array(w * h);
  const boxes: Box[] = [];
  const areaLow = areaLowFrac * w * h;
  const areaHigh = areaHighFrac * w * h;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const area = bw * bh;
    if (area >= areaLow && area <= areaHigh) {
      boxes.push({ x: minX, y: minY, w: bw, h: bh });
    }
  }
  return boxes;
}
