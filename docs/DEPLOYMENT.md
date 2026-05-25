# CCA v6.2 — Multi-Host Deployment

How to run the pipeline across 1–N machines from a single control point. Based
on the real G10 Jahon Tarixi production deployment (31 chapters × ~80 images,
spread across 10 hosts in parallel).

> Single-host install? See [SETUP.md](SETUP.md). This document is for
> orchestrating many hosts.

---

## Architecture

```
   Operator (any LAN box, no special role)
     │
     │  meshctrl RunCommand / Upload / Download
     ▼
   MeshCentral server (controls the agent on each host)
     │
     ├──▶ Host-01 ── schtasks ──▶ wrapper.bat ──▶ launch_template.bat
     ├──▶ Host-02 ── schtasks ──▶ wrapper.bat ──▶ launch_template.bat
     │   ...
     └──▶ Host-10 ── schtasks ──▶ wrapper.bat ──▶ launch_template.bat
```

Each host runs the pipeline for a slice of the work (e.g. 3 chapters). The
operator coordinates start/stop/monitor via the MeshCentral agent installed on
every host. The dashboard on each host reports progress on
`http://<host-ip>:7777`.

---

## Why this topology

- **MeshCentral** is already deployed in the target environment and exposes
  `meshctrl RunCommand`, `Upload`, and `Download` — enough to bootstrap
  everything else without needing SSH/WinRM/RDP.
- **schtasks** with `/it` (interactive only) and `/ru <user>` lets us run the
  launcher in the **logged-on user's session** even when meshctrl is invoked
  from the SYSTEM-context agent. This is critical because:
  - Chrome's profile must live under `%USERPROFILE%` (not the SYSTEM profile)
    so cookies persist and the user can intervene if needed.
  - The pipeline's auto-login flow assumes a real interactive desktop session.
- **launch_template.bat** is the env-driven, credential-free launcher. Each
  host gets a tiny `wrapper.bat` that exports env vars and `call`s the template
  with stdout redirected to `reports/batch_pipeline.log` (which the dashboard
  parses natively).

---

## Per-host prerequisites

Install once on every host. Most of these are pre-installed in standard
Windows 11 + dev-tooling images; the only commonly-missing ones are Python and
the VC++ Redistributable.

| Component | Version | How to verify |
|---|---|---|
| Windows | 10/11 | `winver` |
| User account | Any non-Administrator | `query user` |
| Git for Windows | 2.x | `git --version` (must be in user PATH) |
| Node.js | 18+ | `node --version` |
| Python | 3.12 x64, per-user install at `%LOCALAPPDATA%\Programs\Python\Python312` | `python --version` |
| **VC++ 2015–2022 Redistributable (x64)** | Latest | `dir C:\Windows\System32\vcruntime140.dll` (must exist in real System32, NOT just SysWOW64) |
| Google Chrome | Latest stable, at `C:\Program Files\Google\Chrome\Application\chrome.exe` | `dir "C:\Program Files\Google\Chrome\Application\chrome.exe"` |
| MeshCentral agent | Connected to the org's MeshCentral server | Visible in MeshCentral web UI |

### One-line VC++ install if missing

```cmd
powershell -nop -c "(New-Object Net.WebClient).DownloadFile('https://aka.ms/vs/17/release/vc_redist.x64.exe', 'C:\Users\Public\vc_redist.x64.exe')"
C:\Users\Public\vc_redist.x64.exe /quiet /norestart
```

> ⚠️ **Don't trust 32-bit `if exist` checks.** If your MeshCentral agent is
> 32-bit, `if exist C:\Windows\System32\vcruntime140.dll` silently checks
> `SysWOW64` instead (WOW64 redirection). Use PowerShell's
> `Test-Path C:\Windows\System32\vcruntime140.dll` for accurate checks.

---

## Per-job deployment

For each host, you need three things on disk:

