// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The four appearance presets, plus the derived "Custom".
//
// A preset is a COMPLETE snapshot of both stores (all fields but zoom_motion — see the
// Preset type), including the defaults it does not change. That is deliberate. If a preset
// named only the 8 fields it cares about,
// then recognising the active one (by comparing the store to each preset) would never match,
// because the store carries 17. Every user, always, would see Custom selected and no preset
// highlighted, and the feature would look broken on first open.
//
// Applying is a plain setState of both stores; recognising is a plain deep-equal. Picking a
// preset resets everything, which is what "pick a preset" should mean.
//
// NOTE: the two `filter_style` arrays stay separate — the highlight and the magnifier each
// have their own. Enhancement that helps under 1.7x magnification can look noisy at 1x.

import { setHighlightSettings, type THighlightSettings } from "../stores/HighlightSettingsStore";
import {
  setMagnificationSettings,
  type TMagnificationSettings,
} from "../stores/MagnificationSettingsStore";

export type Preset = {
  name: string;
  hint: string;
  highlight: THighlightSettings;
  // zoom_motion is the one field outside preset scope: its default comes from the OS
  // reduce-motion preference, and a preset describes a LOOK — applying one must not undo
  // a vestibular-safety choice. equal() iterates the preset's keys, so recognition
  // ignores it too and a snappy viewer still matches the preset they picked.
  magnification: Omit<TMagnificationSettings, "zoom_motion">;
};

// Shared across every preset. No preset turns on motion, and no preset turns on an enhance
// filter: motion helps some low-vision viewers localise and actively harms people with
// vestibular disorders or photosensitivity, and the two "bolder ink" filters depend on
// whether the SLIDE is light or dark — which the user should not have to reason about. The
// default neither moves nor mangles pixels. Both remain available under Customize.
const STILL = (): Pick<
  THighlightSettings,
  "base_size" | "base_scale" | "shape_style" | "animation_style" | "animation_speed" | "filter_style"
> => ({
  base_size: 50,
  base_scale: 1,
  shape_style: "dynamic-square",
  animation_style: "none",
  animation_speed: 1,
  filter_style: [],
});

const ZOOM = (): Pick<
  TMagnificationSettings,
  "zoom_speed" | "pause_on_zoom" | "filter_style"
> => ({ zoom_speed: 1, pause_on_zoom: false, filter_style: [] });

export const PRESETS: Preset[] = [
  {
    name: "Standard",
    hint: "A soft amber box with a red outline",
    highlight: {
      ...STILL(),
      border_width: 4,
      border_color: "#ff0000",
      fill_color: "#ffcc00",
      fill_opacity: 0.15,
      pointer_style: "hand",
      pointer_scale: 1,
    },
    magnification: { ...ZOOM(), zoom_strength: 0.5, contrast: 1 },
  },
  {
    name: "Bold",
    hint: "Thicker outline, stronger fill, bigger pointer",
    highlight: {
      ...STILL(),
      border_width: 10,
      border_color: "#ff0000",
      fill_color: "#ffcc00",
      fill_opacity: 0.3,
      pointer_style: "hand",
      pointer_scale: 1.5,
    },
    magnification: { ...ZOOM(), zoom_strength: 0.7, contrast: 1 },
  },
  {
    name: "High contrast",
    hint: "Black on yellow, and a harder-contrast zoom",
    highlight: {
      ...STILL(),
      border_width: 10,
      border_color: "#000000",
      fill_color: "#ffff00",
      fill_opacity: 0.45,
      pointer_style: "hand",
      pointer_scale: 1.5,
    },
    magnification: { ...ZOOM(), zoom_strength: 0.7, contrast: 1.5 },
  },
  {
    name: "Minimal",
    hint: "A thin outline and nothing else",
    highlight: {
      ...STILL(),
      border_width: 2,
      border_color: "#ff0000",
      fill_color: "#ffcc00",
      fill_opacity: 0,
      pointer_style: "none",
      pointer_scale: 1,
    },
    magnification: { ...ZOOM(), zoom_strength: 0.4, contrast: 1 },
  },
];

const sameFilters = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function equal<T extends Record<string, unknown>>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((k) => {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x) && Array.isArray(y)) return sameFilters(x, y);
    return x === y;
  });
}

// Which preset the current settings ARE — or null, meaning Custom. Custom is a real, visible
// state, not an absence: settings persist to localStorage, so a returning user who once
// nudged one slider would otherwise see four cards, none selected, and no explanation.
export function matchPreset(
  highlight: THighlightSettings,
  magnification: TMagnificationSettings
): Preset | null {
  return (
    PRESETS.find(
      (p) => equal(p.highlight, highlight) && equal(p.magnification, magnification)
    ) ?? null
  );
}

export function applyPreset(preset: Preset): void {
  setHighlightSettings(preset.highlight);
  setMagnificationSettings(preset.magnification);
}
