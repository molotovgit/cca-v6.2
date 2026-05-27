# Roadmap

Related workspace notes: [MASTER_MEMORY.md](MASTER_MEMORY.md), [MEMORY_INDEX.md](MEMORY_INDEX.md), [WISHLIST.md](WISHLIST.md).
Video implementation plan: [docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md](docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md).

## Completed (2026-05-26 → 2026-05-27)

All four cleanup-cycle phases shipped to `DaddysBranch` and guarded by CI (`node --test` + `pytest` on every push). Full suite green (Node 309/0, Python 400 pass / 2 xfail).

- **Phase 1 — Workspace setup:** `args.lang` typos fixed; account/`.cca`/`.env` paths aligned (code + docs); `config/examples/.env.example` + `start.bat` bootstrap; `verify_workspace.cjs` pre-run health check; package `__init__.py`; `.gitignore` un-ignores `tests/`.
- **Phase 2 — Video stabilization:** Flow video pipeline Phases 0–4 — safety baseline, smoke clip, sequential batch (`run_videos_autonomous.cjs`), AIMD controlled concurrency (`video_concurrency.cjs`), and opt-in `CCA_ENABLE_VIDEO=1` pipeline integration + dashboard panel. **Mechanism proven live** (image -> Flow -> saved MP4); start-frame binding fix is implemented/tested and awaits one live fidelity proof.
- **Phase 3 — Browser/account resilience:** `playwright-stealth` declared + keepalive import hardened; additive rotation/login/blocker diagnostics (JSONL event logs) with the protected login state machines untouched; session-init/fallback tests.
- **Phase 4 — End-to-end coverage:** recovered the Python test suite (11 modules); GitHub Actions CI gate + `npm test` scripts; `check_images.cjs` artifact-placement coverage.

## Active

1. **Live Flow start-frame fidelity proof** (top priority). The root cause is fixed in code: upload now goes through Flow's real compact Start-slot picker, first-upload Notice handling is present, and verification rejects full-page false positives. Run one live clip to prove the rendered frame 0 matches the input PNG. See [WISHLIST.md](WISHLIST.md) "Flow start-frame fidelity" for the full finding + next steps.
2. After start-frame is honored: one clean live `generateOne`, then a small **live sequential batch** (`run_videos_autonomous.cjs --limit <N>`), then **live concurrency tuning** (`--max-in-flight 2/3/4`) against real failed-tile rates.
3. **Notion video upload** — currently image-only by design; wire MP4 upload once the one-clip path is faithful.

Exit criteria: a generated image is animated *as itself* into a saved MP4, then a batch runs unattended with account rotation and surfaces clear reasons on failure.