1. **The repo**, cloned to `C:\Users\<USER>\cca-v6.2`
2. **A wrapper.bat** at `C:\Users\<USER>\cca-v6.2\wrapper.bat` that exports
   the job's env vars and calls `deploy/launch_template.bat`
3. **A scheduled task** that runs the wrapper as the logged-on user

### 1. Clone

```cmd
git clone https://github.com/molotovgit/cca-v6.2.git C:\Users\<USER>\cca-v6.2
```

### 2. Write wrapper.bat

Sample wrapper for "PC1 — Grade 10, Jahon Tarixi, chapters 1-3":

```cmd
@echo off
if not exist "%~dp0reports" mkdir "%~dp0reports"

set CCA_GRADE=10
set CCA_LANG=uz
set CCA_SUBJECT=jahon tarixi
set CCA_CHAPTERS=1,2,3

set NOTION_API_KEY=ntn_REDACTED
set CHATGPT_EMAIL=primary@chatgpt.example
set CHATGPT_PASSWORD=REDACTED
set GEMINI_EMAIL=primary@gemini.example
set GEMINI_PASSWORD=REDACTED

REM Optional: multiple Gemini accounts for rotation
set ACCOUNTS_JSON={"chatgpt":[{"label":"primary","email":"...","password":"..."}],"gemini":[{"label":"primary","email":"...","password":"..."},{"label":"backup-1","email":"...","password":"..."}]}

call "%~dp0deploy\launch_template.bat" > "%~dp0reports\batch_pipeline.log" 2>&1
```

The wrapper is **gitignored** (it contains secrets). Generate one per host.

### 3. Register the scheduled task

```cmd
schtasks /create /tn ccajob /tr "C:\Users\<USER>\cca-v6.2\wrapper.bat" /sc once /st 23:59 /ru <USER> /it /rl highest /f
schtasks /run /tn ccajob
```

Flags explained:
- `/sc once /st 23:59` — schedule for tonight 23:59. We never let the schedule
  fire; we always `/run` manually. This is just a placeholder schedule.
- `/ru <USER>` — run as the logged-on user (so Chrome opens in their session).
- `/it` — interactive only, requires the user to be logged on. Won't run if
  no one is at the console.
- `/rl highest` — run with elevated privileges (needed for some Chrome /
  network operations).

---

## End-to-end flow per host (timed)

| Phase | Typical duration | What's happening |
|---|---|---|
| `setup_chrome.cjs` | 5-10 s | Launches two Chromes with persistent profiles, attached at CDP ports 9222/9223 |
| `auto_login.py` | 20-60 s (or 0 if cookies persist) | Drives the sign-in flow if no session cookie |
| FETCH ch N | 5-10 s | Notion API call + extractor |
| REFINE ch N | 40-80 s | One ChatGPT round-trip with retry |
| PROMPTS ch N | 8-20 min | 4 batches × ~3 min each via ChatGPT |
| IMAGES ch N | 25-60 min | 80 prompts × ~15-30 s/image, parallelized 10-way |
| UPLOAD ch N | 1-5 min | Zip + 17-part Notion multi-part upload |
| **Per chapter total** | **35-90 min** | |

For a 3-chapter slice: **100-270 minutes wall-clock per host**.

Image count is the only useful real-time progress signal: open
`http://<host-ip>:7777` and watch the IMAGE count tick up.

---

## Operating the cluster from one machine

The repo's `scripts/` directory doesn't include the meshctrl wrappers we used
for the original deployment (they're operator-side, host-list-specific, and
contain device IDs that change per environment). The reference pattern:

```python
# operator_run.py — pseudocode
import subprocess, threading
HOSTS = [(2, '<mesh-node-id>', 'Host-2'), (3, '<mesh-node-id>', 'Host-3'), ...]

def go(pc, nid, user):
    target = f'C:\\Users\\{user}\\cca-v6.2'
    cmd = f'schtasks /run /tn ccapc{pc}'
    subprocess.run([
        'node', 'C:/path/to/meshctrl.js', 'RunCommand',
        '--url', 'wss://meshcentral.local', '--loginuser', 'admin', '--loginpass', '...', '--ignoreCert',
        '--id', nid, '--run', cmd, '--reply'
    ], capture_output=True, text=True, timeout=60)

threads = [threading.Thread(target=go, args=h) for h in HOSTS]
for t in threads: t.start()
for t in threads: t.join()
```

