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
1. Flow-first video animation reliability: `video_state.cjs`, Flow adapter, `submit_videos.cjs`, `save_videos.cjs`, and `run_videos_autonomous.cjs`.
2. Workspace/setup correctness: `.env` template path, accounts path, fresh-run docs.
3. Python pipeline blockers: `args.lang` typos in fetch/upload.
4. Missing dependency: `playwright-stealth` for Gemini keepalive.
5. Test coverage around path resolution, account lookup, and video failure modes.

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
