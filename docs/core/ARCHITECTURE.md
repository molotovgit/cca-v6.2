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

Video is a separate stabilization track. The repo now contains a Flow-first
one-clip smoke path (`src/node/workers/submit_flow_videos.cjs` plus
`src/node/video/*` helpers), but it is not wired into the default 5-stage image
pipeline and still needs live Flow UI tuning before sequential or batch video
runs.

---

## 2. The 5-stage pipeline

Each chapter is processed in five sequential stages by `src/node/orchestrators/run_pipeline.cjs`.
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

**Owner**: `src/python/pipeline/fetch_chapter.py`
**Notion API** call to enumerate the chapter's Notion page, recursively walk
child blocks, find any attached `.txt` source file (if present), and write:

- `data/chapters/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}.md` — raw chapter text
- `data/chapters/.../ch{nn}-{title-slug}.meta.json` — `{ notion_page_id, source, char_count, ... }`

Skip condition: target `.md` already exists.

### Stage 2 — REFINE

**Owner**: `src/python/pipeline/refine_chapter.py`
**Driver**: Playwright-attached Chrome at port 9222 (`src/python/drivers/browser/chatgpt.py`)
Reads the raw chapter + `config/prompts/refine_prompt.txt` (the rewrite formula), sends it to
ChatGPT in a fresh conversation, retries up to 3× if the response is outside
the acceptable length range, and writes:

- `data/refined/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}.md` — refined text
- `data/refined/.../ch{nn}-{title-slug}.meta.json`

ChatGPT account rotation: on rate-limit (exit code 50), the orchestrator
rotates `accounts.json[chatgpt]` to the next entry, runs `src/python/auth/auto_login.py
--skip-gemini --force-resignin`, and retries.

### Stage 3 — PROMPTS

**Owner**: `src/python/pipeline/generate_prompts.py`
**Driver**: same ChatGPT session.
Reads `data/refined/.../ch{nn}.md` + `config/prompts/80_prompt_formula.txt` and produces:

- `data/prompts/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}.json` — array of 80 entries:
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
orchestrated by `src/node/orchestrators/run_autonomous.cjs`:

| Process | Script | Role |
|---------|--------|------|
| Submitter | `src/node/workers/submit_prompts.cjs` | Opens up to N tabs (default 10) at gemini.google.com, types each prompt, clicks Send, records `(tab_id → entry)` in `.cca/tab_map.json`. Fire-and-forget; doesn't wait for image. |
| Saver | `src/node/workers/save_images.cjs` | Polls open tabs, downloads the full-size JPEG once the image is rendered, writes it to `data/images/.../ch{nn}/{idx:03}-{slug}.png`, closes the tab. |
| Watchdog | `src/node/orchestrators/run_autonomous.cjs` (parent) | Watches the saver; if it stalls > 180 s, runs `src/node/utils/rescue_zombie_tabs.cjs` to close pending tabs and re-spawns the saver with a fresh state. |
| Upscaler | `src/python/utils/upscale_watcher.py` | Optional. Tails `data/images/.../ch{nn}/` and post-processes each new PNG to 2560×1440. Default DISABLED in v6.2. |

The submitter rotates Gemini accounts on `1095` ("content policy filter")
errors or after a configurable per-account quota.

Output: 80 `.png` files (Gemini saves them as PNG even though the source is
JPEG-internal) in `data/images/g{grade}-{lang}/{subject-slug}/ch{nn}-{title-slug}/`.

Skip condition: `data/images/.../ch{nn}/` already has 80 files.

### Stage 5 — UPLOAD

**Owner**: `src/python/pipeline/upload_images.py`
**Driver**: Notion HTTP API (`src/python/drivers/notion/uploader.py`, `src/python/drivers/notion/client.py`)
1. Zip the chapter's 80 PNGs + the refined `.md` → `data/zips/g{grade}-{lang}/{subject-slug}/{prefix}ch{nn}-{title-slug}.zip` (often 200–300 MB).
2. Find the chapter's `Images` subpage in Notion via `src/python/drivers/notion/navigator.py`.
3. Multi-part upload the zip via Notion's `/v1/file_uploads` endpoint (15 MB parts, retry per-part with exponential backoff, retry on create/complete too).
4. Attach the uploaded file as a block on the `Images` page.
5. Write `data/zips/.../{prefix}ch{nn}-{title-slug}.uploaded.json` as the idempotency marker.

