// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext } from "react";

// The element the player's tooltips portal INTO: the player container itself. Not body, which
// is the Tooltip's default — in fullscreen only the fullscreened element and its descendants
// are drawn, so a tip portalled to body exists in the DOM and is never seen. And not inline
// beside its button either: the pin panel is `overflow: hidden`, so a tip rendered inside it
// is clipped to the panel's own rectangle.
//
// Its own file because a module that exports a component and a context trips Fast Refresh.
export const PlayerTipRoot = createContext<HTMLElement | null>(null);
