// The moments, as a table of contents. The timeline lane is a map (proportional, marks
// merge when they collide); this list is the index — every moment gets the same full-width
// row with a thumbnail of the annotated region, so you choose by sight, not by timestamp.
//
// Two arrangements. Flat is the whole lecture as one scroll, which is fine for a short clip and
// unusable for an hour: 100+ rows with nothing to grab. Grouped folds them under the scene they
// happened in, so the list collapses to a handful of slides you can open. The analyzer has been
// emitting scenes all along; this is the first thing that reads them.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Activity, Scene } from "./analyzer/types";
import { convertSecondsToTimecode } from "./utils/misc";
import { seekTargetFor, groupByScenes } from "./player/moments";
import { useViewSettingsStore, setGroupByScene } from "./stores/ViewSettingsStore";

type Props = {
  activities: Activity[];
  scenes: Scene[];
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

export default function MomentsSidebar({ activities, scenes, thumbs, current, done, canPlay, lead, onJump, className, style }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const groupByScene = useViewSettingsStore((s) => s.groupByScene);
  const currIndex = current ? activities.indexOf(current) : -1;

  // One scene is not a grouping — it is the whole lecture with a header on top. A lecture shot
  // in one continuous take (no slides, no cuts) produces exactly that, so both the switch and
  // the grouping stay out of the way until there is something to group BY.
  const groups = scenes.length > 1 ? groupByScenes(activities, scenes) : [];
  const grouped = groupByScene && groups.length > 0;

  // Playback reaching a moment inside a folded scene must unfold it — otherwise the list claims
  // nothing is playing, and the follow-scroll below has no row to scroll to.
  const currentSceneId = grouped && current
    ? groups.find((g) => g.activities.includes(current))?.scene.id
    : undefined;
  useEffect(() => {
    if (currentSceneId === undefined) return;
    setCollapsed((prev) => {
      if (!prev.has(currentSceneId)) return prev;
      const next = new Set(prev);
      next.delete(currentSceneId);
      return next;
    });
  }, [currentSceneId]);

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
    // Honour prefers-reduced-motion: jump rather than smooth-scroll for vestibular safety.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({
      top: row.offsetTop - list.offsetTop - (list.clientHeight - row.offsetHeight) / 2,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [currIndex, collapsed]);

  const row = (a: Activity, i: number) => {
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
  };

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
        {groups.length > 0 && (
          <div className="side-view" role="group" aria-label="Arrange moments">
            <button
              type="button"
              className={groupByScene ? "" : "on"}
              aria-pressed={!groupByScene}
              onClick={() => setGroupByScene(false)}
            >
              List
            </button>
            <button
              type="button"
              className={groupByScene ? "on" : ""}
              aria-pressed={groupByScene}
              onClick={() => setGroupByScene(true)}
            >
              By scene
            </button>
          </div>
        )}
      </div>
      <div className="side-list" ref={listRef}>
        {grouped
          ? groups.map((g, gi) => (
              // <details> rather than a hand-rolled disclosure: the open/closed state, the
              // Enter/Space handling and the screen-reader announcement all come with it.
              <details
                key={g.scene.id}
                className="side-scene"
                open={!collapsed.has(g.scene.id)}
                onToggle={(e) => {
                  const open = e.currentTarget.open;
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (open) next.delete(g.scene.id);
                    else next.add(g.scene.id);
                    return next;
                  });
                }}
              >
                <summary>
                  <span className="side-scene-n">Scene {gi + 1}</span>
                  <span className="side-scene-t">{convertSecondsToTimecode(g.scene.start)}</span>
                  <span className="side-scene-c">
                    {g.activities.length} moment{g.activities.length === 1 ? "" : "s"}
                  </span>
                </summary>
                {g.activities.map((a) => row(a, activities.indexOf(a)))}
              </details>
            ))
          : activities.map(row)}
      </div>
    </aside>
  );
}
