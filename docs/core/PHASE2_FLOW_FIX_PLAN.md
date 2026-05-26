# Phase 2 Flow Fix Plan (post-smoke)

Coordination doc for the fix swarm that closes the gaps Codex found in the
2026-05-26 live Flow smoke. Companion to
[FLOW_VIDEO_IMPLEMENTATION_PLAN.md](FLOW_VIDEO_IMPLEMENTATION_PLAN.md) and the
post-smoke items in [../../WISHLIST.md](../../WISHLIST.md).

## Corrected reality (what the live smoke actually showed)

- 6 automation attempts, all ended `failed_ui`. The worker **never reached a
  completed video tile over CDP**.
- The only evidence Flow rendered is the user manually reloading and seeing two
  videos in All Media.
- Several attempts silently ran in **image mode** (`Nano Banana 2`, `0 credits`),
  not video, so the start frame was never confirmed attached.
- The completed-tile DOM and the MP4 download mechanism were **never observed** —
  they are genuine unknowns.

## Guiding principle

Agents build the **mechanism**, the **injectable seams**, and the **discovery
tool** against mocks/fixtures. Agents do **not** invent live selectors and do
**not** validate live (no Chrome in agent context). The two unknown selectors are
captured by a human-run live session using `flow_probe.cjs`, then filled into
`flow_ui.cjs`.

## Target `generateOne()` pipeline

1. `goto` + `waitForFlowReady` (unchanged)
2. `configureVideoMode` **+ verify**: confirm the create row shows `Video · 4s`
   and `Generating will use 15 credits` (not `0 credits`). Throw a clear
   `failed_ui` "stuck in image mode" otherwise.
3. `uploadStartFrame` targets the **left unlabeled `Start` drop zone** (Frames
   mode has no labeled upload button) **+ verify attachment**: detect a Start-slot
   thumbnail/filename; throw `failed_ui` "start frame did not attach" if absent.
4. `enterMotionPrompt` → `submitGeneration` (unchanged)
5. **submit → reload project URL → open `Videos`/All Media tab → find the new
   completed tile** (replaces live-view polling). The `Failed … Reuse Prompt …
   Delete image … 99%` card is **non-terminal** — confirm via a post-reload scan
   before classifying failure.
6. Download the completed tile's MP4 + `validateVideoFile` (existing
   `video_download.cjs` plumbing).

## Frozen `flow_ui.cjs` contract (source of truth for both coders)

Pure module, no I/O. Exported names are frozen so lanes parallelize:

- `MODE_DROPDOWN_RE` — opens the model/mode panel
  (`/nano banana|crop_16_9|omni flash|video\s*[·.]/i`)
- `OUTPUT_TYPE_TOKENS` `{ image, video: /play_circle\s*video|video/i, frames: /crop_free\s*frames|frames/i }`
- `ASPECT_TOKENS`, `DURATION_TOKENS` (`/^4s$/i` …), `COUNT_TOKENS` (`/^1x$/i` …)
- `CREDITS_RE` = `/generating will use (\d+) credits/i` — captured `0` ⇒ image mode
- `CREATE_ROW_VIDEO_RE` = `/video\s*[·.]\s*4s/i` — confirms video mode active
- `START_SLOT` = `{ textRe: /start|frame|drop|media|upload/i, minW: 100, minH: 100, pick: 'leftmost' }`
- `MEDIA_TABS` = `{ allMedia: /all media/i, images: /view images images/i, videos: /view videos videos|videocam/i }`
- `FAILED_CARD_RE` = `/\bfailed\b.{0,120}\b(reuse prompt|delete image|99%)\b/i` — **NON-TERMINAL**
- `PROGRESS_RE` = `/\b(\d{1,3})%\b/`, plus `/(generating|rendering|creating)/i`
- `COMPLETED_TILE_SELECTOR = null` — **TODO(live)**: finished-tile selector in Videos tab
- `DOWNLOAD_AFFORDANCE = null` — **TODO(live)**: `<video>` src vs per-tile menu vs network capture
- Pure helpers: `parseCredits(text)`, `isVideoModeConfirmed(text)`,
  `isFailedCard(text)` (advisory only)

