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
1. Done (2026-05-26): Flow post-submit reload/rescan + completed-tile discovery + MP4 download wired (`flow_adapter.awaitCompletedTile`/`findCompletedTile`, `flow_ui.COMPLETED_TILE_SELECTOR`/`DOWNLOAD_AFFORDANCE`). MP4 download PROVEN live — two real Flow clips saved as valid MP4s via `video_download.cjs` through the `:9223` session.
2. Prove the source image is actually attached as the Flow start frame (STILL OPEN — visible renders looked prompt-generated; `verifyStartFrameAttached` exists but attachment is unproven live).
3. Run one full live `submit_flow_videos.cjs <prompts> --limit 1` end-to-end: image → generate → reload → download → `data/.cca/video_state.json` = `saved`.
4. Run a small sequential live batch with `node src/node/orchestrators/run_videos_autonomous.cjs <prompts.json> --limit <N> --max-attempts 3 --max-no-progress 3`.
5. Done (2026-05-26): Phase 3 concurrency mechanism shipped (`video_concurrency.cjs` AIMD, default `CCA_VIDEO_MAX_IN_FLIGHT=1`, `--max-in-flight`). Tune `2/3/4` against real failed-tile rates only AFTER the live one-clip + sequential paths are stable.
6. Done (2026-05-26): Phase 4 integration shipped — opt-in `CCA_ENABLE_VIDEO=1` non-fatal VIDEOS stage in `run_pipeline.cjs` (after IMAGES, before UPLOAD; default-off path unchanged), dashboard video panel, and docs. Notion upload stays image-only. Enabling video for production still depends on items 2–4.
7. Add the account-rotation hook after the real Flow quota/credit blocker shape is known.
8. Keep the working image pipeline intact while Flow video is implemented.

