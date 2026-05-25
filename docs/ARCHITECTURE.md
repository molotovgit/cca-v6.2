# CCA v6.2 — Architecture

A guided tour of how the Creative Content Automation pipeline works end-to-end:
what each stage does, which files own which responsibilities, and how the
pieces fit together.

> If you just want to **run** the pipeline, jump to [QUICKSTART](QUICKSTART.md)
> or [DEPLOYMENT](DEPLOYMENT.md). This document is for understanding and
> extending.

---

## 1. The one-paragraph summary

CCA reads a textbook chapter from Notion, rewrites it (with ChatGPT) into a
form better suited to image generation, produces ~80 image prompts from a
fixed formula, drives Google Gemini to generate one image per prompt via a
headful Chrome session, downloads each JPEG, zips them, and uploads the bundle
back to the chapter's Notion page. A live dashboard at `:7777` reports
progress. Multiple accounts rotate automatically as quotas exhaust.

---

## 2. The 5-stage pipeline

Each chapter is processed in five sequential stages by `scripts/run_pipeline.cjs`.
Completed stages are detected on disk and skipped on re-run, so the pipeline is
idempotent and safe to retry.

```
  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │ 1. FETCH     │ → │ 2. REFINE    │ → │ 3. PROMPTS   │ → │ 4. IMAGES    │ → │ 5. UPLOAD    │
  │  Notion API  │   │  ChatGPT     │   │  ChatGPT     │   │  Gemini CDP  │   │  Notion API  │
  └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
        ~5s              ~50s              10-20 min          30-60 min           1-3 min
```

### Stage 1 — FETCH

**Owner**: `fetch_chapter.py`
**Notion API** call to enumerate the chapter's Notion page, recursively walk
child blocks, find any attached `.txt` source file (if present), and write:

- `chapters/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}.md` — raw chapter text
- `chapters/.../ch{nn}-{title-slug}.meta.json` — `{ notion_page_id, source, char_count, ... }`

Skip condition: target `.md` already exists.

### Stage 2 — REFINE

**Owner**: `refine_chapter.py`
**Driver**: Playwright-attached Chrome at port 9222 (`tools/browser/chatgpt.py`)
Reads the raw chapter + `refine_prompt.txt` (the rewrite formula), sends it to
ChatGPT in a fresh conversation, retries up to 3× if the response is outside
the acceptable length range, and writes:

- `refined/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}.md` — refined text
- `refined/.../ch{nn}-{title-slug}.meta.json`

ChatGPT account rotation: on rate-limit (exit code 50), the orchestrator
rotates `accounts.json[chatgpt]` to the next entry, runs `auto_login.py
--skip-gemini --force-resignin`, and retries.

### Stage 3 — PROMPTS

**Owner**: `generate_prompts.py`
**Driver**: same ChatGPT session.
Reads `refined/.../ch{nn}.md` + `80_prompt_formula.txt` and produces:

- `prompts/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}.json` — array of 80 entries:
  ```json
  [
    { "idx": 1, "slug": "industrial-rivalry-map-europe",
      "image_prompt": "...", "title": "...", "subject": "..." },
    ...
  ]
  ```

The 80 prompts are produced in 4 batches of 20, so transient ChatGPT failures
only cost a batch, not the whole chapter. Same rate-limit-and-rotate logic as
REFINE.

### Stage 4 — IMAGES

This is the heaviest stage and is itself a coordinated 3-process pipeline,
orchestrated by `scripts/run_autonomous.cjs`:

| Process | Script | Role |
|---------|--------|------|
| Submitter | `scripts/submit_prompts.cjs` | Opens up to N tabs (default 10) at gemini.google.com, types each prompt, clicks Send, records `(tab_id → entry)` in `.cca/tab_map.json`. Fire-and-forget; doesn't wait for image. |
| Saver | `scripts/save_images.cjs` | Polls open tabs, downloads the full-size JPEG once the image is rendered, writes it to `images/.../ch{nn}/{idx:03}-{slug}.png`, closes the tab. |
| Watchdog | `scripts/run_autonomous.cjs` (parent) | Watches the saver; if it stalls > 180 s, runs `rescue_zombie_tabs.cjs` to close pending tabs and re-spawns the saver with a fresh state. |
| Upscaler | `scripts/upscale_watcher.py` | Optional. Tails `images/.../ch{nn}/` and post-processes each new PNG to 2560×1440. Default DISABLED in v6.2. |

