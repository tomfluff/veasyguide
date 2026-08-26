// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The property this file exists to pin down: the highlight's DECORATION is measured in
// screen pixels and its BOX is measured in the video. They were the same unit once, and a
// border the viewer set to 10px was drawn anywhere from 3px to 16px depending on which
// lecture file they opened. Nothing here should ever have to be "adjusted" for a video.
import { describe, it, expect } from "vitest";
import {
  indicatorMetrics,
  enhanceSource,
  isThrobAnimation,
  PULSE_PEAK,
  BOX_SLACK,
} from "./indicatorMetrics";
import type { IndicatorSizing } from "./indicatorMetrics";

const base: IndicatorSizing = {
  base_scale: 1,
  base_size: 50,
  border_width: 10,
  pointer_scale: 1,
  shape_style: "dynamic-square",
  animation_style: "none",
};

// One activity — a third of the frame — seen through four different videos. The CSS box is
// DERIVED from each case's scaleRatio here, exactly as HighlightIndicator derives it, so
// these numbers are exercised rather than merely labelled. Three of the four land on the
// same CSS rectangle through wildly different video resolutions; that is the point.
const VIDEOS = [
  { label: "1920x1080 in a 960px player", scaleRatio: 0.5, video: { width: 576, height: 324 } },
  { label: "1280x720 in a 960px player", scaleRatio: 0.75, video: { width: 384, height: 216 } },
  { label: "640x360 in a 960px player", scaleRatio: 1.5, video: { width: 192, height: 108 } },
  { label: "640x480 in a 320px player", scaleRatio: 0.375, video: { width: 192, height: 144 } },
];
const THROUGH_ANY_VIDEO = VIDEOS.map((v) => ({
  ...v,
  box: { width: v.scaleRatio * v.video.width, height: v.scaleRatio * v.video.height },
}));