## Lanes (disjoint file ownership)

### Lane 1 — coder-modules (new files only)
- `src/node/video/flow_ui.cjs` + `flow_ui.test.cjs` — the frozen module above.
- `src/node/workers/flow_probe.cjs` + `flow_probe.test.cjs` — a CDP harness that
  connects to `127.0.0.1:9223`, navigates to the project URL, opens the Videos/All
  Media tab, and dumps: tile DOM excerpts, any `<video>` srcs, candidate download
  buttons/menus, and screenshots, into a JSON report under
  `data/.cca/flow_probe/`. Separate the DOM-extraction `page.evaluate` body into a
  pure exported function so it is unit-testable with a mock page; keep the CDP
  connect/navigate as a thin wrapper.
- Acceptance: `flow_ui` exports match the contract; probe extraction logic has
  fixture tests; no edits outside these files.

### Lane 2 — coder-adapter
- `src/node/video/flow_adapter.cjs` + `flow_adapter.test.cjs`
- `src/node/video/video_errors.cjs` + `video_errors.test.cjs`
- Tasks: `verifyVideoMode` (reject `0 credits`); `uploadStartFrame` → Start slot +
  `verifyStartFrameAttached`; refactor `waitForCompletion` into
  submit→reload→open-Videos-tab→`findCompletedTile`→download, with injectable
  seams `options.findCompletedTile` / `options.findDownloadTarget` defaulting to a
  documented `null` ⇒ "needs live discovery" throw; make the failed card
  non-terminal (require a post-reload scan).
- **Self-contained this round:** define the few needed regexes inline (matches the
  file's existing style); do **not** import `flow_ui.cjs` (Lane 1 owns it), so the
  two coder branches stay file-disjoint and merge clean. A post-merge step dedupes
  the constants into `flow_ui.cjs`.
- Constraints: do **not** invent the unknown live selectors — leave `TODO(live)`
  seams. Keep default sequential behavior (`--max-in-flight 1`) and the image
  pipeline untouched. All new logic must be mock-testable via injected `page`.

### Lane 3 — reviewer
- Own worktree. Wait for both coders. Merge both agent branches, run
  `node --test` across all video/worker/orchestrator test files, confirm 0 fail,
  confirm no image-pipeline files changed and the default path is unchanged.
  Report results (pass/fail, conflicts, coverage of the seams) to the lead. Do
  **not** push to `DaddysBranch`.

## Test strategy

- Built-in `node:test` + `node:assert/strict`, `*.test.cjs`, injected `page`
  mocks (no live Chrome). Mock sequence for Lane 2: failed-card visible → reload →
  completed tile present.
- Full suite must stay green (currently 50 video tests pass).

## Live-discovery last mile (human, not agents)

1. Launch Flow Chrome: `open -na "Google Chrome" --args --remote-debugging-port=9223 --user-data-dir="/Users/aisigma/data/chrome_gemini_profile" "https://labs.google/fx/tools/flow/project/a14d1a43-d896-4da3-a84b-ebb5195b1b55"` (note: profile is under `$HOME`, not the repo; `nohup` does **not** open the port).
2. Run `node src/node/workers/flow_probe.cjs` to capture the completed-tile DOM +
   download affordance.
3. Fill `COMPLETED_TILE_SELECTOR` + `DOWNLOAD_AFFORDANCE` in `flow_ui.cjs`, then
   run one live `submit_flow_videos.cjs --limit 1` to prove one image → one saved
   MP4 with `video_state.json` = `saved`.

## Out of scope

Phase 3 concurrency, the image pipeline, and live validation. Worktrees are new
and branched from `DaddysBranch`; the stale `agent/phase2-*` worktrees are left
untouched per prior decision.