Lessons from the original deployment:

- **`meshctrl RunCommand --reply`** is the right primitive. It's synchronous,
  cheap, and reliable. Don't try to drive the MeshCentral web UI via Puppeteer
  for routine tasks — it's brittle and slow.
- **Don't taskkill `cmd.exe` indiscriminately** in a runcmd payload — you'll
  kill the agent's own shell mid-command. Filter by `SESSION eq 1` or by user
  name if you must.
- **`schtasks /end`** kills the task tree, including detached `start /B` and
  `cmd /k` children. Don't reach for taskkill first.
- **Run tasks must exit cleanly.** A launcher ending in `cmd /k` leaves the
  task stuck `Running` forever, and a subsequent `schtasks /run` is a no-op.
  The template launcher in `deploy/launch_template.bat` exits with the last
  chapter's RC.

---

## Account distribution across hosts

If you have N hosts and M Gemini accounts, the simplest split:

- N ≤ M: one Gemini account per host (primary). All accounts available as
  per-host fallbacks too.
- N > M: stripe accounts across hosts. Pair hosts that share a Gemini account
  with disjoint chapter ranges so they don't hit each other's quota
  simultaneously.

ChatGPT can be shared more aggressively (refine + prompts together are only
~10–20 min per chapter, so one account can support 4–6 hosts before hitting
quota).

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Task `Status: Running` forever, no progress | Launcher ends in `cmd /k` | Use `deploy/launch_template.bat` (already does `exit /b`). For legacy launchers, edit + redeploy. |
| `Last Result: 267011` ("not run") | User not logged on or `/it` mismatch | `query user` to confirm; if no session, log in once. |
| `Last Result: 1`, log shows greenlet ImportError | VC++ Redist missing | Install via `vc_redist.x64.exe /quiet /norestart`, retry. |
| Task fires but `Last Result: -2147020576` | Mesh agent can't impersonate user | Confirm user is `console` session, not `disconnected`. |
| Submit/save "Send message button not found" | Gemini UI in non-English locale (Russian/Uzbek) | Fixed in v6.2 (multilingual selectors). `git pull` and retry. |
| Upload `httpx.ReadTimeout` mid-create | Notion API slow | Fixed in v6.2 (retry + longer timeout on create/complete). `git pull` and retry. |
| Logs/pipeline.log frozen at BATCH SUMMARY | Wrapper writes to `logs/`, dashboard reads `reports/` | Write directly to `reports/batch_pipeline.log` (the template does this). |
| Dashboard shows "waiting for log..." despite progress | `scripts/dashboard.cjs` parses only `reports/batch_*.log` | Ensure wrapper writes there, not to `logs/`. |
| Chrome opens but cookies don't persist | Chrome started under SYSTEM context | Run task as user (`/ru`, `/it`), NOT as agent. |

---

## Monitoring across all hosts

Open all N dashboards in browser tabs. There's no built-in aggregated view —
this is intentional, to keep `dashboard.cjs` zero-dependency and per-host. If
you need one pane of glass, build a tiny aggregator (the existing
`/status` JSON endpoint is easy to scrape).

---

## Decommissioning

Per host:
```cmd
schtasks /end /tn ccajob
schtasks /delete /tn ccajob /f
taskkill /F /IM chrome.exe /T
taskkill /F /IM node.exe /T
del /F /Q C:\Users\<USER>\cca-v6.2\.env
del /F /Q C:\Users\<USER>\cca-v6.2\accounts.json
del /F /Q C:\Users\<USER>\cca-v6.2\wrapper.bat
```

Leave the cloned repo and Chrome profiles for the next job (they cache the
node_modules, login cookies, etc.).