describe("indicatorMetrics", () => {
  it("gives the border exactly the width the viewer asked for", () => {
    for (const w of [0, 1, 2, 4, 10, 12]) {
      expect(indicatorMetrics({ ...base, border_width: w }, { width: 288, height: 162 }))
        .toMatchObject({ borderWidth: w });
    }
  });

  it("keeps the border the same thickness through any video, player size or Size setting", () => {
    for (const c of THROUGH_ANY_VIDEO) {
      for (const size of [0.5, 1, 2]) {
        for (const shape of ["dynamic-square", "static-circle"]) {
          const m = indicatorMetrics({ ...base, base_scale: size, shape_style: shape }, c.box);
          expect(m.borderWidth, `${c.label} at ${size}x ${shape}`).toBe(10);
        }
      }
    }
  });

  it("does not thin the border down for a small activity", () => {
    // The tempting "fix" for a thick border on a thin annotation is to scale it down to fit.
    // That is the original bug wearing a different hat: it makes 10 mean something else
    // again. The box is allowed to be smaller than the ring; the ring is not negotiable.
    const tiny = indicatorMetrics({ ...base, border_width: 12 }, { width: 5, height: 4 });
    expect(tiny.borderWidth).toBe(12);
    // And the box must still report its own size rather than being widened to fit the ring —
    // a widened box no longer sits on the ink, and the enhance canvas beside it does not move.
    expect(tiny.restWidth).toBeCloseTo(5 * 1.05);
  });

  it("keeps the border the same thickness at every point of a pulse", () => {
    // The box breathes; the border does not. The CSS proves this structurally (the pulse
    // animates width/height, never a transform), so all this asserts is that no peak
    // variant of the border is ever produced for it to animate to.
    const still = indicatorMetrics(base, { width: 288, height: 162 });
    const throbbing = indicatorMetrics({ ...base, animation_style: "pulse" }, { width: 288, height: 162 });
    expect(throbbing.borderWidth).toBe(still.borderWidth);
    expect(throbbing.peakWidth).toBeGreaterThan(throbbing.restWidth);
  });

  it("keeps the pointer the same size through any video, Size setting or shape", () => {
    const sizes = new Set<number>();
    for (const c of THROUGH_ANY_VIDEO) {
      for (const size of [0.5, 1, 2]) {
        for (const shape of ["dynamic-square", "static-circle"]) {
          sizes.add(
            indicatorMetrics({ ...base, base_scale: size, shape_style: shape }, c.box).pointerSize
          );
        }
      }
    }
    // One value across 24 combinations: only `pointer_scale` may move it.
    expect([...sizes]).toEqual([25]); // pointer_scale 1 x base_size 50 x 0.5
  });

  it("scales the pointer by its own setting and nothing else", () => {
    for (const p of [0.5, 1, 1.5, 3]) {
      const m = indicatorMetrics({ ...base, pointer_scale: p }, { width: 288, height: 162 });
      expect(m.pointerSize).toBeCloseTo(p * 25);
      // The overlap is a fraction of the POINTER, so it cannot be swallowed by a tall
      // activity or vanish on a short one, which is what 5%-of-the-activity used to do.
      expect(m.pointerOverlap).toBeCloseTo(m.pointerSize * 0.1);
    }
  });

  describe("the box", () => {
    it("tracks the video, because that is what it is for", () => {
      // The one thing that SHOULD change with the video: a bigger on-screen activity gets
      // a bigger box. Otherwise the highlight stops sitting on the instructor's pen.
      const small = indicatorMetrics(base, { width: 72, height: 40.5 });
      const large = indicatorMetrics(base, { width: 288, height: 162 });
      expect(large.restWidth).toBeCloseTo(small.restWidth * 4);
      expect(small.restWidth).toBeCloseTo(72 * (1 + BOX_SLACK));
    });

    it("throbs to PULSE_PEAK only when the pulse is on", () => {
      const still = indicatorMetrics(base, { width: 288, height: 162 });
      expect(still.peakWidth).toBe(still.restWidth);
      expect(still.pulsing).toBe(false);

      const throbbing = indicatorMetrics({ ...base, animation_style: "pulse" }, { width: 288, height: 162 });
      expect(throbbing.peakWidth).toBeCloseTo(throbbing.restWidth * PULSE_PEAK);
      expect(throbbing.pulsing).toBe(true);
    });
  });

  describe("the fixed circle", () => {
    const circle = { ...base, shape_style: "static-circle" };

    it("is the same size whatever the video is doing", () => {
      const sizes = THROUGH_ANY_VIDEO.map((c) => indicatorMetrics(circle, c.box).restWidth);
      expect(new Set(sizes).size).toBe(1);
      expect(sizes[0]).toBeCloseTo(50 * (1 + BOX_SLACK));
    });

    it("applies the Size setting once, not twice", () => {
      // It used to be multiplied in here AND carried by a transform, so the diameter went
      // quadratic: 0.5x drew 13.75px and 2x drew 205px, and only 1x was right.
      const half = indicatorMetrics({ ...circle, base_scale: 0.5 }, { width: 288, height: 162 });
      const one = indicatorMetrics({ ...circle, base_scale: 1 }, { width: 288, height: 162 });
      const two = indicatorMetrics({ ...circle, base_scale: 2 }, { width: 288, height: 162 });
      expect(half.restWidth).toBeCloseTo(50 * 0.55);
      expect(one.restWidth).toBeCloseTo(50 * 1.05);
      expect(two.restWidth).toBeCloseTo(50 * 2.05);
      // Linear: equal steps in the setting must give equal steps in the diameter. Under
      // the old quadratic they were 13.75 -> 52.5 -> 107.6 -> 205 for 0.5/1/1.5/2.
      const at = (v: number) => indicatorMetrics({ ...circle, base_scale: v }, { width: 288, height: 162 }).restWidth;
      expect(at(1.5) - at(1)).toBeCloseTo(at(2) - at(1.5), 5);
      expect(at(1) - at(0.5)).toBeCloseTo(at(1.5) - at(1), 5);
    });

      it("puts the pointer's tip ON the circle, facing down-left", () => {
      // A circle has no bottom-left corner. Anchoring to its bounding box's would leave the
      // pointer floating in the empty quadrant; the old code compensated by lifting it by its
      // own height, which dropped the tip into the middle of the disc, covering the very
      // thing the circle was drawn around.
      const m = indicatorMetrics(circle, { width: 288, height: 162 });
      const r = m.restWidth / 2;
      const x = parseFloat(m.pointerLeft);
      const y = parseFloat(m.pointerTop);

      // On the circumference, less the overlap: distance from the centre is r - overlap.
      const dist = Math.hypot(x - r, y - r);
      expect(dist).toBeCloseTo(r - m.pointerOverlap, 5);
      // Down and to the LEFT of centre — the same quadrant the square's corner is in.
      expect(x).toBeLessThan(r);
      expect(y).toBeGreaterThan(r);
      // Symmetric about the 225-degree diagonal.
      expect(r - x).toBeCloseTo(y - r, 5);
      // And well clear of the middle, which is where the bug put it.
      expect(dist).toBeGreaterThan(r * 0.8);
    });

    it("keeps the square's tip on the bottom-left corner, as a percentage", () => {
      // Percentage, not px: it has to keep following the wrapper while that tweens to the
      // next moment. Baked pixels would snap ahead of it.
      const m = indicatorMetrics(base, { width: 288, height: 162 });
      expect(m.pointerLeft).toBe("0px");
      expect(m.pointerTop).toBe(`calc(100% - ${m.pointerOverlap}px)`);
    });

  it("is round", () => {
      const m = indicatorMetrics(circle, { width: 288, height: 162 });
      expect(m.restWidth).toBe(m.restHeight);
    });
  });
});