Skip condition: `.uploaded.json` marker present and references a still-valid Notion file.

### Experimental video smoke path — Flow / Veo

**Status**: code-complete for one-clip smoke testing; live Flow validation still pending.

The video path is intentionally separate from the image pipeline until it is
observable and resumable in production. It uses:

| Module | Role |
|---|---|
| `src/node/video/video_state.cjs` | Atomic `data/.cca/video_state.json` read/write and prompt/image/video reconciliation. |
| `src/node/video/video_errors.cjs` | Visible-page blocker classification for quota, subscription, policy, failed render, and login/session states. |
| `src/node/video/video_download.cjs` | Provider-neutral MP4 download helper for `data:`, `blob:`, and authenticated HTTP(S) sources. |
| `src/node/video/flow_adapter.cjs` | One-clip Flow adapter skeleton: open Flow/project, upload start frame, enter motion prompt, submit, classify blockers, save MP4. |
| `src/node/workers/submit_flow_videos.cjs` | Smoke CLI for one item with `--limit 1 --max-in-flight 1`. |

Smoke command:

```bash
node src/node/workers/submit_flow_videos.cjs <prompts.json> --limit 1 --max-in-flight 1
```

Do not raise concurrency above 1 until a live smoke run succeeds and failed-tile
behavior is measured.

---

## 3. Layout

```
cca-v6.2/
├── README.md                 ← project overview + quick links
├── CHANGELOG.md              ← notable changes per version
├── .cca/                     ← runtime state (active_accounts, tab_map)
├── config/                   ← prompts and examples
│   ├── examples/             ← copy these and fill in values
│   └── prompts/              ← Stage 2 & 3 prompt templates
├── data/                     ← all generated content and runtime state
│   ├── chapters/             ← Stage 1 output
│   ├── refined/              ← Stage 2 output
│   ├── prompts/              ← Stage 3 output
│   ├── images/               ← Stage 4 output
│   ├── videos/               ← Video output
│   └── zips/                 ← Stage 5 output
├── docs/                     ← all human documentation
│   ├── ARCHITECTURE.md       ← you are here
│   ├── SETUP.md              ← detailed install + first run
│   ├── QUICKSTART.md         ← TL;DR start (single host)
│   ├── DEPLOYMENT.md         ← multi-host deployment
│   ├── TROUBLESHOOTING.md    ← bugs we've hit, root causes, fixes
│   ├── RUN.md                ← per-command reference
│   ├── GUIDE.md              ← legacy operator guide
│   ├── CLAUDE.md             ← context for AI agents
│   └── PROMPT_FOR_CLAUDE.md  ← codified context-loading prompt
├── deploy/                   ← deployment infrastructure
│   ├── launch_template.bat   ← env-driven launcher
│   └── README.md             ← how to wire schtasks
├── src/                      ← source code
│   ├── node/                 ← Node.js scripts
│   │   ├── orchestrators/    ← run_pipeline, run_autonomous
│   │   ├── workers/          ← save/submit
│   │   ├── dashboard/        │ dashboard
│   │   ├── setup/            │ chrome setup
│   │   └── utils/            │ cjs utils
│   └── python/               ← Python scripts
│       ├── pipeline/         ← core stages (fetch, refine, ...)
│       ├── auth/             ← accounts, login
│       ├── infra/            ← keepalives
│       ├── drivers/          ← browser, notion
│       └── utils/            ← misc utils
├── package.json              ← node deps
└── requirements.txt          ← Python deps
```

---

## 4. State files

Everything outside `data/` is
either source code or runtime state. Runtime state lives in three places:

| File / dir | Owner | Purpose |
|---|---|---|
| `.env` | launcher writer | Notion API key + email/password env vars (gitignored) |
| `accounts.json` | launcher writer | Full multi-account rotation list (gitignored) |
| `.cca/active_accounts.json` | `src/python/auth/accounts.py` | Current active index per provider |
| `.cca/tab_map.json` | submit/save | Open tab → prompt entry mapping |
| `.cca/saved_indices.json` | save_images | Indices known to be on disk |
| `lessons.txt` | launcher writer / human | Chapter list to process |
| `logs/pipeline.log` | wrapper.bat | Stdout/stderr of one batch run |
| `chrome-chatgpt-cdp/` | Chrome | Persistent ChatGPT profile (cookies) |
| `chrome-gemini-cdp/` | Chrome | Persistent Gemini profile |

---

## 5. Account rotation

Both ChatGPT and Gemini run with a list of credentialed accounts. The rotator
(`src/python/auth/accounts.py`) cycles them when a rate-limit is detected:

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
python -m src.python.auth.accounts status              # show active per provider
python -m src.python.auth.accounts rotate gemini       # advance to next (wrap-around)
python -m src.python.auth.accounts reset chatgpt       # back to index 0
python -m src.python.auth.accounts rotate --wrap       # rotate ALL providers
```

Detection signals:
- ChatGPT: `ChatGPTRateLimitError` raised in `src/python/drivers/browser/chatgpt.py`, surfaced as exit code 50 from `src/python/pipeline/refine_chapter.py` / `src/python/pipeline/generate_prompts.py`. `src/node/orchestrators/run_pipeline.cjs` catches this and runs rotate + `src/python/auth/auto_login.py --skip-gemini --force-resignin` then retries.
- Gemini: `1095` error code in the response from `src/node/workers/submit_prompts.cjs` → `src/node/orchestrators/run_autonomous.cjs` logs warning, may attempt rescue cycle.

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
   │  • src/python/auth/auto_login.py  │  │  • auto_login.py spawns it │
   │  • src/python/drivers/browser/…  │  │                            │
   └──────────────────────────────────┘  └────────────────────────────┘
```

Both Chromes are started ONCE per host by `src/node/setup/setup_chrome.cjs`, with the
user's profile directories under `%USERPROFILE%\chrome-{chatgpt,gemini}-cdp\`.
Subsequent launchers reuse them — `setup_chrome.cjs` checks if the ports are
already up and skips re-launching.

Cookies persist across runs in those profile dirs, so once a user has manually
signed in (or `src/python/auth/auto_login.py` has) the sessions stay live for days.

---

## 7. Dashboard

`src/node/dashboard/dashboard.cjs` is a zero-dependency Node HTTP server on
`0.0.0.0:7777`. The browser polls `/status` every 2 s for JSON state:

- **Image count** — derived from on-disk `data/images/.../ch{nn}/*.png` listing.
- **Account state** — read from `accounts.json` + `.cca/active_accounts.json`.
- **Stage progression** — derived per lesson (FETCH/REFINE/PROMPTS/IMAGES/UPLOAD ✓ checks).
- **Recent log lines** — last 30 lines of the most-recently-modified file in `reports/batch_*.log`.

The dashboard ONLY reads the filesystem. It does not orchestrate or kill
anything. Safe to refresh aggressively.

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
| Change the refine instructions | `config/prompts/refine_prompt.txt` |
| Change the 80-prompt formula | `config/prompts/80_prompt_formula.txt` |
| Add a new image provider (not Gemini) | `src/node/workers/submit_prompts.cjs`, `src/node/workers/save_images.cjs`, `src/python/drivers/browser/{provider}.py` |
| Switch the storage destination (not Notion) | `src/python/pipeline/upload_images.py`, `src/python/drivers/notion/uploader.py` |
| Adjust account rotation strategy | `src/python/auth/accounts.py` + the rate-limit hook in `src/node/orchestrators/run_pipeline.cjs` |
| Add a new dashboard panel | `src/node/dashboard/dashboard.cjs` (HTML + the `/status` JSON shape) |

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
