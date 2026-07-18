// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { PRESETS, matchPreset } from "./presets";
import type { THighlightSettings } from "../stores/HighlightSettingsStore";
import type { TMagnificationSettings } from "../stores/MagnificationSettingsStore";

const standard = PRESETS[0];

// What the store actually holds: a preset's magnification plus the store-only zoom_motion
// field, which lives outside preset scope (see the Preset type).
const inStore = (
  m: (typeof standard)["magnification"],
  zoom_motion: TMagnificationSettings["zoom_motion"] = "smooth"
): TMagnificationSettings => ({ ...m, zoom_motion });

describe("presets", () => {
  it("recognises each preset exactly", () => {
    // The bug this guards: if a preset were a PARTIAL set of fields, deep-equalling it against
    // the full store would never match, so no card would ever show as selected and the whole
    // feature would look broken on first open.
    for (const p of PRESETS) {
      expect(matchPreset(p.highlight, inStore(p.magnification))?.name).toBe(p.name);
    }
  });

  it("ignores zoom_motion when recognising a preset", () => {
    // zoom_motion is a vestibular-safety preference, not part of any look: a viewer who
    // chose snappy must still see their preset selected, not Custom.
    expect(matchPreset(standard.highlight, inStore(standard.magnification, "snappy"))?.name)
      .toBe(standard.name);
  });

  it("falls back to Custom when a single field differs", () => {
    const nudged: THighlightSettings = { ...standard.highlight, border_width: 5 };
    expect(matchPreset(nudged, inStore(standard.magnification))).toBeNull();
  });

  it("falls back to Custom when only the MAGNIFICATION store differs", () => {
    // A preset spans both stores. Comparing only the highlight store would call this
    // "Standard" while the zoom is set to something else entirely.
    const nudged: TMagnificationSettings = { ...inStore(standard.magnification), zoom_strength: 0.95 };
    expect(matchPreset(standard.highlight, nudged)).toBeNull();
  });

  it("compares filter arrays order-insensitively", () => {
    const a: THighlightSettings = {
      ...standard.highlight,
      filter_style: ["sharpen", "invert"],
    };
    const b: THighlightSettings = {
      ...standard.highlight,
      filter_style: ["invert", "sharpen"],
    };
    // Same set, different order: these must not read as two different configurations.
    expect(matchPreset(a, inStore(standard.magnification))).toBe(matchPreset(b, inStore(standard.magnification)));
  });

  it("ships no motion and no enhance filters in any preset", () => {
    // Motion helps some low-vision viewers localise and actively harms people with vestibular
    // disorders or photosensitivity. The "bolder ink" filters depend on whether the SLIDE is
    // light or dark, which a user cannot reasonably be asked to know. The default neither
    // moves nor mangles pixels; both stay available under Customize.
    for (const p of PRESETS) {
      expect(p.highlight.animation_style).toBe("none");
      expect(p.highlight.filter_style).toEqual([]);
      expect(p.magnification.filter_style).toEqual([]);
    }
  });

  it("is a complete snapshot — every store field is named", () => {
    // If a preset ever grows a hole, matchPreset silently stops matching. Fail here instead.
    const HIGHLIGHT_FIELDS = [
      "fill_color", "fill_opacity", "base_size", "base_scale", "filter_style",
      "shape_style", "border_width", "border_color", "pointer_style", "pointer_scale",
      "animation_style", "animation_speed",
    ];
    const MAG_FIELDS = ["zoom_strength", "zoom_speed", "pause_on_zoom", "contrast", "filter_style"];
    for (const p of PRESETS) {
      expect(Object.keys(p.highlight).sort()).toEqual([...HIGHLIGHT_FIELDS].sort());
      expect(Object.keys(p.magnification).sort()).toEqual([...MAG_FIELDS].sort());
    }
  });
});
