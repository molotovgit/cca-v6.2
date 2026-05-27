# Flow Video Implementation Plan

This plan makes video generation Flow-first. Gemini app video remains a fallback
adapter for smoke tests or emergency use, but production batch creation should
target Google Flow because the available Ultra/Pro Business plans provide a
large Flow credit budget.

## Decision

Primary target: Google Flow / Veo at `labs.google/fx/tools/flow`.

Fallback target: Gemini app video generation.

Do not optimize the production path around Gemini/Omni limits. Optimize around
Flow credits, account rotation, Flow project reuse, failed-tile recovery, and
MP4 export.

Official product references:

- Flow video generation help: https://support.google.com/labs/answer/16353334
- Flow credits: https://support.google.com/labs/answer/16526234
- Gemini app video generation help: https://support.google.com/gemini/answer/16126339

## Evidence From v4

The deprecated `cca_v4.zip` proves image generation worked and Flow video did
not:

- `reports/ch17.log` shows `80/80` images saved before video started.
- Stage 5 used Flow: `https://labs.google/fx/tools/flow/project/...`.
- The actual Flow script crashed repeatedly with `ReferenceError:
  TARGET_IN_FLIGHT is not defined`.
- After that crash was bypassed, Flow submitted clips, hit failed tiles and
  rate-limit behavior, retried, waited for video #1, then the watchdog killed
  the run with `0/80` videos saved.
- The archive does not include the actual `animate_flow.cjs` used by the log,
  so the new implementation should not depend on resurrecting that file.

The failure was not the concept of Flow automation. The failure was missing
state, missing blocker classification, and an unsafe orchestration loop.

## Mistakes To Avoid

- Do not treat "submitted" as "rendered" or "saved".
- Do not use fire-and-forget video submission.
- Do not poll forever for a `<video>` element without classifying page state.
- Do not mix Flow selectors and Gemini selectors in one worker.
- Do not start with high concurrency. v4 failed with 4 in-flight clips.
- Do not restart forever after zero progress.
- Do not hide partial failure behind exit code 0.

## Target Architecture

Add a dedicated video layer:

```text
src/node/video/
  flow_adapter.cjs
  gemini_video_adapter.cjs
  video_state.cjs
  video_download.cjs
  video_errors.cjs

src/node/workers/
  submit_flow_videos.cjs
  save_flow_videos.cjs

src/node/orchestrators/
  run_videos_autonomous.cjs
```

Keep the current image pipeline unchanged while video is stabilized.

### Adapter Boundary

The adapter owns UI-specific behavior.

Flow adapter responsibilities:

- Open or create a Flow project.
- Select the target model/mode when the UI exposes a choice.
- Configure aspect ratio, frames/video mode, and output settings.
- Upload the existing PNG as the start frame.
- Type or paste the `motion_script`.
- Submit generation.
- Detect render progress, failed tiles, quota/credit blocks, and policy blocks.
- Locate and download the finished MP4.

Gemini video adapter responsibilities:

- Remain a fallback path for single-clip smoke tests.
- Use the current upload/motion/send skeleton.
- Use the same state and error taxonomy as Flow.

## State Model

Write per-run state under `data/.cca/video_state.json`.

Initial schema:

```json
{
  "version": 1,
  "mode": "flow",
  "promptsPath": "data/prompts/g7-uz/subject/ch01-title.json",
  "imagesDir": "data/images/g7-uz/subject/ch01-title",
  "videosDir": "data/videos/g7-uz/subject/ch01-title",
  "activeProvider": "flow",
  "startedAt": "2026-05-26T00:00:00.000Z",
  "updatedAt": "2026-05-26T00:00:00.000Z",
  "items": {
    "1": {
      "idx": 1,
      "slug": "example",
      "imagePath": "data/images/.../001-example.png",
      "videoPath": "data/videos/.../001-example.mp4",
      "state": "pending",
      "attempts": 0,
      "accountLabel": null,
      "flowProjectUrl": null,
      "tabId": null,
      "submittedAt": null,
      "savedAt": null,
      "lastError": null,
      "lastScreenshot": null
    }
  }
}
```

Allowed item states:

- `pending`
- `submitting`
- `submitted`
- `rendering`
- `saved`
- `blocked_quota`
- `blocked_policy`
- `blocked_subscription`
- `failed_ui`
- `failed_download`
- `failed_timeout`
- `failed_missing_asset`

Rules:

- A clip is complete only when the expected MP4 exists and passes size checks.
- State must be rebuilt from disk before each run.
- State updates must be atomic: write temp file, then rename.
- Every failure must record `lastError` and, when possible, a screenshot path.

## Exit Codes

Use stable exit codes so the orchestrator can reason about failures:

- `0`: all requested videos saved.
- `1`: generic unrecovered failure.
- `2`: environment/preflight failure.
- `3`: UI drift or selector failure.
- `4`: quota/credit/account exhausted.
- `5`: policy/safety block.
- `6`: timeout/no progress.
- `7`: missing source images or invalid prompts.

## Implementation Phases

### Phase 0: Safety Baseline

Goal: make current video failures visible before adding Flow.

Tasks:

- Make `src/node/workers/submit_videos.cjs` exit non-zero if `errors > 0`.
- Make `src/node/workers/save_videos.cjs` support a max idle timeout in non-watch
  mode.
- Add `video_state.cjs` with atomic read/write helpers and disk reconciliation.
- Add tests for state transitions and non-zero exit conditions.

Acceptance:

- A missing source image fails the video submitter.
- A saver run with no rendered video exits with a clear timeout.
- Existing image pipeline is untouched.