## Implementation Log
- 2026-05-26: Started Phase 0 implementation. Work is split into recoverable slices: video state helpers, submitter failure exits, saver idle timeout, and focused Node tests. Sub-agents should work in isolated worktrees and avoid image pipeline changes.
- 2026-05-26: Phase 0 submitter checkpoint complete. `src/node/workers/submit_videos.cjs` now maps preflight, missing-source, and generic submission failures to non-zero exit codes, with `src/node/workers/submit_videos_exit.test.cjs` covering the mapping.
- 2026-05-26: Phase 0 video state checkpoint complete. `src/node/video/video_state.cjs` now provides atomic state read/write and prompt/image/video reconciliation, with `tests/node/video_state.test.cjs` covering corrupt reads, saved detection, missing assets, and submitted-state preservation.
- 2026-05-26: Phase 0 saver checkpoint complete. `src/node/workers/save_videos.cjs` now has a non-watch idle timeout (`--max-idle-ms`, `CCA_SAVE_VIDEOS_MAX_IDLE_MS`, or `CCA_SAVE_VIDEOS_IDLE_TIMEOUT_MS`) and exits with code `6` on zero-progress timeout; watch mode remains unlimited.
- 2026-05-26: Phase 0 hardening checkpoint complete. `video_state.cjs` now resolves repo-relative state paths from the repo root even when invoked from a different cwd; Node tests pass for submitter, saver, and state helpers.
- 2026-05-26: Started Phase 1 Flow smoke implementation. Target is a conservative one-clip path: blocker classifier, Flow download helper, `flow_adapter.cjs` with `generateOne()`, and `submit_flow_videos.cjs --limit 1 --max-in-flight 1`. Keep Gemini video as fallback only and keep image pipeline untouched.
- 2026-05-26: Phase 1 blocker classifier checkpoint complete. `src/node/video/video_errors.cjs` classifies visible quota/credit, subscription, policy/safety, failed-tile, and login/session blockers into video states and stable exit codes.
- 2026-05-26: Phase 1 download helper checkpoint complete. `src/node/video/video_download.cjs` downloads MP4s from `data:`, `blob:`, and authenticated HTTP(S) URLs, writes atomically, and enforces minimum MP4 size.
- 2026-05-26: Phase 1 Flow adapter checkpoint complete. `src/node/video/flow_adapter.cjs` exposes `generateOne()` for one Flow clip: open Flow/project URL, upload start frame, enter motion prompt, submit, classify blockers, find download target, and validate the saved MP4.
- 2026-05-26: Phase 1 Flow smoke worker checkpoint complete. `src/node/workers/submit_flow_videos.cjs` supports `--limit` and smoke-only `--max-in-flight 1`, reconciles video state, selects retryable items, opens a Flow page, calls `flow_adapter.generateOne()`, and writes item state after each attempt.
- 2026-05-26: Documentation cleanup checkpoint. README, architecture, runbook, Project Overview, memory, roadmap, and Flow plan now describe the Flow smoke code path as code-complete but not live-validated.
- 2026-05-26: Workspace cleanup checkpoint. Removed temporary sub-agent worktrees and `agent/*` branches from Phase 0/1 delegation. Removed Python test/cache artifacts (`__pycache__`, `.pytest_cache`). Did not broad-clean ignored runtime state (`data/`, `.swarm/`, `.claude/`) or evidence file `cca_v4.zip`.
- 2026-05-26: Started Phase 2 sequential-batch implementation. Target is `run_videos_autonomous.cjs` plus focused batch-progress/retry helpers: resume from `video_state`, process Flow clips one at a time, stop on quota/policy, bound retries/no-progress, and keep live Flow smoke as a required validation gate before production batch use.
- 2026-05-26: Phase 2 batch helper checkpoint complete. `src/node/video/video_batch.cjs` summarizes video state, selects retryable items, caps exhausted retries, builds progress snapshots/signatures, detects no-progress, and chooses aggregate exit codes for sequential orchestration.
- 2026-05-26: Phase 2 autonomous orchestrator checkpoint complete. `src/node/orchestrators/run_videos_autonomous.cjs` loops `submit_flow_videos` one clip at a time, re-reads `video_state`, honors `--limit`, `--max-attempts`, and `--max-no-progress`, and exits with stable codes for completion, quota, policy, missing assets, retry exhaustion, and no-progress timeout.
- 2026-05-26: Phase 2 docs/memory checkpoint. Batch helper and orchestrator scaffolding are code-complete with focused tests, but production readiness still depends on one live Flow smoke pass and one small live sequential batch pass.
- 2026-05-26: Phase 2 workspace cleanup checkpoint. Closed Phase 2 sub-agents and removed temporary worktrees plus `agent/phase2-*` branches. Local Obsidian state, Ruflo AgentDB runtime files, and `cca_v4.zip` remain uncommitted workspace artifacts.
- 2026-05-26: Live Flow smoke checkpoint. Created ignored smoke data at `data/prompts/smoke/flow-smoke.json` and `data/images/smoke/flow-smoke/001-intro.png`, connected to Flow project `a14d1a43-d896-4da3-a84b-ebb5195b1b55`, and hardened `flow_adapter.cjs` for live UI realities: project-ready wait, Video/Frames/16:9/1x/4s mode setup, Flow start-frame drop-zone fallback, prompt textbox detection, submit-button ranking, and stale failed-tile handling. The worker reached an actual Flow video tile and progress, but incorrectly marked the run failed before rediscovering completed renders.
- 2026-05-26: Live Flow smoke correction from user observation. After reloading Flow, two generated videos appeared in All Media, so Flow did render. The current automation gap is post-submit discovery/download and state reconciliation after reload. The start-frame image path is still not proven because the visible completed videos looked prompt-generated, so the next code slice must verify actual image-to-video attachment before treating the smoke as complete.
- 2026-05-26: Probe discovery. `flow_probe.cjs` (CDP discovery harness) captured the previously-unknown completed-tile DOM: a finished Flow tile exposes a `<video>` whose src is `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<UUID>`; there is no per-tile download button (download is via that authenticated URL).
- 2026-05-26: Phase 3 + download-seam checkpoint (merged to DaddysBranch). Shipped controlled concurrency as a 4-lane swarm: `src/node/video/video_concurrency.cjs` (AIMD controller, `parseMaxInFlight`, default in-flight 1), N-slot concurrent scheduler + `classifyControllerResult` + state-write mutex in `submit_flow_videos.cjs`, `--max-in-flight`/`CCA_VIDEO_MAX_IN_FLIGHT` wiring (controller owned across the loop) in `run_videos_autonomous.cjs`, and wired the live download seams in `flow_adapter.cjs`/`flow_ui.cjs` from the probe findings. Integration gate caught + fixed a double-`recordOutcome` (the worker is the single source of AIMD outcomes; the orchestrator only owns controller lifecycle). Full Node suite 248 pass / 0 fail. MP4 download PROVEN live: two real Flow clips downloaded as valid MP4s (`ftyp isom`, ~0.9 MB / ~1.6 MB) via `video_download.cjs` redirect-following + session cookies through Chrome `:9223`. Default concurrency stays 1 (structural). Still pending live validation: full one-clip `generateOne` and start-frame attachment.
- 2026-05-26: Phase 4 integration checkpoint (merged to DaddysBranch). 3-lane swarm: opt-in `CCA_ENABLE_VIDEO=1` splices a NON-FATAL `VIDEOS` stage into `run_pipeline.cjs` after IMAGES (best-effort — never blocks image UPLOAD; default-off path byte-identical, still 5 stages), pure helpers in new `src/node/video/video_stage.cjs`; dashboard gains an additive video panel (saved/total, state counts, last blocker/screenshot) via new `src/node/video/video_dashboard.cjs` (reuses `summarizeVideoItems`); docs updated (TROUBLESHOOTING Flow-video, ARCHITECTURE opt-in VIDEOS stage, README flags). Notion UPLOAD stays image-only (MP4s on disk only). Lanes were file-disjoint with no runtime coupling → clean merge, no reconciliation. Authoritative full Node suite 268 pass / 0 fail. Phases 0–4 now all implemented; production video still gated on the live one-clip `generateOne` proof + start-frame attachment.

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
