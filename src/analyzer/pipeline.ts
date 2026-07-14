// Frame-diff pipeline, pure functions on pixel buffers. Ports the used subset of
// the Python analyzer (analyzer.py _detect_contours + _contours_to_roi_nodes):
// grayscale absdiff -> threshold -> dilate -> connected-component boxes.
// OpenCV.js is intentionally NOT used: at analysis resolution these are ~100 lines.

import type { Box } from "./types";

// How much of the frame changed: the share of mask pixels that are set. This is the
// scene-cut signal.
//
// It replaces a port of PySceneDetect's ContentDetector (mean HSV delta over every pixel).
// That detector is built for film, where a cut changes the whole frame. A lecture deck is the
// opposite case: consecutive slides share a background, a header and a layout, and only the
// text differs — so a real slide change moves a fifth of the pixels a lot and leaves the rest
// identical, and the MEAN washes it out. Measured on a 59-minute lecture: every slide change
// scored 2.5 or less against a threshold of 27, and not one was detected.
//
// Counting changed pixels instead separates the same footage by an order of magnitude at each
// end — writing and the webcam sit under 2% of the frame, slide changes land at 20–30%, hard
// cuts above 70%. See decisions.md.
export function changedFrac(mask: Uint8Array): number {
  let on = 0;
  for (let i = 0; i < mask.length; i++) on += mask[i];
  return on / mask.length;
}

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
// Also returns the raw magnitudes so region stats can record change intensity.
export function diffMask(
  a: Uint8Array,
  b: Uint8Array,
  w: number,
  h: number,
  thresh = 25
): { mask: Uint8Array; mag: Uint8Array } {
  const mask = new Uint8Array(w * h);
  const mag = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    const d = a[i] - b[i];
    const m = d < 0 ? -d : d;
    mag[i] = m;
    mask[i] = m >= thresh ? 1 : 0;
  }
  return { mask: box3Blur(mask, w, h), mag };
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

// Change occupancy. `occ[i]` is an EMA of "did pixel i change?" — roughly, the fraction of
// recent frames in which it did. It's what separates *structural* motion (a talking-head
// webcam overlay, an animated logo, a scrolling ticker, a blinking caret) from instructor
// activity: a pen crosses a given pixel for a frame or two and then leaves it alone, so its
// pixels sit near zero, while an overlay keeps its pixels churning for the whole video.
//
// It is deliberately a per-pixel SCORE and not a per-pixel veto. Zeroing high-occupancy
// pixels out of the mask was the first thing tried and it doesn't hold up on real video: a
// person moves, so only the core of the head sits at ~0.9 while the silhouette edges hover
// around 0.3-0.5. Delete the core and the edges still form regions in the corner, and the
// highlight stays right where it was. What's reliable is not "this pixel always changes" but
// "every pixel in this region changes far more often than ink does" — a region-level, then
// activity-level judgement. See componentRegions' `occ` and ActivityFeatures.flaggedFrac.
//
// Updated from the raw mask each frame, before any region work.
export function updateOccupancy(mask: Uint8Array, occ: Float32Array, alpha = OCC_ALPHA): void {
  for (let i = 0; i < mask.length; i++) occ[i] += alpha * (mask[i] - occ[i]);
}

// EMA weight: ~20-frame memory, so an overlay is learned within ~4 s of a segment's start at
// the default 0.2 s sampling, and a layout change re-adapts about as fast.
// ponytail: fixed; promote to a parameter only if a real video needs a different memory.
const OCC_ALPHA = 0.05;

// A changed region: bbox plus the stats ML will want later, all computed during the
// same flood-fill pass (this data is unrecoverable after analysis — capture at source).
export type Region = {
  box: Box;
  mass: number; // changed-pixel count ("how much ink", vs bbox = "how big a box")
  cx: number; // mask centroid, analysis-res px
  cy: number;
  hu: number[]; // 7 Hu moment invariants of the mask shape (what cv2.matchShapes used)
  meanDiff: number; // mean |frame delta| over the region's pixels (cursor≈subtle, ink≈strong)
  occ: number; // mean change-occupancy over the region's pixels, 0..1 — how habitually this
  // patch of frame moves. Ink is ~0.05 (a pixel is written once and then left alone); a
  // webcam overlay is ~0.4-0.9 (its pixels never stop). See updateOccupancy.
};

