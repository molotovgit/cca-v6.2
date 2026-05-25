# Deployment

`launch_template.bat` is an env-driven, credential-free launcher for one host.
It supports running on user-less hosts (via MeshCentral + schtasks) thanks to
two patterns proven during the G10 Jahon Tarixi deployment:

1. **Per-user Python auto-discovery** — when invoked under SYSTEM context the
   user's `AppData\Local\Programs\Python\Python312` isn't in PATH; the
   template walks `C:\Users\*` and prepends the first match.
2. **No `cmd /k` tail** — the launcher exits cleanly so Task Scheduler reports
   the right exit code and doesn't leave a zombie cmd holding the log file.

## Prerequisites on the host
- Windows 10/11
- Python 3.12 installed per-user at the canonical path (`%LOCALAPPDATA%\Programs\Python\Python312`)
- Node.js 18+
- Git for Windows (`C:\Program Files\Git\cmd\git.exe`)
- **Microsoft VC++ 2015–2022 Redistributable** (x64) — without it, `import greenlet` fails with `DLL load failed`. Install once with `vc_redist.x64.exe /quiet /norestart`.
- A console user logged on (any account — used as `/ru` target for schtasks)

## One-time per-host setup

```cmd
:: 1. Clone v6.2 to the logged-on user's home
git clone https://github.com/molotovgit/cca-v6.2.git C:\Users\<USER>\cca-v6.2

:: 2. Install VC++ Redistributable (if not already)
curl -L -o C:\Users\Public\vc_redist.x64.exe https://aka.ms/vs/17/release/vc_redist.x64.exe
C:\Users\Public\vc_redist.x64.exe /quiet /norestart
```

## Per-job setup (per chapter range)

Create a thin **wrapper.bat** in the repo root that sets env vars and calls the template:

```cmd
@echo off
if not exist "%~dp0reports" mkdir "%~dp0reports"

set CCA_GRADE=10
set CCA_LANG=uz
set CCA_SUBJECT=jahon tarixi
set CCA_CHAPTERS=1,2,3
set NOTION_API_KEY=ntn_...
set CHATGPT_EMAIL=...
set CHATGPT_PASSWORD=...
set GEMINI_EMAIL=...
set GEMINI_PASSWORD=...

call "%~dp0deploy\launch_template.bat" > "%~dp0reports\batch_pipeline.log" 2>&1
```

The redirect to `reports\batch_pipeline.log` is what the existing dashboard
parser at `scripts/dashboard.cjs` picks up automatically.

## Scheduling on a remote host (no manual logon)

Run from any control machine that can drive the agent (MeshCentral RunCommand,
PsExec, WinRM, etc.):

```cmd
schtasks /create /tn ccajob /tr "C:\Users\<USER>\cca-v6.2\wrapper.bat" /sc once /st 23:59 /ru <USER> /it /rl highest /f
schtasks /run /tn ccajob
```

- `/it` (interactive only) lets the task run in the logged-on user's session, so
  Chrome opens with profiles at `%USERPROFILE%\chrome-*-cdp` rather than under
  `C:\Windows\system32\config\systemprofile` (which is invisible to the user
  and unable to persist cookies usefully).
- Because the template exits cleanly, the task transitions to `Ready` when
  done, so `schtasks /run` can be invoked again without `/end` cleanup.

## Multiple Gemini accounts

For automatic rotation between multiple Gemini accounts, set `ACCOUNTS_JSON`
to the raw JSON instead of relying on the minimal default:

```cmd
set ACCOUNTS_JSON={"chatgpt":[{"label":"primary","email":"...","password":"..."}],"gemini":[{"label":"primary","email":"...","password":"..."},{"label":"backup-1","email":"...","password":"..."}]}
```

## Monitoring

`scripts/dashboard.cjs` listens on `0.0.0.0:7777` so it's reachable from any
LAN host. Live image counts, account rotation state, and recent log lines all
update from `reports/batch_pipeline.log` every 2 s.
