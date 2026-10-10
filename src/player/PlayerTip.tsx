// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The name of an icon-only player control, shown on hover and on keyboard focus, with its key.
// docs/decisions.md D31.
//
// It replaces the native `title` these buttons had (or did not have at all). A title is the
// browser's own tooltip: small system text that ignores the page's zoom and font size, arrives
// after a long and unconfigurable delay, never appears on keyboard focus, and — reported on
// Windows — does not appear at all over a fullscreened element. For a reader at 200% zoom
// trying to work out what an unlabelled glyph does, that is no label.
//
// Hover and focus, not touch: a touch press IS the click, so a tip on touch would pop over the
// very thing the press just opened. Focus is focus-VISIBLE only (Mantine passes visibleOnly
// through to floating-ui), so a mouse click that focuses the button does not leave a tip
// hanging over the popover it opened — Tab does show it, which is the case it is for.
//
// The key is shown only while single-key shortcuts are on. Advertising a key the viewer has
// switched off is advertising a key that does nothing.
import { cloneElement, useContext, type ReactElement } from "react";
import { Tooltip } from "@mantine/core";
import { useViewSettingsStore } from "../stores/ViewSettingsStore";
import { PlayerTipRoot } from "./tipRoot";

type Props = {
  label: string;
  // The key that operates this control, as printed on the keycap; none for a control without
  // one (collapse/expand).
  hotkey?: string;
  // Show the key even with single-key shortcuts off. For Space: it is not a character key, so
  // the switch never turns it off (WCAG 2.1.4), and hiding it would hide a key that works.
  alwaysKey?: boolean;
  // While the control's own popover or overlay is open: a tip floating over the thing it
  // describes is in the way of the thing it describes.
  disabled?: boolean;
  // The Tooltip must wrap OUTSIDE a Popover.Target, never inside it. Popover.Target forwards
  // its props (ref, aria-expanded, handlers) to its child, and Tooltip spreads any prop it does
  // not know onto its FLOATING box — so with the Tooltip inside, the popover's anchor ref and
  // ARIA land on the tip instead of the button. Outside, the Tooltip clones Popover.Target,
  // which passes everything through to the button as it should. (D31)
  children: ReactElement;
};

export default function PlayerTip({ label, hotkey, alwaysKey, disabled, children }: Props) {
  const root = useContext(PlayerTipRoot);
  const letters = useViewSettingsStore((s) => s.letterShortcuts);
  return (
    <Tooltip
      label={
        <>
          {label}
          {hotkey && (letters || alwaysKey) && <kbd>{hotkey}</kbd>}
        </>
      }
      events={{ hover: true, focus: true, touch: false }}
      openDelay={200}
      // WCAG 1.4.13: content shown on hover must itself be hoverable — someone at high zoom
      // moves the pointer onto the tip to read it, or a screen magnifier follows the pointer
      // there. The tip takes pointer events (player.css), and this delay carries the pointer
      // across the 5px gap: floating-ui cancels the pending close the moment the pointer
      // enters the tip, and closes it when the pointer leaves the tip instead. (D31)
      closeDelay={300}
      portalProps={root ? { target: root } : undefined}
      disabled={disabled}
      classNames={{ tooltip: "player-tip" }}
    >
      {/* No aria-describedby. floating-ui's tooltip role points the button at the tip, so a
          screen reader would hear the name twice — once as the aria-label, again as the
          description. The key is announced from `aria-keyshortcuts` on the button instead.
          The explicit `undefined` matters: the child's own props are merged LAST, so a key
          that is present with no value is what overrides the one the tooltip adds. */}
      {cloneElement(children, { "aria-describedby": undefined } as Record<string, unknown>)}
    </Tooltip>
  );
}