The submitter rotates Gemini accounts on `1095` ("content policy filter")
errors or after a configurable per-account quota.

Output: 80 `.png` files (Gemini saves them as PNG even though the source is
JPEG-internal) in `images/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}/`.

Skip condition: `images/.../ch{nn}/` already has 80 files.

### Stage 5 — UPLOAD

**Owner**: `upload_images.py`
**Driver**: Notion HTTP API (`tools/notion/uploader.py`, `tools/notion/client.py`)
1. Zip the chapter's 80 PNGs + the refined `.md` → `zips/g{grade}-{lang}/{subject-slug}/{prefix}ch{nn}-{title-slug}.zip` (often 200–300 MB).
2. Find the chapter's `Images` subpage in Notion via `tools/notion/navigator.py`.
3. Multi-part upload the zip via Notion's `/v1/file_uploads` endpoint (15 MB parts, retry per-part with exponential backoff, retry on create/complete too).
4. Attach the uploaded file as a block on the `Images` page.
5. Write `zips/.../{prefix}ch{nn}-{title-slug}.uploaded.json` as the idempotency marker.

Skip condition: `.uploaded.json` marker present and references a still-valid Notion file.

---

## 3. Layout

```
cca-v6.2/
├── README.md                 ← project overview + quick links
├── CHANGELOG.md              ← notable changes per version
├── docs/                     ← all human documentation
│   ├── ARCHITECTURE.md       ← you are here
│   ├── SETUP.md              ← detailed install + first run
│   ├── QUICKSTART.md         ← TL;DR start (single host)
│   ├── DEPLOYMENT.md         ← multi-host deployment (MeshCentral + schtasks)
│   ├── TROUBLESHOOTING.md    ← bugs we've hit, root causes, fixes
│   ├── RUN.md                ← per-command reference (run_pipeline, run_batch, …)
│   ├── GUIDE.md              ← legacy operator guide
│   ├── CLAUDE.md             ← prompt context for AI agents working on this repo
│   └── PROMPT_FOR_CLAUDE.md  ← codified context-loading prompt
├── deploy/                   ← deployment infrastructure
│   ├── launch_template.bat   ← env-driven launcher (no credentials embedded)
│   └── README.md             ← how to wire schtasks + MeshCentral
├── examples/                 ← copy these and fill in values
│   ├── .env.example
│   ├── accounts.json.example
│   └── lessons.txt.example
├── 80_prompt_formula.txt     ← Stage 3 prompt template (used by generate_prompts.py)
├── refine_prompt.txt         ← Stage 2 prompt template (used by refine_chapter.py)
├── fetch_chapter.py          ← Stage 1
├── refine_chapter.py         ← Stage 2
├── generate_prompts.py       ← Stage 3
├── upload_images.py          ← Stage 5
├── auto_login.py             ← bootstraps Chrome sessions for ChatGPT + Gemini
├── chrome_keepalive.py       ← keeps the ChatGPT Chrome alive long-term
├── gemini_keepalive.py       ← keeps the Gemini Chrome alive long-term
├── generate_images_gemini.py ← (legacy single-image generator — superseded by scripts/)
├── list_chapters.py          ← debug: enumerate a Notion subject
├── probe_contexts.py         ← debug: check CDP connectivity to Chrome
├── package.json              ← node deps (puppeteer, …)
├── requirements.txt          ← Python deps (httpx, playwright, …)
├── scripts/                  ← node-side orchestration + workers
│   ├── run_pipeline.cjs           ← per-chapter top-level driver (the 5 stages)
│   ├── run_batch.cjs              ← batch wrapper around run_pipeline for lessons.txt
│   ├── run_autonomous.cjs         ← STAGE 4 orchestrator (submit + save + watchdog)
│   ├── submit_prompts.cjs         ← STAGE 4 submitter (one Gemini tab per prompt)
│   ├── save_images.cjs            ← STAGE 4 saver
│   ├── rescue_zombie_tabs.cjs     ← STAGE 4 rescue / tab cleaner
│   ├── upscale_watcher.py         ← STAGE 4 optional upscaler
│   ├── generate_images_gemini.cjs ← single-prompt image generator (CLI usage)
│   ├── generate_images_gemini_parallel.cjs ← N-parallel batch image generator
│   ├── generate_videos_gemini.cjs ← video sibling of the image generator
│   ├── submit_videos.cjs          ← video sibling of submit_prompts
│   ├── save_videos.cjs            ← video sibling of save_images
│   ├── setup_chrome.cjs           ← launches the two CDP-attached Chromes
│   ├── dashboard.cjs              ← live status HTTP server (port 7777)
│   ├── build_report.cjs           ← post-hoc report generator
│   ├── check_images.cjs           ← validate image counts / sizes for a chapter
│   ├── salvage_40.cjs             ← one-off rescue script for chunked failures
│   ├── probe_all_tabs.cjs         ← debug
│   ├── probe_gemini.cjs           ← debug
│   └── probe_tab40.cjs            ← debug
└── tools/                    ← shared Python libraries
    ├── accounts.py           ← account rotator (read/write accounts.json + .cca/active_accounts.json)
    ├── browser/
    │   ├── chatgpt.py        ← Playwright wrapper for ChatGPT (login, ask, error sentinels)
    │   └── gemini.py         ← Playwright wrapper for Gemini
    └── notion/
        ├── client.py         ← low-level Notion API client
        ├── config.py         ← Notion API key, base URL, version constants
        ├── extractor.py      ← parse Notion blocks → markdown
        ├── navigator.py      ← find subjects / chapters / Images subpage in a Notion DB
        └── uploader.py       ← multi-part file upload + block attach
```

