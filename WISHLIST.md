# Wishlist

Backlog ideas and follow-ons for the content automation pipeline.

Related planning notes: [MASTER_MEMORY.md](MASTER_MEMORY.md), [MEMORY_INDEX.md](MEMORY_INDEX.md), [ROADMAP.md](ROADMAP.md).

## Pipeline hardening

- Add stronger failure detection around video script execution.
- Make video orchestration resumable at every stage boundary.
- Add explicit timeouts and retry policy for all network-bound steps.
- Capture richer run metadata for postmortems and trend analysis.
- Add a single health check that verifies the workspace before a run starts.

## Video workflow

- Harden the video animation pipeline until failures are visible and recoverable.
- Create a video equivalent of the image autonomous orchestrator.
- Detect Gemini video-specific quota, safety, subscription, and render-failed banners.
- Exit non-zero when video submit/save completes with errors or missing outputs.
- Add guardrails for missing assets, partial renders, and stale intermediate files.
- Improve validation for generated video inputs before rendering begins.
- Add end-to-end checks that confirm a successful upload after render completion.

## Flow video — post-smoke fixes (from 2026-05-26 live smoke)

Found during Codex's first live Flow smoke test (6 attempts, all ended `failed_ui`).
The automation never reached a completed video tile over CDP — the only evidence Flow
rendered is the user manually reloading and seeing two videos in All Media. These all
block calling Phase 2 production-ready.

**Update 2026-05-26 (shipped to DaddysBranch):** reload/rescan, completed-tile
discovery, MP4 download (PROVEN live), failed-card-non-terminal, and the completed-tile
DOM capture (via `flow_probe`) are all DONE. The one remaining open item below is
proving the source image actually attaches as the start frame.

- Select Video mode explicitly before generating. Flow's model dropdown defaults to
  `Nano Banana 2` = image mode (`Generating will use 0 credits`); several smoke attempts
  silently ran in image mode and produced no video. `configureVideoMode` must confirm
  the create row shows `Video · 4s` (15 credits) before submit.
- Attach the start frame via the unlabeled left `Start` drop zone. Frames mode has no
  labeled upload button — only large unlabeled `Start`/`End` role-button drop zones
  (`Start swap_horiz Swap first and last frames End`). `uploadStartFrame` must target the
  Start slot and CONFIRM the PNG bound (thumbnail/filename); attachment was never proven
  and renders looked prompt-generated.
- Reload/rescan after submit before judging the result. `waitForCompletion` polls only
  the live generating view and throws when its failed-tile grace window expires. Need:
  submit → reload the project URL → open the `Videos` / `All Media` tab → match the new
  tile → then decide.
- Treat the `warning Failed … Reuse Prompt … Delete image … 99%` card as non-terminal.
  It persisted next to a fresh `play_circle 0%` render and proved a false negative after
  reload. Disambiguate by correlating it against a post-reload Videos-tab scan, not by
  hard-failing on the card.
- Capture the completed-tile DOM and MP4 download mechanism — both are UNKNOWN. No live
  run ever reached a finished tile, so `findDownloadTarget`/`DOWNLOAD_TEXTS` and the
  `blob:rendered` test fixture are unverified guesses. The next live run is partly a
  discovery task: record the done-tile selectors and whether download is a `<video>` src,
  a per-tile menu, or needs network interception. Then one image → one saved MP4 in
  `data/videos/...` with `video_state.json` = `saved`.

## Fetch and upload

- Fix `args.lang` typos in fetch and upload paths.
- Normalize argument parsing so language selection is consistent across stages.
- Add tests for language-specific fetch and upload behavior.

## Browser and account handling

- Add `playwright-stealth` where browser automation needs anti-detection support.
- Fix the account path mismatch so runtime and docs point to the same location.
- Improve account rotation diagnostics when login or reuse fails.

## Docs and setup

- Fix setup and docs path issues.
- Align quickstart, deployment, and troubleshooting references with current file names.
- Add a compact workspace checklist for first-run setup and validation.

## Test coverage

- Add regression tests for the known video failure modes.
- Add tests for argument parsing, file path resolution, and account lookup.
- Add smoke tests that exercise fetch, video, and upload in sequence.
- Add a minimal CI gate that blocks merges on broken orchestration paths.
