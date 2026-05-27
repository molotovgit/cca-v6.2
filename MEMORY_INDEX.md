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

## Current status (2026-05-28)
- **All four ROADMAP cleanup phases are complete** (workspace setup, video stabilization, browser/account resilience, end-to-end coverage). CI gate (`.github/workflows/ci.yml`) runs Node + Python tests on every push; Node video suite green (194/0).
- **Image generation works** (Gemini, browser-driven) and is production-usable — proven again at scale 2026-05-27 (10/10 images in 2m45s, 0 errors).
- **Flow project bootstrap works** — `ensureProjectComposer` opens a fresh project when none is set (clean-state runs no longer dead-end on the dashboard).
- **Flow start-frame BIND now works** (confirmed live, credit-free): real Start-slot picker → ~30 s processing wait → correct-tile select → Add to Prompt → fail-closed position-based verify. Mode was never the problem (Frames is the default).
- **One open blocker:** the post-submit **completed-tile download** (`findCompletedTile`) failed on the bound-frame run (`failed_download`); fidelity (frame0 == input) is therefore NOT yet proven.

## Single active priority
- **Flow start-frame: post-submit download discovery.** After a bound-frame submit, `awaitCompletedTile` couldn't find/download the completed tile (worked for earlier unbound runs). Fix the Frames-to-Video reload/timing, stop download failures from re-generating (credit burn), then prove frame 0 == input PNG. Full finding in [WISHLIST.md](WISHLIST.md).

## Current video decision
- Production video target is Google Flow / Veo via `labs.google/fx/tools/flow`, on Ultra/Pro Business Flow credits; Gemini app video is fallback/smoke only.
- Default concurrency `CCA_VIDEO_MAX_IN_FLIGHT=1`; raise only after live failed-tile data supports it.
- Notion upload stays image-only until the one-clip Flow path is faithful.

## What to read first
1. `MASTER_MEMORY.md` → 2. `ROADMAP.md` → 3. `WISHLIST.md` (start-frame finding) → 4. `docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md` → 5. `docs/ops/TROUBLESHOOTING.md`

## Notes
- Keep these root notes concise and current; do not add code, runtime config, or generated artifacts here.
- These are intended project memory — not gitignored.
