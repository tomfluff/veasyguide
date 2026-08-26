// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the highlight measures in — and why one half of it measures in something else.
//
// Two quantities live in the highlight and they belong to two different spaces:
//
//   THE BOX  is a video-space quantity. Where the highlight sits and how much ink it
//            covers comes from the analyzer in native video pixels and is converted with
//            `scaleRatio` (geometry.ts). It MUST track the video: a 480p recording and a
//            4K one need the box drawn around the same pen strokes.
//
//   THE DECORATION — border thickness, pointer size, the fixed circle's diameter — is not
//            a property of the lecture. It is what this viewer told us their eyes need.
//            "10px" in the Appearance sheet has to mean ten pixels on their monitor: the
//            same ten pixels as everywhere else on their screen.
//
// It used to measure both in video space. `border_width` was multiplied by `scaleRatio`
// and then the whole border-bearing element was scaled again by the Size setting, so a
// configured 10px border was measured on screen as:
//
//     1920x1080 lecture in a 960px player   5.25 px
//     1280x720  lecture in a 960px player   7.35 px
//      640x360  lecture in a 960px player  15.75 px
//
// Same setting, same monitor, same window — five times the thickness, decided by which
// file was opened. The pointer had the same defect. For a tool whose users cannot simply
// look harder, "10" meaning anything from 3 to 16 is not a cosmetic bug.
//
// WHY NO CSS `transform: scale()` ANYWHERE NEAR THE BORDER
//
// Dropping `* scaleRatio` is only half of it. A CSS transform scales everything the
// element paints, borders included, so a box scaled by the Size setting carries its
// border along; the optional pulse then swings it a further 25% three times per moment.
// Counter-scaling the declared width (asking for `10 / 1.05` so it lands at 10) does not
// work either: Blink floors a used `border-width` to a whole CSS pixel, so 9.52px is
// painted as 9px and lands at 9.45. The only reliable rule is the structural one —
// **nothing between the border and the viewport may scale** — so the box's size is
// computed here, in CSS pixels, and applied as width/height instead of as a transform.
// The pulse animates those same lengths (see `@keyframes pulse` in player.css).
//
// WHY CSS PIXELS AND NOT PHYSICAL DEVICE PIXELS
//
// "Pixel-perfect with the monitor" has a second reading that is a trap. A CSS pixel is
// the browser's device-independent unit: on a 2x display one CSS px is two hardware
// pixels, and at 200% browser zoom it is two more. Dividing by `devicePixelRatio` to
// reach "real" hardware pixels would make the border thinner on exactly the high-density
// screens where it is hardest to see, and would shrink it when a low-vision viewer zooms
// in — the one action they take to make things bigger. DESIGN.md commits to browser zoom
// as the magnification path for the same reason. CSS px is the unit that keeps the
// promise: 10 is 10 whatever the video is, and it grows with zoom instead of fighting it.

/** The animations that make up one throb: the box's own, and the enhance canvas's clip in
 * each of its two shapes. Kept together because they are one cue in two elements, and
 * restarting one without the other is what "out of step" means here. */
const THROB_ANIMATIONS = ["pulse", "ink-spread", "ink-spread-round"];

/**
 * Whether this is one of the throb's animations, and therefore something to rewind when the
 * highlight moves to a new moment.
 *
 * Takes an `Animation` rather than a name because the decision is the whole point:
 * `getAnimations()` returns more than CSS animations. It also hands back CSSTransitions —
 * here, the wrapper's 350ms glide of left/top/width/height, which is running at exactly the
 * instant this is asked, because the highlight just moved. A transition has no
 * `animationName`, and reading through it threw inside an effect and took the player down on
 * every moment handover. So: ask, do not assume, and match the names exactly rather than by
 * prefix — a future `ink-spread-preview` is not part of this throb.
 */
export function isThrobAnimation(a: Animation): boolean {
  const name = (a as Partial<CSSAnimation>).animationName;
  return name !== undefined && THROB_ANIMATIONS.includes(name);
}

/** The top of a throb, as a multiple of the resting box. MUST match the 1.25 in
 * `@keyframes pulse` (player.css) — the canvas extent and the ink-spread clip are both
 * derived from it, so if they disagree the ink and the border stop lining up at the peak. */
export const PULSE_PEAK = 1.25;

/** Slack between the ink the analyzer found and the box drawn around it. The box has to
 * clear the strokes rather than sit on them, so the Size setting's "100%" draws at 105%. */
export const BOX_SLACK = 0.05;

/** How far the pointer's tip sinks into the box, as a fraction of the POINTER's own size.
 * It used to be 5% of the activity rectangle, which made the overlap depend on how big a
 * thing the instructor happened to be writing — swallowing the pointer whole on a tall
 * activity and barely touching the corner on a short one. */
const POINTER_OVERLAP = 0.1;

/** The highlight settings that decide geometry. */
export type IndicatorSizing = {
  base_scale: number;
  base_size: number;
  border_width: number;
  pointer_scale: number;
  shape_style: string;
  animation_style: string;
};

/** The activity rectangle, already converted to CSS px (scaleRatio applied). */
export type ActivityBox = { width: number; height: number };