### Phase 1: Flow Smoke Clip

Goal: generate and save one Flow video from one existing image.

Tasks:

- Done: create `flow_adapter.cjs`.
- Done: add `submit_flow_videos.cjs --limit 1 --max-in-flight 1`.
- Done: add blocker classification in `video_errors.cjs`.
- Done: add provider-neutral MP4 download support in `video_download.cjs`.
- Done: Flow project open/create.
- Done: start-frame upload through Flow's real Start-slot media picker.
- Implemented skeleton: motion prompt entry.
- Implemented skeleton: submit and wait-for-completion.
- Implemented skeleton: MP4 download.
- Implemented skeleton: screenshots on failed selectors or blockers.
- Next: run one live Flow fidelity test and confirm frame 0 matches the input PNG.

Acceptance:

- One selected prompt/image can become one MP4 in `data/videos/...`.
- Failure states are explicit: no silent polling.
- The run is resumable after restart.

Live smoke result on 2026-05-26:

- The worker connected to a real Flow project and selected `Video · 4s`,
  `Frames`, `16:9`, and `1x`.
- The worker reached a live video render tile and observed progress to `7%`.
- User observed after reload that two generated videos appeared in All Media, so
  the worker's failed-tile result was a false negative from the live polling
  view, not proof that Flow failed to render.
- Later live work proved completed-tile reload/rescan and authenticated MP4
  download; automation saved a valid MP4.
- The saved MP4 was prompt-generated instead of an animation of the input image.
  Root cause was upload binding to the toolbar media importer, not the Start
  slot.
- Current code fixes the binding path: click compact Start chip -> media picker
  -> Notice handling -> upload/select tile -> Add to Prompt. Verification now
  rejects full-page false positives. Pending: one live credit-spending fidelity
  run to prove the supplied source image is actually used as frame 0.

### Phase 2: Sequential Batch

Goal: process 80 images one at a time.

Status: in progress. The batch helper and autonomous sequential runner are
implemented as a tested scaffold, but live Flow validation is still required.
Keep the one-clip smoke path as the gate before treating batch automation as
production-ready.

Tasks:

- Done: add `run_videos_autonomous.cjs`.
- Done: reconcile `data/videos/...` with `video_state.json`.
- Done: process only missing/retryable indices.
- Done: add bounded retries and no-progress detection.
- Add blocker detection for Flow credits/quota, failed tiles, policy, and
  subscription/plan blocks.
- Add account rotation hook when credits/quota are exhausted.
- After the first live batch pass lands, update memory docs with observed retry
  bounds, exact blocker text, and any exit-code tuning needed from the real Flow
  UI.

Acceptance:

- A batch can resume after interruption.
- A blocked account rotates or exits with code `4`.
- A policy block records the index and exits or skips according to config.
- No run restarts forever after zero progress.

### Phase 3: Controlled Concurrency

Goal: carefully test Flow throughput.

Tasks:

- Add `CCA_VIDEO_MAX_IN_FLIGHT`, default `1`.
- Validate `2`, then `3`, then `4` manually.
- Track failed tile rate per concurrency level.
- Back off concurrency automatically when failed tiles appear.

Acceptance:

- Default remains stable and conservative.
- Concurrency only increases when evidence supports it.
- Failed tiles reduce concurrency instead of causing endless retries.

### Phase 4: Integration

Goal: make video a real pipeline stage without breaking images.

Tasks:

- Add an optional `CCA_ENABLE_VIDEO=1` stage after images.
- Keep upload behavior separate until video upload is verified.
- Update dashboard parsing to show video state.
- Add run docs and troubleshooting entries.

Acceptance:

- Default pipeline still works for images.
- Video can be enabled explicitly.
- Dashboard and logs expose current video progress and blockers.

## Error Detection Targets

The Flow adapter must classify these cases:

- Credit/quota exhausted.
- Subscription or account not eligible.
- Policy/safety blocked prompt or image.
- Failed tile visible.
- Render stuck beyond timeout.
- Download button missing.
- Download request failed.
- UI selector drift.
- Login/session expired.

Artifacts to save for diagnostics:

- Screenshot.
- Visible page text excerpt.
- URL.
- Account label/index.
- Prompt index and slug.
- Current state and retry count.

## Tests

Add focused tests before large integration:

- `video_state` creates, updates, and reconciles state.
- Missing source image becomes `failed_missing_asset`.
- Submitter exits non-zero on partial failure.
- Saver exits timeout instead of polling forever.
- Blocker classifier recognizes fixture text for quota, credits, policy, and
  failed tiles.
- Orchestrator resumes from existing MP4 files.

Use fixtures for DOM text/state where possible; do not require live Flow for
unit tests.

## First Coding Tasks

1. Add `src/node/video/video_state.cjs`.
2. Patch `submit_videos.cjs` to exit non-zero on errors.
3. Patch `save_videos.cjs` to support idle timeout and failure exit.
4. Add tests for those three pieces.
5. Add `flow_adapter.cjs` with a single `generateOne()` skeleton.
6. Run one manual Flow smoke test with `--limit 1`.

Do these before building high-level orchestration.

## Open Questions

- Which Flow project strategy works best: one project per chapter or one reusable
  project per account?
- Does Flow expose reliable download anchors, or do we need response/download
  event interception?
- What exact UI text appears for credit exhaustion on Ultra/Pro Business plans?
- Should policy-blocked clips be skipped with a marker or halt the chapter?
- How many in-flight clips are stable per account before failed tiles spike?
