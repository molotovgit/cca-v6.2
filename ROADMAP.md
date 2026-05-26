# Roadmap

Priority order for the next cleanup cycle.

Related workspace notes: [MASTER_MEMORY.md](MASTER_MEMORY.md), [MEMORY_INDEX.md](MEMORY_INDEX.md), [WISHLIST.md](WISHLIST.md).

Implementation plan: [docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md](docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md).

## Phase 1: Workspace setup

Goal: make the repo easy to prepare and validate before any run.

- Fix setup and docs path mismatches.
- Align account path handling across code and documentation.
- Close the `args.lang` typos in fetch and upload.
- Document the minimum workspace checks needed before execution.
- Add setup-focused tests for path resolution and argument parsing.

Exit criteria:

- A fresh workspace can be prepared from the root docs without guesswork.
- Runtime paths for accounts, setup, and docs resolve consistently.

## Phase 2: Video stabilization

Goal: make Flow-first video animation reliable, observable, and recoverable.

Status: in progress. The Flow smoke and sequential batch code paths are scaffolded with focused tests, but still need live validation against `labs.google/fx/tools/flow` before production use.

- Done: add Phase 0 state baseline in `src/node/video/video_state.cjs`.
- Done: make `submit_videos.cjs` return non-zero when submission errors accumulate.
- Done: add a non-watch idle timeout to `save_videos.cjs` so zero-progress runs exit with code `6`.
- Done: add Phase 1 blocker classification, MP4 download helper, Flow adapter skeleton, and Flow smoke worker.
- Done: add Phase 2 batch-progress helpers and `run_videos_autonomous.cjs` sequential orchestration scaffold.
- Next: run and tune a real one-clip Flow smoke test against `labs.google/fx/tools/flow`.
- Next: after the one-clip smoke succeeds, run a small sequential batch with `run_videos_autonomous.cjs`.
- Continue robust failure detection in video scripts, especially exact Flow quota, policy, subscription, failed-tile, and UI-drift text seen in live runs.
- Continue building Flow as the primary video adapter; keep Gemini video as fallback only.
- Harden orchestration around render start, render completion, and retry paths.
- Add account rotation once the live quota/credit blocker shape is measured.
- Add explicit handling for missing assets, partial outputs, and stale temp files.
- Introduce better logging for render state and failure cause.
- Add regression tests for the current video failure modes.

Exit criteria:

- Video failures stop silently failing and surface a clear reason.
- A failed render can be diagnosed and resumed without manual guesswork.

## Phase 3: Browser and account resilience

Goal: make automation less brittle when accounts or browser sessions change.

- Add `playwright-stealth` where needed.
- Improve account rotation and login diagnostics.
- Add tests for browser session initialization and fallback behavior.

Exit criteria:

- Browser startup and account handoff are predictable enough for unattended runs.

## Phase 4: End-to-end coverage

Goal: protect the full pipeline with practical regression checks.

- Add smoke tests for fetch -> refine -> prompts -> images -> upload.
- Add checks for output integrity and artifact placement.
- Add a small CI gate for the highest-risk orchestration paths.

Exit criteria:

- The main pipeline flow is covered by repeatable checks that catch regressions early.
