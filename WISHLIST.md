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