---

## 4. State files

Everything outside `chapters/`, `refined/`, `prompts/`, `images/`, `zips/` is
either source code or runtime state. Runtime state lives in three places:

| File / dir | Owner | Purpose |
|---|---|---|
| `.env` | launcher writer | Notion API key + email/password env vars (gitignored) |
| `accounts.json` | launcher writer | Full multi-account rotation list (gitignored) |
| `.cca/active_accounts.json` | `tools/accounts.py` | Current active index per provider |
| `.cca/tab_map.json` | submit/save | Open tab → prompt entry mapping |
| `.cca/saved_indices.json` | save_images | Indices known to be on disk |
| `lessons.txt` | launcher writer / human | Chapter list to process |
| `logs/pipeline.log` | wrapper.bat | Stdout/stderr of one batch run (or `reports/batch_pipeline.log` for dashboard-visible logs) |
| `chrome-chatgpt-cdp/` | Chrome | Persistent ChatGPT profile (cookies) |
| `chrome-gemini-cdp/` | Chrome | Persistent Gemini profile |

---

## 5. Account rotation

Both ChatGPT and Gemini run with a list of credentialed accounts. The rotator
(`tools/accounts.py`) cycles them when a rate-limit is detected:

```json
// accounts.json (gitignored)
{
  "chatgpt": [
    { "label": "primary", "email": "a@x", "password": "..." }
  ],
  "gemini": [
    { "label": "primary",  "email": "x@y", "password": "..." },
    { "label": "backup-1", "email": "z@w", "password": "..." }
  ]
}
```

Commands:
```bash
python -m tools.accounts status              # show active per provider
python -m tools.accounts rotate gemini       # advance to next (wrap-around)
python -m tools.accounts reset chatgpt       # back to index 0
python -m tools.accounts rotate --wrap       # rotate ALL providers
```

Detection signals:
- ChatGPT: `ChatGPTRateLimitError` raised in `tools/browser/chatgpt.py`, surfaced as exit code 50 from `refine_chapter.py` / `generate_prompts.py`. `run_pipeline.cjs` catches this and runs rotate + `auto_login.py --skip-gemini --force-resignin` then retries.
- Gemini: `1095` error code in the response from `submit_prompts.cjs` → `run_autonomous.cjs` logs warning, may attempt rescue cycle.

---

## 6. Chrome / CDP topology

