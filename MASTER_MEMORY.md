# Master Memory

## Project Purpose
Build an education startup pipeline that turns Notion textbook chapters into AI-generated video lesson assets. The current production model uses browser automation and web subscriptions to reduce API cost. Image generation works; video animation is the active stabilization target.

## Current Operating Reality
- Primary image flow is browser-driven: Notion -> ChatGPT -> Gemini -> Notion.
- Primary video direction is Flow-first: Google Flow / Veo via `labs.google/fx/tools/flow`, using Ultra/Pro Business Flow credits.
- Gemini app video is fallback/smoke-test only because Gemini/Omni-style usage limits are a poor fit for batch production.
- Repo is mixed Node + Python, with Node orchestration/workers and Python browser drivers/pipeline utilities.
- The system is designed to run unattended and rotate accounts on rate limits.
- Live dashboard exists on port 7777 for status and logs.
- Image generation is functional enough to use in production.
- Video generation/animation exists in code, but the current production reality is that it fails or is unreliable enough to be treated as blocked until rebuilt around Flow state and blockers.

## Architecture Map
- `src/node/orchestrators/`: entry points for autonomous, batch, and pipeline runs.
- `src/node/workers/`: browser-side workers for submitting and saving images/videos.
- `src/node/dashboard/`: local status dashboard.
- `src/python/drivers/browser/`: ChatGPT and Gemini CDP/browser control.
- `src/python/drivers/notion/`: Notion read/write/upload helpers.
- `src/python/pipeline/`: fetch, refine, prompt, and image generation stages.
- `src/python/infra/`: Chrome/Gemini keepalive helpers.
- `deploy/`: multi-host deployment support.

## Known Production Blockers
- Flow-first video animation pipeline is not dependable in production yet. Treat this as the current top engineering priority.
- `docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md` is the implementation-ready plan.
- v4 evidence: image stage completed `80/80`, then Flow Stage 5 failed. The real Flow script crashed on `ReferenceError: TARGET_IN_FLIGHT is not defined`, then later hit failed tiles/rate-limit behavior and watchdog kill with `0/80` videos saved.
- The deprecated zip does not include the actual `animate_flow.cjs` used in the v4 Flow run, so do not depend on resurrecting that missing script.
- Phase 0 fixed the first silent-failure layer: `src/node/workers/submit_videos.cjs` now exits non-zero on submission errors, and `src/node/workers/save_videos.cjs` now exits code `6` on non-watch idle timeout.
- `src/node/workers/save_videos.cjs` still does not classify Gemini quota, safety, subscription, UI, or render-failed states beyond idle timeout.
- Video does not yet have the same autonomous orchestration, rescue, blocker classification, credit/account handling, and disk-first resume model as the image path.
- Gemini UI selectors and state handling are brittle and need continual verification.
- Account rotation is necessary when rate limits hit.
- Notion uploads can fail on API timing or permissions if the workspace connection is incomplete.
- Browser automation depends on signed-in Chrome sessions and local keepalive windows.

## Decisions And Constraints
- Prefer web subscriptions over APIs when they materially reduce cost.
- Keep using browser automation for ChatGPT, Gemini image generation, and Flow video generation; do not assume API substitution.
- Optimize production video around Flow credits, Flow projects, failed-tile recovery, and MP4 export.
- Do not optimize production video around Gemini/Omni limits.
- Preserve the current stage boundaries and account-rotation model.
- Treat Notion permissions and workspace connections as required operational setup, not optional config.
- Keep changes scoped; do not refactor unrelated parts while stabilizing the pipeline.

## Next Action Queue
1. Start Phase 1 from `docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md`: Flow smoke clip with `max_in_flight=1`.
2. Create `src/node/video/flow_adapter.cjs` around explicit Flow UI actions, blocker detection, and MP4 download.
3. Add `src/node/workers/submit_flow_videos.cjs --limit 1 --max-in-flight 1`.
4. Wire Flow smoke runs through `src/node/video/video_state.cjs` before any batch orchestration.
5. Build `run_videos_autonomous.cjs` only after the smoke path is observable and resumable.
6. Keep the working image pipeline intact while Flow video is implemented.

## Implementation Log
- 2026-05-26: Started Phase 0 implementation. Work is split into recoverable slices: video state helpers, submitter failure exits, saver idle timeout, and focused Node tests. Sub-agents should work in isolated worktrees and avoid image pipeline changes.
- 2026-05-26: Phase 0 submitter checkpoint complete. `src/node/workers/submit_videos.cjs` now maps preflight, missing-source, and generic submission failures to non-zero exit codes, with `src/node/workers/submit_videos_exit.test.cjs` covering the mapping.
- 2026-05-26: Phase 0 video state checkpoint complete. `src/node/video/video_state.cjs` now provides atomic state read/write and prompt/image/video reconciliation, with `tests/node/video_state.test.cjs` covering corrupt reads, saved detection, missing assets, and submitted-state preservation.
- 2026-05-26: Phase 0 saver checkpoint complete. `src/node/workers/save_videos.cjs` now has a non-watch idle timeout (`--max-idle-ms`, `CCA_SAVE_VIDEOS_MAX_IDLE_MS`, or `CCA_SAVE_VIDEOS_IDLE_TIMEOUT_MS`) and exits with code `6` on zero-progress timeout; watch mode remains unlimited.
- 2026-05-26: Phase 0 hardening checkpoint complete. `video_state.cjs` now resolves repo-relative state paths from the repo root even when invoked from a different cwd; Node tests pass for submitter, saver, and state helpers.
- 2026-05-26: Started Phase 1 Flow smoke implementation. Target is a conservative one-clip path: blocker classifier, Flow download helper, `flow_adapter.cjs` with `generateOne()`, and `submit_flow_videos.cjs --limit 1 --max-in-flight 1`. Keep Gemini video as fallback only and keep image pipeline untouched.

## Index Links
- [MEMORY_INDEX.md](MEMORY_INDEX.md)
- [ROADMAP.md](ROADMAP.md)
- [WISHLIST.md](WISHLIST.md)
- [docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md](docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md)
- [README.md](README.md)
- [Project_Overview.md](Project_Overview.md)
- [docs/core/ARCHITECTURE.md](docs/core/ARCHITECTURE.md)
- [docs/ops/TROUBLESHOOTING.md](docs/ops/TROUBLESHOOTING.md)
- [deploy/README.md](deploy/README.md)