describe("enhanceSource", () => {
  const activity = { pos: { x: 480, y: 270 }, dim: { width: 576, height: 324 } };

  it("crops the video to exactly the region the box covers", () => {
    // 576 video px shown at scaleRatio 0.5 is 288 CSS px; the box adds 5% slack, so the
    // crop must come back as 576 * 1.05 video px — the same picture, one step wider.
    const m = indicatorMetrics(base, { width: 288, height: 162 });
    const s = enhanceSource(m, activity, 0.5);
    expect(s.width).toBeCloseTo(576 * 1.05);
    expect(s.height).toBeCloseTo(324 * 1.05);
    // Centred on the activity, so the extra slack is split between the two sides.
    expect(s.x + s.width / 2).toBeCloseTo(activity.pos.x + activity.dim.width / 2);
    expect(s.y + s.height / 2).toBeCloseTo(activity.pos.y + activity.dim.height / 2);
  });

  it("widens the crop to the throb's peak so the ink can spread into it", () => {
    const m = indicatorMetrics({ ...base, animation_style: "pulse" }, { width: 288, height: 162 });
    const s = enhanceSource(m, activity, 0.5);
    expect(s.width).toBeCloseTo(576 * 1.05 * PULSE_PEAK);
  });

  it("crops to the CIRCLE, not to the activity, in fixed-circle mode", () => {
    // The visible mark is a 52.5px circle; the enhanced patch used to be an
    // activity-sized rectangle, so the bolder ink and the thing marking it disagreed.
    const m = indicatorMetrics({ ...base, shape_style: "static-circle" }, { width: 288, height: 162 });
    const s = enhanceSource(m, activity, 0.5);
    expect(s.width).toBeCloseTo((50 * 1.05) / 0.5);
    expect(s.width).toBe(s.height);
  });

  it("returns nothing rather than Infinity before the container is measured", () => {
    // computeLetterbox reports scaleRatio 0 until the box has a size. Dividing by it would
    // paint a garbage crop over the frame; an empty rect paints nothing for one frame.
    const m = indicatorMetrics(base, { width: 0, height: 0 });
    expect(enhanceSource(m, activity, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

// A tripwire, not a unit test.
//
// Everything above tests the pure module, and the pure module cannot be wrong in the way
// this bug was wrong: the defect lived in how the component and the stylesheet USED the
// numbers. `indicatorMetrics` would happily keep returning `borderWidth: 10` while
// HighlightIndicator multiplied it by scaleRatio again on the next line. Rendering the
// component would be the honest way to catch that, but it needs a DOM and it still would
// not see the keyframes — so this reads the two files instead and checks the structural
// rule they both have to keep.
//
// If a legitimate change ever trips one of these, narrow the check; do not delete it
// without reading D26 in docs/decisions.md first.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

// These checks look for what the code DOES, and the comments beside it discuss what it
// deliberately does not do — so a negative assertion has to read the code alone.
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Everything getAnimations({ subtree: true }) can hand back inside the highlight wrapper.
// The transitions are the whole reason this predicate exists: they are RUNNING at exactly the
// moment it is asked, because the highlight just moved, and they have no `animationName` to
// read. The first version of the rewind read straight through it and threw inside an effect,
// taking the player down on every moment handover.
const ANIMATIONS = {
  pulse: { animationName: "pulse" },
  inkSpread: { animationName: "ink-spread" },
  inkSpreadRound: { animationName: "ink-spread-round" },
  fadeIn: { animationName: "fade-in" },
  geometryTransition: { transitionProperty: "width" },
  opacityTransition: { transitionProperty: "opacity" },
  scriptedAnimation: {},
} as unknown as Record<string, Animation>;

describe("isThrobAnimation", () => {
  it("takes the two halves of the throb, in both of the ink's shapes", () => {
    expect(isThrobAnimation(ANIMATIONS.pulse)).toBe(true);
    expect(isThrobAnimation(ANIMATIONS.inkSpread)).toBe(true);
    expect(isThrobAnimation(ANIMATIONS.inkSpreadRound)).toBe(true);
  });

  it("does not throw on a transition, which has no animationName", () => {
    expect(() => isThrobAnimation(ANIMATIONS.geometryTransition)).not.toThrow();
    expect(isThrobAnimation(ANIMATIONS.geometryTransition)).toBe(false);
    expect(isThrobAnimation(ANIMATIONS.opacityTransition)).toBe(false);
    // Nor on a bare Animation from the Web Animations API, which has no name either.
    expect(() => isThrobAnimation(ANIMATIONS.scriptedAnimation)).not.toThrow();
    expect(isThrobAnimation(ANIMATIONS.scriptedAnimation)).toBe(false);
  });

  it("leaves the highlight's fade alone", () => {
    // Rewinding this would re-fade the highlight every time the lecturer moved their pen.
    expect(isThrobAnimation(ANIMATIONS.fadeIn)).toBe(false);
  });

  it("matches exactly, not by prefix", () => {
    // `startsWith("ink-spread")` would adopt anything later named in that family.
    const impostor = { animationName: "ink-spread-preview" } as unknown as Animation;
    expect(isThrobAnimation(impostor)).toBe(false);
  });
});

describe("the invariant, as it is actually wired up", () => {
  it("never multiplies a decoration by scaleRatio in HighlightIndicator", () => {
    const src = read("./HighlightIndicator.tsx");
    // The component is allowed exactly one use of scaleRatio per line, and only on the
    // lines that place the video-space wrapper or convert the activity rectangle.
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes("scaleRatio") && !line.startsWith("//"))
      .filter(({ line }) =>
        /border|boxShadow|inset|pointer|base_size|border_width|pointer_scale/i.test(line)
      );
    expect(offenders, "a decoration length is being scaled by the video again").toEqual([]);
  });

  it("puts no scaling transform between the border and the viewport", () => {
    const src = read("./HighlightIndicator.tsx");
    // `translate` and `rotate` are fine — neither changes how thick a border is painted.
    expect(stripComments(src)).not.toMatch(/scale\(/);
  });

  it("refuses to draw at all before the container has been measured", () => {
    // The decoration no longer collapses on its own when scaleRatio is 0 — a 12px ring is
    // 12px at any scale — so a high-contrast mark would flash at the overlay's origin.
    expect(read("./HighlightIndicator.tsx")).toMatch(/scaleRatio\s*<=\s*0/);
  });

  it("paints the ring instead of laying it out", () => {
    // A `border` passes every arithmetic test above and still reintroduces the layout bug:
    // under box-sizing:border-box a box narrower than two borders is widened to fit them,
    // which walks the mark off the ink. Only the browser can see that, so pin the mechanism.
    const src = read("./HighlightIndicator.tsx");
    expect(src).toMatch(/boxShadow:\s*`inset 0 0 0 \$\{m\.borderWidth\}px/);
    expect(src).not.toMatch(/^\s*border:\s*`/m);
    // And forced-colors mode blanks box-shadow, so the opt-out has to be there with it.
    expect(read("./player.css")).toMatch(/\.highlight-indicator\s*\{[^}]*forced-color-adjust:\s*none/);
  });

  it("still rounds the fixed circle", () => {
    expect(read("./HighlightIndicator.tsx")).toMatch(/static-circle.*borderRadius.*50%/s);
  });

  it("lets no ancestor of the highlight acquire a scale of its own", () => {
    // The pure metrics cannot see this: a `scale:` or `zoom:` added to .video-highlights or
    // .video-container would multiply the ring right back up, silently.
    const rules = read("./player.css")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .filter((r) => /\.video-container|\.video-highlights|\.highlight-/.test(r.split("{")[0] ?? ""));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r, `a highlight ancestor is scaling: ${r.trim().slice(0, 80)}`)
        .not.toMatch(/transform\s*:[^;]*scale|(^|[;{\s])scale\s*:|zoom\s*:/);
    }
  });

  it("rewinds the throb for each new moment instead of remounting it", () => {
    // A finished CSS animation does not restart because the styles around it changed, and
    // back-to-back moments never unmount the wrapper — so `forwards 3` used to mean three
    // throbs per SESSION-RUN, not per moment.
    const src = read("./HighlightIndicator.tsx");
    expect(src).toMatch(/getAnimations\(\{ subtree: true \}\)/);
    // Before paint: a passive effect is only usually flushed in time, and the frame it can
    // leak is the new moment's box drawn at the old moment's throb phase.
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]{0,200}getAnimations/);
    expect(src).toMatch(/currentTime = 0/);
    expect(src).toMatch(/\.play\(\)/);
    // Keyed on the moment, so a new moment throbs again; and on the filters, so switching an
    // enhance filter on brings the freshly mounted ink animation into step with the border.
    // Assert on the DEPENDENCY ARRAY itself, not on the file. Every one of these names also
    // appears elsewhere in the component, so scanning the whole source would keep passing
    // with the name deleted from the array — which is the only place it does anything.
    // Locate the REWIND effect by its body — there is more than one layout effect in here
    // now — and read the dependency array that closes it.
    const at = src.indexOf("isThrobAnimation(a)");
    expect(at, "could not find the rewind effect").toBeGreaterThan(-1);
    const deps = /\}, \[([^\]]*)\]\)/.exec(src.slice(at))?.[1];
    expect(deps, "could not find the rewind effect's dependency array").toBeDefined();
    // The moment changing, and re-entering the same moment inside the 350ms fade window.
    expect(deps).toMatch(/currActivity\?\.id/);
    expect(deps).toMatch(/\bentry\b/);
    // The two edges that mount a fresh animation against a border already mid-cycle.
    expect(deps).toMatch(/\bhasInk\b/);
    expect(deps).toMatch(/shape_style/);
    // Not the speed slider: it fires continuously under a dragging thumb, and both durations
    // change together anyway, so the two animations stay in phase without help.
    expect(deps).not.toMatch(/animation_speed/);
    // The rewind has to cover the ink too, or the clip drifts out of step with the ring.
    expect(src).toMatch(/isThrobAnimation\(a\)/);
    // Remounting would restart them too, and would rebuild EnhanceCanvas's WebGL context
    // every moment on the hardware least able to afford it. (Comments stripped: the code
    // says so in prose right where it rejects the alternative.)
    expect(stripComments(src)).not.toMatch(/key=\{currActivity/);
  });

  it("clips the fixed circle's ink to a circle", () => {
    // The mark is round; a rectangular clip left the four corners enhanced with nothing
    // pointing at them.
    const css = read("./player.css");
    expect(css).toMatch(/\.highlight-enhance\.round\s*\{[^}]*clip-path:\s*circle\(50%\)/);
    // The keyframes have to stay ROUND — a plain inset() here is the original square patch
    // back again under a different name.
    const kf = css.slice(css.indexOf("@keyframes ink-spread-round"));
    const body = kf.slice(0, kf.indexOf("\n}") + 2);
    expect(body).toMatch(/inset\(10% round 50%\)/);
    expect(body).toMatch(/inset\(0% round 50%\)/);
    // `.highlight-enhance.round.spreading` (0,3,0) beats `.highlight-enhance.spreading`
    // (0,2,0) on specificity, so this holds wherever the two rules sit in the file.
    const round = css.indexOf(".highlight-enhance.round.spreading");
    expect(round).toBeGreaterThan(-1);
    expect(css.slice(round, round + 200)).toMatch(/animation:\s*ink-spread-round/);
    // And the component only asks for it in that shape.
    expect(read("./HighlightIndicator.tsx")).toMatch(/static-circle" \? "round"/);
  });

  it("starts the ink-mode journey before the frame is painted", () => {
    // With an enhance filter on, the highlight is moved by tweening the activity rectangle
    // rather than by CSS. If that journey is started in a passive effect, the render in which
    // the moment changed has no journey yet and falls through to the DESTINATION — measured
    // off painted frames: the mark appeared at the far end for two frames, jumped back, then
    // travelled. Seeding progress 0 in a layout effect is what stops that being a frame.
    const src = read("./HighlightIndicator.tsx");
    const tween = src.slice(src.indexOf("const inTransitRef"));
    const body = tween.slice(0, tween.indexOf("}, [currActivity?.id, hasInk]);"));
    expect(body).toMatch(/useLayoutEffect/);
    expect(body).toMatch(/setInTransit\(tweenActivity\(from, currActivity, 0\)\)/);
    // And it resumes from where the mark IS, not from the moment it was heading for.
    expect(body).toMatch(/inTransitRef\.current \?\? lastTargetRef\.current/);
  });

  it("asks CSS for no geometry when it is doing the moving itself", () => {
    // Both would fight over left/top/width/height, and the CSS half knows nothing about the
    // crop the canvas is cutting.
    const src = read("./HighlightIndicator.tsx");
    const at = src.indexOf("transition:");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 500);
    expect(block).toMatch(/hasInk/);
    // The ink branch of the ternary: everything between `?` and the `:` that opens the other.
    const inkBranch = block.slice(block.indexOf("?") + 1, block.indexOf("\n", block.indexOf("?")));
    expect(inkBranch).toMatch(/opacity/);
    expect(inkBranch).not.toMatch(/left|top|width|height/);
  });

  it("grows the box, not a transform, when it pulses", () => {
    const css = read("./player.css");
    const pulse = css.slice(css.indexOf("@keyframes pulse"));
    const body = pulse.slice(0, pulse.indexOf("\n}") + 2);
    expect(body).not.toMatch(/transform/);
    expect(body).toMatch(/--box-w-peak/);
    expect(body).toMatch(/--box-h-peak/);
  });
});
