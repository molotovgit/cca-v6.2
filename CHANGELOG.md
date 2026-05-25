# Changelog

Notable changes to CCA. The repo follows fix-by-fix PR commits to `main`;
this changelog batches them for easier scanning.

## Unreleased

### Added
- **`deploy/launch_template.bat`** — env-driven, credential-free launcher. Replaces the per-host hand-edited `launch_*.bat` pattern. Includes per-user Python auto-discovery so it works under SYSTEM context via meshctrl/schtasks. Exits cleanly (no `cmd /k` zombie).
- **`deploy/README.md`** — multi-host deployment playbook.
- **`docs/ARCHITECTURE.md`** — detailed pipeline/stage/file walkthrough.
- **`docs/DEPLOYMENT.md`** — MeshCentral + schtasks operating manual.
- **`docs/TROUBLESHOOTING.md`** — bugs we've hit, root causes, fixes.

### Changed
- **Repo layout**: all human-readable Markdown (CLAUDE.md, GUIDE.md, QUICKSTART.md, RUN.md, SETUP.md, PROMPT_FOR_CLAUDE.md) moved to `docs/`. Example config files (`.env.example`, `accounts.json.example`, `lessons.txt.example`) moved to `examples/`. Prompt-template `.txt` files (`80_prompt_formula.txt`, `refine_prompt.txt`) stay at the repo root (referenced by Python code at runtime). Code paths (`scripts/`, `tools/`, root `*.py`) unchanged — no functional breakage.
- **README.md** rewritten as a navigational index.
- **`.gitignore`** now excludes `reports/`, per-host `wrapper.bat`, and `_*` diagnostic artifacts.

## 2026-05-25

### Fixed
- **`scripts/dashboard.cjs`** — bind to `0.0.0.0` (was `127.0.0.1`), so remote dashboards are reachable from another LAN machine without runtime sed-patching. ([PR #3](https://github.com/molotovgit/cca-v6.2/pull/3))
- **`tools/notion/uploader.py`** — multi-part upload `create` and `complete` calls now retry up to 5× with exponential backoff and longer timeouts (120 s create, 180 s complete). Prior single-shot 30s/60s timeouts could abort a 30-minute upload on a single transient `httpx.ReadTimeout`. ([PR #2](https://github.com/molotovgit/cca-v6.2/pull/2))
- **`scripts/submit_prompts.cjs` + 4 sibling scripts** — multilingual `aria-label` matching for Gemini's prompt input and Send button. Matches English/Russian/Uzbek labels exactly, plus contains-fallback. The pre-fix English-only regex caused the pipeline to deadlock at 48/80 images on hosts where Gemini's UI defaulted to Russian. ([PR #1](https://github.com/molotovgit/cca-v6.2/pull/1))

## v6.2 (prior)

- Drop the 4K UHD preamble in image prompts; default to empty string.

## v6 (initial release)

- Multi-account auto-login (`accounts.json`, `auto_login.py`, `tools/accounts.py`).
- 1095 / quota detection in `scripts/save_images.cjs` + `run_autonomous.cjs`; triggers rotate → re-login → resume cycle.
- Per-image upscale watcher (`scripts/upscale_watcher.py`) — disabled by default.

## v5 → v6 migration

If you have a working v5 install, you can keep it. v6's auto-login falls back
to v5's `.env`-based credentials when `accounts.json` is absent. To get
rotation, create `accounts.json` from `examples/accounts.json.example` and add
2+ Gemini accounts.
