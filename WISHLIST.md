# Wishlist

Backlog / follow-ons for the content automation pipeline. Most of the prior backlog
(video hardening, workspace setup, browser/account resilience, test coverage + CI)
shipped in the 2026-05-26→27 cleanup cycle — see [ROADMAP.md](ROADMAP.md) "Completed".
What remains is below.

Related: [MASTER_MEMORY.md](MASTER_MEMORY.md), [MEMORY_INDEX.md](MEMORY_INDEX.md), [ROADMAP.md](ROADMAP.md).

## Flow start-frame fidelity (TOP — found in the 2026-05-27 live full-cycle proof)

The full cycle now runs end-to-end live: a Gemini image (`THE ATOM` chalkboard title
card) → `submit_flow_videos.cjs … --limit 1` → Flow → **saved MP4** (`video_state.json`
state=`saved`, valid 1.1 MB MP4, no failure path). The plumbing is proven.

**But the rendered video is NOT our image animated** — it's a *prompt-generated* atom
title card (different composition: colorful 3D ball-and-stick models + a "Building Blocks
of Matter" subtitle, none of our white-chalk `E=mc²`/`H-O-H` diagrams). The extracted
frame 0 does not match the input PNG, and the whole 4s clip is the regenerated version.
This is exactly the gap Codex flagged ("renders look prompt-generated").

Key issue: `flow_adapter.verifyStartFrameAttached` **passed (false positive)** — it
detected *a* thumbnail/filename in a Start-labelled zone, but Flow did not honor our
upload as frame 0. To fix:
- Re-run with the Flow composer **screenshotted right after upload** to see whether *our*
  image is actually loaded in the `Start` drop zone (vs. a stray/preview element the
  heuristic matched).
- Confirm the mode is genuinely **image-to-video / Frames** with the start frame bound
  (not text-to-video that ignores the image).
- Harden `verifyStartFrameAttached` to assert the Start slot holds *our* file (filename /
  thumbnail match), not just any image — so a non-honored upload fails loudly instead of
  producing a misleading "saved" prompt-clip.
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
