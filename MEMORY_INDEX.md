# Memory Index

Obsidian-friendly entry point for the workspace memory layer.

## Root Memory Files
- [MASTER_MEMORY.md](MASTER_MEMORY.md): primary workspace memory and operating notes.
- [ROADMAP.md](ROADMAP.md): phased execution plan for cleanup and stabilization.
- [WISHLIST.md](WISHLIST.md): backlog ideas and non-immediate improvements.
- [docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md](docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md): Flow-first video automation implementation plan.

## Fast Context Links
- [README.md](README.md): project summary and run paths.
- [Project_Overview.md](Project_Overview.md): map-of-content style project overview.
- [docs/README.md](docs/README.md): documentation index.
- [docs/core/ARCHITECTURE.md](docs/core/ARCHITECTURE.md): deeper system map.
- [docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md): multi-host and operational setup.
- [docs/ops/TROUBLESHOOTING.md](docs/ops/TROUBLESHOOTING.md): current failure modes and recovery notes.
- [deploy/README.md](deploy/README.md): deployment-specific guidance.

## Current Issue Priority
1. Flow-first video validation and Phase 2 sequential batch orchestration: `flow_adapter.cjs`, `submit_flow_videos.cjs`, `run_videos_autonomous.cjs`, one image -> one MP4, then one-at-a-time batch with `max_in_flight=1`.
2. Workspace/setup correctness: `.env` template path, accounts path, fresh-run docs.
3. Python pipeline blockers: `args.lang` typos in fetch/upload.
4. Missing dependency: `playwright-stealth` for Gemini keepalive.
5. Test coverage around path resolution, account lookup, and video failure modes.

## Latest Phase 0 Checkpoint
- `src/node/video/video_state.cjs` exists and reconciles prompt/image/video state into `data/.cca/video_state.json`.
- `src/node/workers/submit_videos.cjs` exits non-zero for submission errors, including missing source images.
- `src/node/workers/save_videos.cjs` exits code `6` on non-watch zero-progress idle timeout.
- Focused Node tests pass for submitter exit codes, saver timeout parsing, and video state reconciliation.

## Latest Phase 1 Checkpoint
- `src/node/video/video_errors.cjs` classifies quota, subscription, policy, failed-tile, and login blockers.
- `src/node/video/video_download.cjs` saves MP4s from `data:`, `blob:`, and authenticated HTTP(S) sources with atomic writes.
- `src/node/video/flow_adapter.cjs` exposes `generateOne()` for one Flow clip.
- `src/node/workers/submit_flow_videos.cjs` is the smoke CLI: `node src/node/workers/submit_flow_videos.cjs <prompts.json> --limit 1 --max-in-flight 1`.
- Focused Node tests pass for Phase 0 and Phase 1 modules.

## Latest Phase 2 Checkpoint
- `src/node/video/video_batch.cjs` summarizes batch progress, selects retryable items, caps exhausted retries, detects no-progress loops, and chooses aggregate exit codes.
- `src/node/orchestrators/run_videos_autonomous.cjs` is the sequential batch CLI: `node src/node/orchestrators/run_videos_autonomous.cjs <prompts.json> --limit <N> --max-attempts 3 --max-no-progress 3`.
- `submit_flow_videos.cjs` already exposes a programmatic worker API and supports injected adapter/browser dependencies for tests; no worker API patch was needed in Phase 2.
- Phase 2 is code-scaffolded, but not production-ready until a live one-clip Flow smoke and small sequential Flow batch are verified.

## Current Video Decision
- Production video target is Google Flow / Veo through `labs.google/fx/tools/flow`.
- Available Ultra/Pro Business Flow credits make Flow the correct batch target.
- Gemini app video remains fallback/smoke-test only due to usage limits.
- Start with `max_in_flight=1`; increase only after failed-tile behavior is measured.
- Do not resurrect v4's missing `animate_flow.cjs`; rebuild around explicit state and blockers.

## What To Read First
1. `MASTER_MEMORY.md`
2. `ROADMAP.md`
3. `docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md`
4. `README.md`
5. `docs/ops/TROUBLESHOOTING.md`
6. `docs/core/ARCHITECTURE.md`

## Notes
- Keep these files concise and current.
- Do not add code, runtime config, or generated artifacts here.
- Do not add these root notes to `.gitignore`; they are intended project memory.
