// How the moments list is arranged.
//
// Deliberately NOT part of HighlightSettingsStore. That store is the look of the highlight on
// the video — the thing the Appearance sheet's presets set and its Reset button clears. How the
// sidebar arranges its rows is not an appearance preset, and resetting the highlight should not
// silently re-arrange the list.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// What the player does when a moment's end is reached during playback (the tempo engine):
// continue = a normal player; pause = wait for the viewer (the low-vision "don't outrun me"
// and the blind "play me what she said, then stop"); skip = jump the gap to the next
// moment's cue (the crammer's skim — 67% of a measured lecture is moment-free dead air).
export type MomentEndBehavior = "continue" | "pause" | "skip";

export type TViewSettings = {
  groupByScene: boolean;
  playbackRate: number;
  atMomentEnd: MomentEndBehavior;
};

export const useViewSettingsStore = create<TViewSettings>()(
  persist(() => ({ groupByScene: true, playbackRate: 1, atMomentEnd: "continue" as MomentEndBehavior }), {
    name: "view-settings",
    storage: createJSONStorage(() => localStorage),
  })
);

export const setGroupByScene = (groupByScene: boolean) =>
  useViewSettingsStore.setState({ groupByScene });

export const setPlaybackRate = (playbackRate: number) =>
  useViewSettingsStore.setState({ playbackRate });

export const setAtMomentEnd = (atMomentEnd: MomentEndBehavior) =>
  useViewSettingsStore.setState({ atMomentEnd });
