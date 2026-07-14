// The moments, as a table of contents. The timeline lane is a map (proportional, marks
// merge when they collide); this list is the index — every moment gets the same full-width
// row with a thumbnail of the annotated region, so you choose by sight, not by timestamp.
import { useEffect, useRef, type CSSProperties } from "react";
import type { Activity } from "./analyzer/types";
import { convertSecondsToTimecode } from "./utils/misc";
import { seekTargetFor } from "./player/moments";

type Props = {
  activities: Activity[];
  // activity id → object URL of its thumbnail crop. Filled after analysis completes;
  // rows show a placeholder until then.
  thumbs: ReadonlyMap<number, string>;
  current: Activity | null;
  done: boolean;
  canPlay: boolean;
  lead: number;
  onJump: (t: number) => void;
  // The same list mounts twice: on the page (windowed) and as an overlay inside the player
  // (fullscreen, where the page is invisible). These let the overlay mount position itself.
  className?: string;
  style?: CSSProperties;
};

export default function MomentsSidebar({ activities, thumbs, current, done, canPlay, lead, onJump, className, style }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const currIndex = current ? activities.indexOf(current) : -1;

  // Follow playback: keep the current row centred, so the rows around it — where you are
  // coming from and what is next — stay visible too. ("nearest" parks the row on the list's
  // edge instead, and you can never see ahead.) Scrolls the LIST, not scrollIntoView, which
  // also scrolls every ancestor — on the page mount that would drag the page around during
  // playback. A pointer over the list means the viewer is browsing it; following would yank
  // the rows out from under them.
  useEffect(() => {
    const list = listRef.current;
    if (currIndex < 0 || !list || list.matches(":hover")) return;
    const row = list.querySelector<HTMLElement>('[aria-current="true"]');
    if (!row) return;
    list.scrollTo({
      top: row.offsetTop - list.offsetTop - (list.clientHeight - row.offsetHeight) / 2,
      behavior: "smooth",
    });
  }, [currIndex]);

  return (
    // Keys pressed while focus is in the sidebar belong to the sidebar. Without this,
    // Space on a row also reaches the player's document-level hotkeys and toggles play
    // on top of the row's own seek.
    <aside
      className={className ? `moments-side ${className}` : "moments-side"}
      style={style}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="side-head">
        <div className="side-title">Moments</div>
        <div className="side-pos" role="status">
          {activities.length === 0
            ? done ? "None found" : "Looking…"
            : currIndex >= 0
              ? <>Now at <b>{currIndex + 1}</b> of <b>{activities.length}</b>{done ? "" : "+"}</>
              : <><b>{activities.length}</b>{done ? "" : "+"} in this lecture</>}
        </div>
      </div>
      <div className="side-list" ref={listRef}>
        {activities.map((a, i) => {
          const now = i === currIndex;
          const url = thumbs.get(a.id);
          return (
            <button
              key={a.id}
              type="button"
              className={now ? "side-row now" : "side-row"}
              aria-current={now ? "true" : undefined}
              disabled={!canPlay}
              onClick={() => onJump(seekTargetFor(a, lead))}
              aria-label={`Moment ${i + 1}, ${convertSecondsToTimecode(a.start)}, ${(a.end - a.start).toFixed(1)} seconds`}
            >
              {url ? (
                <img className="side-thumb" src={url} alt="" />
              ) : (
                <span className="side-thumb ph" aria-hidden="true">{i + 1}</span>
              )}
              <span className="side-meta">
                {now && <span className="side-now">Now</span>}
                <span className="side-t">{convertSecondsToTimecode(a.start)}</span>
                <span className="side-d">{(a.end - a.start).toFixed(1)}s</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