export type IndicatorMetrics = {
  /** Border thickness in CSS px. Literal: no scaleRatio, no transform above it. */
  borderWidth: number;
  /** The box at rest, in CSS px. */
  restWidth: number;
  restHeight: number;
  /** The box at the top of a throb, in CSS px. Equals rest when the pulse is off. */
  peakWidth: number;
  peakHeight: number;
  /**
   * The same two sizes as CSS *lengths* for the box element, rest and peak.
   *
   * For the dynamic square these are percentages of the wrapper rather than the pixel
   * values above, and that is load-bearing: the wrapper tweens its own width and height
   * over 350ms when the highlight moves to the next moment, and a percentage re-resolves
   * against it on every frame of that tween. Pixels baked in at render time would snap to
   * the new size while the wrapper was still gliding toward it, tearing the border away
   * from the box it belongs to. The fixed circle does not depend on the wrapper at all, so
   * it stays in px.
   */
  cssWidth: string;
  cssHeight: string;
  cssPeakWidth: string;
  cssPeakHeight: string;
  /** The pointer's WIDTH in CSS px. Its height is left to the artwork, which is not square. */
  pointerSize: number;
  /** How far the pointer's tip sits inside the shape's edge, in CSS px. */
  pointerOverlap: number;
  /** Where the pointer's tip goes, as CSS lengths for its `left` and `top`. */
  pointerLeft: string;
  pointerTop: string;
  /** True when the pulse is on — the box breathes and the enhance canvas is clipped. */
  pulsing: boolean;
};

/**
 * The highlight's on-screen geometry, in CSS pixels.
 *
 * `activity` is the analyzer's rectangle ALREADY in CSS px; it is the only argument that
 * carries anything video-shaped, and it only reaches the dynamic-square box. Everything
 * else here is screen-space by construction, which is the property this module exists to
 * guarantee.
 */
export function indicatorMetrics(
  s: IndicatorSizing,
  activity: ActivityBox
): IndicatorMetrics {
  const scale = s.base_scale + BOX_SLACK;
  const pulsing = s.animation_style !== "none";

  // "Fixed circle" means fixed on the SCREEN, so its diameter is a screen length and the
  // activity's size does not enter into it. base_scale is applied ONCE, here: it used to
  // be multiplied in AND carried by the transform, which made the diameter quadratic in
  // the Size setting (0.5x drew a 14px circle, 2x drew a 205px one, and only 1x was right).
  const circle = s.shape_style === "static-circle";
  const restWidth = circle ? s.base_size * scale : activity.width * scale;
  const restHeight = circle ? s.base_size * scale : activity.height * scale;
  const throb = pulsing ? PULSE_PEAK : 1;
  const pointerSize = s.pointer_scale * s.base_size * 0.5;
  const overlap = pointerSize * POINTER_OVERLAP;

  // Where the pointer's tip goes.
  //
  // For the square this is the bottom-left CORNER, sunk a little way in — and it stays a
  // percentage so it keeps following the wrapper while that tweens to the next moment.
  //
  // A circle has no corner there. Anchoring to its bounding box's bottom-left would leave the
  // pointer floating in the empty quadrant outside the disc, and the old code compensated by
  // translating it up by its own height — which on a 52.5px circle is 35px, dropping the tip
  // into the MIDDLE of the disc, on top of the very thing the circle was drawn around. The
  // honest analogue of a corner on a circle is the point of its circumference facing the same
  // way: 225 degrees, down and to the left. Walk out from the centre by the radius, less the
  // same overlap, along that diagonal.
  const r = restWidth / 2;
  const diagonal = Math.SQRT1_2; // cos 45 deg — the down-left direction, per axis
  const pointer = circle
    ? {
        left: `${r - (r - overlap) * diagonal}px`,
        top: `${r + (r - overlap) * diagonal}px`,
      }
    : { left: "0px", top: `calc(100% - ${overlap}px)` };

  const pct = (k: number) => `calc(100% * ${k})`;
  const px = (v: number) => `${v}px`;

  return {
    borderWidth: s.border_width,
    restWidth,
    restHeight,
    peakWidth: restWidth * throb,
    peakHeight: restHeight * throb,
    cssWidth: circle ? px(restWidth) : pct(scale),
    cssHeight: circle ? px(restHeight) : pct(scale),
    cssPeakWidth: circle ? px(restWidth * throb) : pct(scale * throb),
    cssPeakHeight: circle ? px(restHeight * throb) : pct(scale * throb),
    pointerSize,
    pointerOverlap: overlap,
    pointerLeft: pointer.left,
    pointerTop: pointer.top,
    pulsing,
  };
}

/**
 * The region of the VIDEO that the enhance canvas copies, in native video pixels.
 *
 * The canvas is never scaled — it holds a picture of the lecture, and stretching it would
 * make the words under the highlight physically grow and shrink, which is a magnifier and
 * not an attention cue. So it is rendered at the box's widest extent, sourced 1:1, and the
 * ink-spread clip reveals more or less of it in step with the border.
 *
 * The crop is derived by converting the box's CSS extent BACK into video pixels rather
 * than by scaling the analyzer rectangle. For the dynamic square the two agree exactly;
 * for the fixed circle they do not, and the old code enhanced an activity-sized rectangle
 * underneath a 52px circle — so the bolder ink and the thing marking it disagreed.
 *
 * A source poking past the frame edge is fine: GL clamps to edge and 2D drawImage clips.
 */
export function enhanceSource(
  m: IndicatorMetrics,
  activity: { pos: { x: number; y: number }; dim: { width: number; height: number } },
  scaleRatio: number
) {
  // scaleRatio is 0 until the container has been measured. Dividing would give Infinity
  // and paint a garbage crop over the frame; an empty rect renders nothing, which is the
  // right answer for one frame.
  if (scaleRatio <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const width = m.peakWidth / scaleRatio;
  const height = m.peakHeight / scaleRatio;
  return {
    x: activity.pos.x + activity.dim.width / 2 - width / 2,
    y: activity.pos.y + activity.dim.height / 2 - height / 2,
    width,
    height,
  };
}
