# veasyguide-app

A fully client-side web app that makes slide-based lecture videos more accessible:
drop a video, and it detects instructor activity (pointing, writing, sketching regions)
**in your browser** — no upload, no account, no server ever touches the video — then plays
it back with a highlight overlay and content-following magnification.

Successor to the [VeasyGuide](../VeasyGuide) research study rig: same detection idea and
accessibility player, rebuilt as a standalone tool. The full design lives in
[`docs/design.md`](docs/design.md); the UI direction in [`docs/wireframe-v1.png`](docs/wireframe-v1.png).

## Status: Phase 0 (throughput spike) — PASS on dev hardware

The spike proves the risky part of the design: that the whole pipeline runs fast enough
in a browser to start playback almost immediately while analysis races ahead.

- **Decode:** WebCodecs (hardware) via [Mediabunny](https://github.com/Vanilagy/mediabunny), sequential sampled-frame decode in a Web Worker.
- **Pipeline (pure TypeScript, no OpenCV.js):** grayscale → frame absdiff → threshold → dilate → connected-component boxes, at ~480p analysis resolution. `src/analyzer/pipeline.ts`.
- **Streaming clusterer with watermark finalization:** activities finalize and stream to the UI as the analysis frontier advances, so playback starts on a short lead instead of waiting for the whole video. `src/analyzer/graph.ts`.
- **Measured:** ~20× realtime on a dev laptop (1280×720 → 480×270). The gating benchmark on **low-end hardware** (Chromebook-class) is still to be run — see `docs/design.md` §Phase 0 decision bands (≥4× pass / 2–<4× mitigate / <2× analyze-first).

What the spike does NOT yet do (later phases in `docs/design.md`): golden-file validation
against the Python outputs, scene detection, seek-into-unanalyzed segments, IndexedDB cache,
the settings suites, and the polished player. This is a measurement harness wearing the demo's clothes.

## Develop

Requires Node 22+ and a Chromium browser (WebCodecs).

```bash
npm install
npm run dev        # http://localhost:5173
```

Drop a lecture video onto the page. A `?test=<name>` query param dev-loads a clip from
`public/_test/` for headless smoke tests (DEV only, never shipped).

Run the pipeline/clusterer self-check (no browser needed):

```bash
node --experimental-strip-types src/analyzer/selfcheck.ts
```

## Build

```bash
npm run build      # tsc + vite build → dist/ (static site)
npm run preview
```

Deploy target is static hosting on Google Cloud (Firebase Hosting) — wired up in a later phase.