// Connected-component regions via iterative flood fill (4-connectivity).
// Filters by area fraction of the frame, matching contour_area_low/high.
export function componentRegions(
  mask: Uint8Array,
  w: number,
  h: number,
  areaLowFrac = 0.00015,
  areaHighFrac = 0.5,
  mag?: Uint8Array,
  occ?: Float32Array
): Region[] {
  const seen = new Uint8Array(w * h);
  const regions: Region[] = [];
  const areaLow = areaLowFrac * w * h;
  const areaHigh = areaHighFrac * w * h;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    // Raw moments m[p][q] = sum x^p y^q over mask pixels, up to 3rd order.
    let m00 = 0, m10 = 0, m01 = 0, m20 = 0, m11 = 0, m02 = 0, m30 = 0, m21 = 0, m12 = 0, m03 = 0;
    let magSum = 0;
    let occSum = 0;
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
      m00 += 1; m10 += x; m01 += y;
      m20 += x * x; m11 += x * y; m02 += y * y;
      m30 += x * x * x; m21 += x * x * y; m12 += x * y * y; m03 += y * y * y;
      if (mag) magSum += mag[i];
      if (occ) occSum += occ[i];
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const area = bw * bh;
    if (area >= areaLow && area <= areaHigh) {
      regions.push({
        box: { x: minX, y: minY, w: bw, h: bh },
        mass: m00,
        cx: m10 / m00,
        cy: m01 / m00,
        hu: huMoments(m00, m10, m01, m20, m11, m02, m30, m21, m12, m03),
        meanDiff: mag ? magSum / m00 : 0,
        occ: occ ? occSum / m00 : 0,
      });
    }
  }
  return regions;
}

// The 7 Hu moment invariants from raw moments — invariant under translation, scale
// and rotation, which is why cv2.matchShapes is built on them.
function huMoments(
  m00: number, m10: number, m01: number,
  m20: number, m11: number, m02: number,
  m30: number, m21: number, m12: number, m03: number
): number[] {
  const cx = m10 / m00;
  const cy = m01 / m00;
  // Central moments
  const mu20 = m20 - cx * m10;
  const mu02 = m02 - cy * m01;
  const mu11 = m11 - cx * m01;
  const mu30 = m30 - 3 * cx * m20 + 2 * cx * cx * m10;
  const mu21 = m21 - 2 * cx * m11 - cy * m20 + 2 * cx * cx * m01;
  const mu12 = m12 - 2 * cy * m11 - cx * m02 + 2 * cy * cy * m10;
  const mu03 = m03 - 3 * cy * m02 + 2 * cy * cy * m01;
  // Normalized central moments: eta_pq = mu_pq / m00^(1 + (p+q)/2)
  const n2 = m00 * m00;
  const n3 = Math.pow(m00, 2.5);
  const e20 = mu20 / n2, e02 = mu02 / n2, e11 = mu11 / n2;
  const e30 = mu30 / n3, e21 = mu21 / n3, e12 = mu12 / n3, e03 = mu03 / n3;

  const h1 = e20 + e02;
  const h2 = (e20 - e02) ** 2 + 4 * e11 ** 2;
  const h3 = (e30 - 3 * e12) ** 2 + (3 * e21 - e03) ** 2;
  const h4 = (e30 + e12) ** 2 + (e21 + e03) ** 2;
  const h5 =
    (e30 - 3 * e12) * (e30 + e12) * ((e30 + e12) ** 2 - 3 * (e21 + e03) ** 2) +
    (3 * e21 - e03) * (e21 + e03) * (3 * (e30 + e12) ** 2 - (e21 + e03) ** 2);
  const h6 =
    (e20 - e02) * ((e30 + e12) ** 2 - (e21 + e03) ** 2) +
    4 * e11 * (e30 + e12) * (e21 + e03);
  const h7 =
    (3 * e21 - e03) * (e30 + e12) * ((e30 + e12) ** 2 - 3 * (e21 + e03) ** 2) -
    (e30 - 3 * e12) * (e21 + e03) * (3 * (e30 + e12) ** 2 - (e21 + e03) ** 2);
  return [h1, h2, h3, h4, h5, h6, h7];
}
