# Wishlist

Backlog / follow-ons for the content automation pipeline. Most of the prior backlog
(video hardening, workspace setup, browser/account resilience, test coverage + CI)
shipped in the 2026-05-26→27 cleanup cycle — see [ROADMAP.md](ROADMAP.md) "Completed".
What remains is below.

Related: [MASTER_MEMORY.md](MASTER_MEMORY.md), [MEMORY_INDEX.md](MEMORY_INDEX.md), [ROADMAP.md](ROADMAP.md).

## Flow start-frame fidelity (TOP — fixed in code, pending live proof)

The full cycle now runs end-to-end live: a Gemini image (`THE ATOM` chalkboard title
card) → `submit_flow_videos.cjs … --limit 1` → Flow → **saved MP4** (`video_state.json`
state=`saved`, valid 1.1 MB MP4, no failure path). The plumbing is proven.

**But the rendered video is NOT our image animated** — it's a *prompt-generated* atom
title card (different composition: colorful 3D ball-and-stick models + a "Building Blocks
of Matter" subtitle, none of our white-chalk `E=mc²`/`H-O-H` diagrams). The extracted
frame 0 does not match the input PNG, and the whole 4s clip is the regenerated version.
This is exactly the gap Codex flagged ("renders look prompt-generated").

Root cause: `uploadStartFrame` used the global toolbar `input[type=file]`, so the image
landed in Flow's media library instead of the compact `Start` slot. `verifyStartFrameAttached`
then passed as a false positive by matching a full-page Start-labelled container plus any
image.

Fix implemented: `flow_adapter.cjs` now clicks the real compact Start chip, waits for the
media picker, dismisses the first-upload Notice, uploads/selects the tile, clicks `Add to
Prompt`, and fails closed unless a thumbnail/filename is actually near the compact Start
slot. `flow_ui.START_SLOT` now matches the live ~50x50 Start chip.

Remaining proof:
- Re-run one live Flow clip with the composer screenshotted right after Start-slot binding.
- Confirm the mode remains **Video + Frames** and the Start chip contains our thumbnail.
- Confirm the saved MP4 frame 0 matches the input PNG before enabling production video.
- Reference: input `data/images/smoke/full-cycle/001-intro.png`; output
  `data/videos/smoke/full-cycle/001-intro.mp4`; the probe's known download seam works.

## Video pipeline follow-ons (after start-frame is honored)
- Live sequential batch via `run_videos_autonomous.cjs --limit <N>`, then concurrency
  tuning `--max-in-flight 2/3/4` against real failed-tile rates (default stays 1).
- Wire **Notion video upload** — UPLOAD is image-only today (MP4s land on disk only).
- Add an end-to-end check that confirms a successful Notion upload after render.

## Smaller follow-ons
- Reconcile the 2 `xfail`'d `test_notion_navigator` cases (`2-3-mavzu` chapter-range
  parsing + unnumbered-chapter positional fallback) — decide intended behavior, then fix
  code or test.
- Richer run metadata / trend analysis for postmortems (the rotation/blocker JSONL event
  logs exist; aggregation + a dashboard view do not).
- A true fetch→refine→prompts→images→upload smoke (current coverage is per-helper unit
  tests + CI, not one end-to-end run).
- `AGENTS.md` (contributor-guidelines doc, currently untracked) — commit or discard.
