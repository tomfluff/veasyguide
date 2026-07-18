// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The keys the player's own chrome consumes when one of its controls has focus: Space/Enter
// activate a focused button, arrows drive the volume slider and the menus. Mantine's useHotkeys
// is a DOCUMENT-level listener, so it fires for these too — a focused control would double-act
// (Space both clicks the button AND toggles play) unless the control stops the event here.
//
// Everything NOT in this set (F, M, Z, P, [, ], <, >) is deliberately left to bubble, so those
// shortcuts keep working wherever focus happens to sit — the way YouTube's do. The guard is
// scoped to the keys the focused element actually uses, never a blanket stopPropagation on all
// keys, which is what silently killed every shortcut while focus was in the moments sidebar.
//
// One copy so the player controls, the moments sidebar and the title-bar buttons cannot drift
// apart about which keys belong to the focused element.
const CONTROL_KEYS = new Set([
  " ",
  "Spacebar",
  "Enter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function stopPlayerHotkeys(e: React.KeyboardEvent) {
  if (CONTROL_KEYS.has(e.key)) e.stopPropagation();
}
