# Memory Index

Obsidian-friendly entry point for the workspace memory layer.

## Root Memory Files
- [MASTER_MEMORY.md](MASTER_MEMORY.md): primary workspace memory and operating notes.
- [ROADMAP.md](ROADMAP.md): phase status (all 4 cleanup phases complete) + active work.
- [WISHLIST.md](WISHLIST.md): remaining backlog, led by the Flow start-frame finding.
- [docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md](docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md): Flow-first video automation plan.

## Fast Context Links
- [README.md](README.md), [Project_Overview.md](Project_Overview.md), [docs/README.md](docs/README.md)
- [docs/core/ARCHITECTURE.md](docs/core/ARCHITECTURE.md), [docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md), [docs/ops/TROUBLESHOOTING.md](docs/ops/TROUBLESHOOTING.md)

## Current status (2026-05-27)
- **All four ROADMAP cleanup phases are complete** (workspace setup, video stabilization, browser/account resilience, end-to-end coverage). CI gate (`.github/workflows/ci.yml`) runs Node + Python tests on every push; suite green (Node 309/0, Python 400 pass / 2 xfail).
- **Image generation works** (Gemini, browser-driven) and is production-usable.
- **Flow video plumbing is proven live** — image -> Flow -> saved MP4 (`generateOne` runs end-to-end: mode-select, start-frame upload, submit, reload/rescan, completed-tile discovery, MP4 download, state=`saved`).
- **Flow start-frame binding fix is implemented/tested** — the adapter now binds through the real compact Start-slot picker, handles the first-upload Notice, selects the uploaded tile, and rejects false-positive full-page thumbnail matches.

## Single active priority
- **Live Flow start-frame fidelity proof.** Run one credit-spending live clip to confirm the fixed Start-slot picker path makes frame 0 match the input PNG. Full finding in [WISHLIST.md](WISHLIST.md).

## Current video decision
- Production video target is Google Flow / Veo via `labs.google/fx/tools/flow`, on Ultra/Pro Business Flow credits; Gemini app video is fallback/smoke only.
- Default concurrency `CCA_VIDEO_MAX_IN_FLIGHT=1`; raise only after live failed-tile data supports it.
- Notion upload stays image-only until the one-clip Flow path is faithful.

## What to read first
1. `MASTER_MEMORY.md` → 2. `ROADMAP.md` → 3. `WISHLIST.md` (start-frame finding) → 4. `docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md` → 5. `docs/ops/TROUBLESHOOTING.md`

## Notes
- Keep these root notes concise and current; do not add code, runtime config, or generated artifacts here.
- These are intended project memory — not gitignored.
