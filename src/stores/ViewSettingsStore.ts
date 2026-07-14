// How the moments list is arranged.
//
// Deliberately NOT part of HighlightSettingsStore. That store is the look of the highlight on
// the video — the thing the Appearance sheet's presets set and its Reset button clears. How the
// sidebar arranges its rows is not an appearance preset, and resetting the highlight should not
// silently re-arrange the list.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type TViewSettings = {
  groupByScene: boolean;
};

export const useViewSettingsStore = create<TViewSettings>()(
  persist(() => ({ groupByScene: true }), {
    name: "view-settings",
    storage: createJSONStorage(() => localStorage),
  })
);

export const setGroupByScene = (groupByScene: boolean) =>
  useViewSettingsStore.setState({ groupByScene });
