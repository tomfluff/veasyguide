// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// How the moments list is arranged.
//
// Deliberately NOT part of HighlightSettingsStore. That store is the look of the highlight on
// the video — the thing the Appearance sheet's presets set and its Reset button clears. How the
// sidebar arranges its rows is not an appearance preset, and resetting the highlight should not
// silently re-arrange the list.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Where the pinned snapshot docks and how big it gets. Persisted because a reader who
// needs it large needs it large on every video — making them re-enlarge it each time is
// the tax this app exists to remove. Corners use the same vocabulary momentPlace speaks
// ("top right"), so the panel's position and the moments' descriptions agree on words.
export type PinSize = "s" | "m" | "l";
export type PinCorner = "tl" | "tr" | "bl" | "br";

export type TViewSettings = {
  groupByScene: boolean;
  playbackRate: number;
  pinSize: PinSize;
  pinCorner: PinCorner;
  // Whether the "Possible scene change" pill appears when playback crosses a cut.
  //
  // Here rather than in HighlightSettingsStore on purpose: that store is what the Appearance
  // sheet's presets overwrite wholesale, so a viewer who switched this off would have it
  // switched back on the next time they tried a preset — by a control that says nothing about
  // notices. This is a view preference, like groupByScene, and presets do not touch it.
  //
  // Defaults to on. It is a cue some viewers rely on to know the slide changed under them,
  // and a feature that never appears is a feature nobody discovers well enough to want off.
  sceneNotice: boolean;
};

export const useViewSettingsStore = create<TViewSettings>()(
  persist(
    // Annotated, not inferred: `groupByScene: true` infers the literal type `true`, not
    // `boolean`, so the initializer silently failed to match TViewSettings and the whole
    // persist call went unchecked against the type it claims to build.
    (): TViewSettings => ({
      groupByScene: true,
      playbackRate: 1,
      pinSize: "m",
      pinCorner: "tr",
      sceneNotice: true,
    }),
    {
      name: "view-settings",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

export const setGroupByScene = (groupByScene: boolean) =>
  useViewSettingsStore.setState({ groupByScene });

export const setPlaybackRate = (playbackRate: number) =>
  useViewSettingsStore.setState({ playbackRate });

export const setSceneNotice = (sceneNotice: boolean) =>
  useViewSettingsStore.setState({ sceneNotice });

// Both controls are cycles, not pickers: one button each, no menu to open over the very
// video the panel is already covering.
export const PIN_SIZES: PinSize[] = ["s", "m", "l"];
export const PIN_CORNERS: PinCorner[] = ["tr", "br", "bl", "tl"];

export const PIN_SIZE_NAMES: Record<PinSize, string> = { s: "small", m: "medium", l: "large" };
export const PIN_CORNER_NAMES: Record<PinCorner, string> = {
  tl: "top left", tr: "top right", bl: "bottom left", br: "bottom right",
};

const next = <T,>(list: T[], curr: T): T => list[(list.indexOf(curr) + 1) % list.length];

export const nextPinSize = (curr: PinSize) => next(PIN_SIZES, curr);
export const nextPinCorner = (curr: PinCorner) => next(PIN_CORNERS, curr);

export const setPinSize = (pinSize: PinSize) => useViewSettingsStore.setState({ pinSize });
export const setPinCorner = (pinCorner: PinCorner) => useViewSettingsStore.setState({ pinCorner });
