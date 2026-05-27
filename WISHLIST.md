# Wishlist

Backlog / follow-ons for the content automation pipeline. Most of the prior backlog
(video hardening, workspace setup, browser/account resilience, test coverage + CI)
shipped in the 2026-05-26→27 cleanup cycle — see [ROADMAP.md](ROADMAP.md) "Completed".
What remains is below.

Related: [MASTER_MEMORY.md](MASTER_MEMORY.md), [MEMORY_INDEX.md](MEMORY_INDEX.md), [ROADMAP.md](ROADMAP.md).

## Flow start-frame fidelity (TOP — bind now works; ONE open blocker: post-submit download)

Diagnosed by 3 live agents (2026-05-27) and progressively fixed across two sessions.
**Mode was never the problem** — a fresh Flow project already defaults to Video + Frames
(Frames-to-Video) with the `Start`/`End` chips present. The real bug was the upload binding
+ a false-positive verify. The start-frame BIND is now confirmed working live (credit-free
probe: our `THE ATOM` chalkboard shows in the canvas + Start slot). See
`~/.claude/.../memory/flow-startframe-root-cause.md` for the full root cause.

Fixes landed in `flow_adapter.cjs` (commit 51fb734 + the 2026-05-28 follow-ups):
1. Click the real ~50×50 `Start` chip (not the global toolbar `input[type=file]`); open the
   in-app media picker; dismiss the first-upload "Notice/I agree" modal.
2. `findDialogButton` matches only clickable controls (no container `div/span`) and picks the
   smallest match — was clicking the 780×580 dialog body center.
3. Upload matcher is `/upload media|choose file|add media/` (bare `/upload/` also hit the
   "Uploads" tab); global `input[type=file]` fallback after the click.
4. **Wait for processing**: a ~7.5 MB PNG takes **~30 s** to process and `Add to Prompt`
   stays disabled until then — `waitForAddToPromptEnabled` polls (≤90 s) before clicking
   (the old 1.5 s settle clicked a disabled button → silent no-op → empty Start slot).
5. `selectUploadedMediaTile` clicks the SMALLEST element carrying the filename (the real
   tile at ~x851), not the container whose text merely includes it.
6. `verifyStartFrameAttached`/`findStartThumbnail` fails closed and detects the bound frame
   by POSITION (slot-sized chip left of the `End` chip containing an `<img>`) — once bound,
   the chip drops the literal "Start" text, so the old text match false-negated.

**OPEN BLOCKER (next session) — post-submit download discovery.** The 2026-05-28 live run
got all the way through: Frames mode → Start-slot bind → verify → prompt → **submit (clip
generated, ~15 credits)** → then failed at `findCompletedTile`/`awaitCompletedTile` with
`failed_download` "completed-tile/download selector unknown — needs live discovery". Earlier
(text-to-video, unbound) runs downloaded fine, so this is likely a reload/timing issue
specific to the Frames-to-Video completed tile. To do:
- Inspect `awaitCompletedTile`→`reloadAndRescan`: after a bound-frame submit, does the reload
  stay on the project URL and does the completed `media.getMediaUrlRedirect` `<video>` appear
  (maybe slower, or a different src shape)? Re-run `flow_probe.cjs` against a Frames render.
- **Retry-cost guard**: a `failed_download` currently makes the orchestrator retry the whole
  `generateOne` (fresh project + re-submit = more credits). Make download-discovery failures
  rescan the EXISTING project instead of regenerating.
- THEN confirm fidelity: one clean save with frame 0 == input PNG before enabling production.
- Two earlier 2026-05-28 generations still produced regenerated clips (frame0 ≠ input) — those
  were pre-fix / wrong-tile-select; the bind fix addresses them but fidelity is unproven until
  the download step lands.
- Repro assets: input `data/images/smoke/stress-10/001-atom.png`; prompts
  `data/prompts/smoke/stress-10.json` (gitignored).

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
