// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useViewSettingsStore, setSceneNotice, setGroupByScene } from "./ViewSettingsStore";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the scene-change notice setting", () => {
  beforeEach(() => setSceneNotice(true));

  it("is on for anyone who has never touched it", () => {
    // It is a cue some viewers rely on to know the slide changed under them, and a feature
    // that never appears is one nobody discovers well enough to want off.
    expect(useViewSettingsStore.getState().sceneNotice).toBe(true);
  });

  it("turns off and back on again", () => {
    setSceneNotice(false);
    expect(useViewSettingsStore.getState().sceneNotice).toBe(false);
    setSceneNotice(true);
    expect(useViewSettingsStore.getState().sceneNotice).toBe(true);
  });

  it("does not disturb the other view settings", () => {
    setGroupByScene(false);
    setSceneNotice(false);
    expect(useViewSettingsStore.getState().groupByScene).toBe(false);
    expect(useViewSettingsStore.getState().pinCorner).toBe("tr");
    setGroupByScene(true);
  });

  it("lives outside the store the Appearance presets overwrite", () => {
    // A preset is a COMPLETE snapshot of the highlight and magnification stores (presets.ts),
    // so a notice preference kept there would be switched back on by a control that says
    // nothing about notices.
    const highlight = read("./HighlightSettingsStore.ts");
    expect(highlight).not.toMatch(/sceneNotice/);
    const presets = read("../player/presets.ts");
    expect(presets).not.toMatch(/sceneNotice/);
  });

  it("is a switch in the sidebar's footer, not a pair of buttons in its header", () => {
    // on/off is what this is. A segmented pair renders both states as buttons, so a viewer
    // has to read two words to work out which one is current; a switch says it by position.
    const side = read("../MomentsSidebar.tsx");
    expect(side).toMatch(/<Switch/);
    expect(side).toMatch(/label="Notify scene changes"/);
    // In the footer, under the list — it is a standing preference about the video, not a
    // control over the rows above it.
    expect(side.indexOf("side-foot")).toBeGreaterThan(side.indexOf("side-list"));
    // And no description line: it pushed the footer past the 40vh cap on a short window,
    // where the panel's overflow:hidden cut the switch off entirely.
    const foot = side.slice(side.indexOf("side-foot"));
    expect(foot.slice(0, foot.indexOf("</Switch>") + 400)).not.toMatch(/description=/);
  });

  it("keeps the panel's height cap above what its own chrome needs", () => {
    // 40vh is a share of the WINDOW; on a short one it fell below the heading plus the
    // footer, and the panel clipped its own controls.
    expect(read("../App.css")).toMatch(/max-height:\s*max\(40vh,\s*15rem\)/);
  });

  it("gates the pill at the trigger AND at the render", () => {
    // Only gating the trigger would leave an already-showing notice on screen for the rest
    // of its 2.5 seconds after the viewer asked for quiet.
    const player = read("../player/VideoPlayer.tsx");
    expect(player).toMatch(/getState\(\)\.sceneNotice/);
    expect(player).toMatch(/sceneNoticeVisible && sceneNotice/);
  });
});