```
   ┌─────────────────────────────────────────────────────────────────┐
   │                  Console session 1 (logged-on user)             │
   │                                                                 │
   │   ┌──────────────────────────┐    ┌──────────────────────────┐  │
   │   │ Chrome — ChatGPT profile │    │ Chrome — Gemini profile  │  │
   │   │  --remote-debugging-port=│    │  --remote-debugging-port=│  │
   │   │  9222                    │    │  9223                    │  │
   │   │  --user-data-dir=...     │    │  --user-data-dir=...     │  │
   │   │  ...chrome-chatgpt-cdp   │    │  ...chrome-gemini-cdp    │  │
   │   └────────────▲─────────────┘    └────────────▲─────────────┘  │
   │                │                               │                │
   └────────────────┼───────────────────────────────┼────────────────┘
                    │ CDP (127.0.0.1:9222)          │ CDP (127.0.0.1:9223)
                    │                               │
   ┌────────────────┼─────────────────┐  ┌──────────┼─────────────────┐
   │  Python        │                 │  │  Node    │                 │
   │  Playwright    │                 │  │  Puppeteer                 │
   │  • refine_chapter.py             │  │  • submit_prompts.cjs      │
   │  • generate_prompts.py           │  │  • save_images.cjs         │
   │  • auto_login.py (both ports)    │  │  • auto_login.py spawns it │
   │  • tools/browser/chatgpt.py      │  │                            │
   └──────────────────────────────────┘  └────────────────────────────┘
```

Both Chromes are started ONCE per host by `scripts/setup_chrome.cjs`, with the
user's profile directories under `%USERPROFILE%\chrome-{chatgpt,gemini}-cdp\`.
Subsequent launchers reuse them — `setup_chrome.cjs` checks if the ports are
already up and skips re-launching.

Cookies persist across runs in those profile dirs, so once a user has manually
signed in (or `auto_login.py` has) the sessions stay live for days.

---

## 7. Dashboard

`scripts/dashboard.cjs` is a zero-dependency Node HTTP server on
`0.0.0.0:7777`. The browser polls `/status` every 2 s for JSON state:

- **Image count** — derived from on-disk `images/.../ch{nn}/*.png` listing.
- **Account state** — read from `accounts.json` + `.cca/active_accounts.json`.
- **Stage progression** — derived per lesson (FETCH/REFINE/PROMPTS/IMAGES/UPLOAD ✓ checks).
- **Recent log lines** — last 30 lines of the most-recently-modified file in `reports/batch_*.log`.

The dashboard ONLY reads the filesystem. It does not orchestrate or kill
anything. Safe to refresh aggressively.

For a wrapper.bat that redirects to `logs/pipeline.log`, the dashboard won't
auto-pick that up — write directly to `reports/batch_pipeline.log` or
periodically copy/symlink. See [DEPLOYMENT](DEPLOYMENT.md).

---

## 8. Per-chapter idempotency contract

Every stage:

1. Computes its expected output path(s).
2. Returns success immediately if those paths exist (and look valid — non-empty, correct count, …).
3. Otherwise does the work, atomic-writes the output, and exits 0.

This is why you can `schtasks /run` a wrapper repeatedly and not waste work.
The only stages with non-trivial validity checks are STAGE 4 (image count must
equal prompt count) and STAGE 5 (upload marker must reference a valid file).

---

## 9. Where to extend

| You want to … | Edit … |
|---|---|
| Change the refine instructions | `refine_prompt.txt` |
| Change the 80-prompt formula | `80_prompt_formula.txt` |
| Add a new image provider (not Gemini) | `scripts/submit_prompts.cjs`, `scripts/save_images.cjs`, `tools/browser/{provider}.py` |
| Switch the storage destination (not Notion) | `upload_images.py`, `tools/notion/uploader.py` |
| Adjust account rotation strategy | `tools/accounts.py` + the rate-limit hook in `scripts/run_pipeline.cjs` |
| Add a new dashboard panel | `scripts/dashboard.cjs` (HTML + the `/status` JSON shape) |

---

## 10. Glossary

- **CDP** — Chrome DevTools Protocol. We attach to long-running Chromes via
  `--remote-debugging-port=N` so the same browser session can be driven by
  multiple short-lived scripts.
- **Saver / Submitter** — the two halves of STAGE 4. The submitter opens tabs
  and fires prompts; the saver downloads results and closes tabs. They run as
  separate processes so a hang in one doesn't take down the other.
- **Watchdog** — `scripts/run_autonomous.cjs`. Monitors save throughput and
  restarts the saver / rescues zombie tabs on stalls.
- **Rate-limit sentinel** — exit code `50` from Python stages, raised as
  `ChatGPTRateLimitError` from `tools/browser/chatgpt.py`. The orchestrator
  catches it to trigger account rotation.
- **1095** — Gemini's content-filter rejection error code. Logged but not
  retried (the prompt usually needs adjusting).
