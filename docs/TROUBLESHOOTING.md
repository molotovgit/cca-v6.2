# CCA v6.2 — Troubleshooting

Bugs and recoveries we've actually hit, root-caused, and fixed. Newest first.

> Looking for general operating instructions? See [DEPLOYMENT.md](DEPLOYMENT.md)
> for the multi-host playbook and [SETUP.md](SETUP.md) for first install.

---

## Pipeline halts with `ImportError: DLL load failed while importing _greenlet`

**Where you'll see it**: `reports/batch_pipeline.log` at STAGE 2 (REFINE),
inside the traceback under `playwright._impl._greenlets`.

**Root cause**: Python's `greenlet` package needs `vcruntime140.dll` /
`msvcp140.dll` from the **Microsoft Visual C++ 2015–2022 Redistributable
(x64)**. These DLLs aren't shipped with Python and aren't part of Windows by
default — they ship via the Redistributable installer.

**Diagnostic gotcha**: If your check runs from a **32-bit process** (e.g. a
32-bit Mesh agent), `if exist C:\Windows\System32\vcruntime140.dll` actually
looks at `C:\Windows\SysWOW64\` because of WOW64 redirection. SysWOW64 has the
32-bit DLLs and may be present, but Python 3.12 x64 needs the **64-bit** copy
in real System32. Always verify with PowerShell (64-bit by default):

```powershell
Test-Path C:\Windows\System32\vcruntime140.dll
```

**Fix**:
```cmd
powershell -nop -c "(New-Object Net.WebClient).DownloadFile('https://aka.ms/vs/17/release/vc_redist.x64.exe', 'C:\Users\Public\vc_redist.x64.exe')"
C:\Users\Public\vc_redist.x64.exe /quiet /norestart
```

Verify, then re-run the task:
```cmd
python -c "import greenlet; print(greenlet.__version__)"
schtasks /run /tn ccajob
```

No reboot needed.

---

## `[sub] NNN FAIL: Send message button not found` (Gemini)

**Where you'll see it**: `reports/batch_pipeline.log` during STAGE 4 (IMAGES),
many submissions failing in a row, image count stuck.

**Root cause**: The submit script (`scripts/submit_prompts.cjs`) matched
`aria-label="Send message"` exactly. When Gemini's UI is in a non-English
locale (Russian: `Отправить сообщение`, Uzbek: `Yuborish`), the selector
silently returned `null` and every submission threw.

**Fix**: Already merged into main as of [PR #1](https://github.com/molotovgit/cca-v6.2/pull/1).
The patched matcher accepts English/Russian/Uzbek aria-labels exactly, plus a
fuzzy contains-fallback. `git pull` and re-run.

**Manual verification**: connect a one-shot puppeteer probe to the live Gemini
Chrome (CDP port 9223) and dump button aria-labels to confirm which language
your host is in. See `scripts/probe_gemini.cjs` for a starting point.

---

## `httpx.ReadTimeout` during multi-part Notion upload

**Where you'll see it**: end of STAGE 5 (UPLOAD), traceback in
`tools/notion/uploader.py` at line ~116, message `The read operation timed out`.

**Root cause**: The `POST /v1/file_uploads` (create) call had `timeout=30`
with no retry. Under high Notion API load, a single transient timeout aborted
the whole upload — even though the *per-part* upload had retry +
`timeout=600`. The complete call (`POST .../complete`) had the same
single-shot pattern with `timeout=60`.

**Fix**: Already merged as of [PR #2](https://github.com/molotovgit/cca-v6.2/pull/2).
Create and complete now retry up to 5 attempts with exponential backoff
(1s, 2s, 4s, 8s, 16s) and bumped timeouts (120s create, 180s complete). `git pull`
and re-run — STAGE 5 will skip already-uploaded chapters (idempotent via
`zips/.../<name>.uploaded.json` marker).

---

## Pipeline appears stalled — task `Status: Running`, no images appearing

**Most common cause**: The launcher script ended with `cmd /k`, which holds a
cmd window open indefinitely after the work is done. The scheduled task sees
the cmd as a child process and reports `Running` forever; subsequent `/run`
calls become no-ops.

**Symptom**:
```
schtasks /query /tn ccajob /v /fo list | findstr Status
  Status:                               Running
  Last Run Time:                        5/25/2026 8:54:00 AM
```
…and it stays that way for hours without log progress.

**Fix**: `deploy/launch_template.bat` exits cleanly with `exit /b %LAST_RC%`.
If you're using a legacy launcher, either:
1. Switch to the template (recommended), or
2. Patch the trailing `cmd /k` out of your launcher.

Recover the existing stuck task:
```cmd
schtasks /end /tn ccajob
:: Optional: clean up any leftover zombies in user session
:: taskkill /F /IM chrome.exe /T
:: taskkill /F /IM node.exe /T
schtasks /run /tn ccajob
```

---

## Dashboard shows "waiting for accounts.json" but `accounts.json` exists

**Root cause**: `scripts/dashboard.cjs` short-circuits its UI render if
`state` is null. `state` is built from parsing `reports/batch_*.log`. If your
wrapper redirects to `logs/pipeline.log` (or any path the dashboard doesn't
scan), the parse fails, `state` is null, and the UI freezes at the initial
"waiting..." state.

**Backend check**: hit the JSON endpoint directly to confirm the data IS being
read:
```bash
curl -s http://<host>:7777/status | python -m json.tool
```
If `accounts.providers.chatgpt.activeEmail` is populated, the backend is fine
and the issue is the log path mismatch above.

**Fix**: write your launcher's stdout to `reports/batch_pipeline.log` (the
template does this). For an existing wrapper writing elsewhere, either change
the redirect or `Copy-Item logs\pipeline.log reports\batch_pipeline.log -Force`
on a 5-second timer.

---

## Task `Last Result: -2147020576` (0x80190060)

**Symptom**: Task runs, exits quickly, no log produced. Task scheduler
reports `Last Result: -2147020576`.

**Root cause**: Task can't be started because the target user account isn't
in an interactive session, or the agent can't impersonate them. Common when:
- User logged off / locked their screen
- User is on a remote desktop session (not console)
- `/it` mismatched with `/ru` (interactive-only flag vs run-as-user)

**Fix**:
```cmd
query user                      :: confirm user is "Active" on "console"
schtasks /query /tn ccajob /v /fo list | findstr "Logon Run"
:: Expected: "Logon Mode: Interactive only" + "Run As User: <user>"
```
If no active console session: log on once (or have someone do so), then `/run`.

---

## Task `Last Result: 267009` (0x41301)

**Not actually an error.** This is `SCHED_S_TASK_HAS_NOT_RUN` and is
sometimes shown as the "Last Result" for a task that's *currently* running but
hasn't completed yet. Check `Status` — if `Running`, it's running.

---

## Chrome opens but cookies don't persist across runs

**Root cause**: Chrome was launched under the SYSTEM context (e.g. via
`meshctrl RunCommand` with no `--runasuser` and no `/ru` schtasks wrapper).
The Chrome profile ended up at
`C:\Windows\system32\config\systemprofile\chrome-{chatgpt,gemini}-cdp\`,
which is invisible to the logged-on user and gets recreated every time.

**Fix**: Wrap everything in a scheduled task running as the user (`/ru <USER>
/it`). The launcher's `setup_chrome.cjs` will then place profiles at
`%USERPROFILE%\chrome-{chatgpt,gemini}-cdp\` which persists.

**Cleanup of SYSTEM-context Chromes** (one-time, after switching modes):
```cmd
taskkill /F /IM chrome.exe /T
rmdir /S /Q C:\Windows\system32\config\systemprofile\chrome-chatgpt-cdp
rmdir /S /Q C:\Windows\system32\config\systemprofile\chrome-gemini-cdp
```

---

## `'python' is not recognized` even though Python is installed

**Root cause**: Python installed per-user (default Microsoft Store /
python.org installer behaviour) puts `python.exe` in
`%LOCALAPPDATA%\Programs\Python\Python312\` and adds that to the *user*
PATH — not the system PATH. When meshctrl/schtasks runs the launcher under
SYSTEM context (or before login), that path isn't visible.

**Fix**: `deploy/launch_template.bat` auto-discovers per-user Python at
launch time:
```cmd
for /d %%U in (C:\Users\*) do (
  if exist "%%U\AppData\Local\Programs\Python\Python312\python.exe" (
    set "PYTHON_HOME=%%U\AppData\Local\Programs\Python\Python312"
  )
)
```
The discovered path is prepended to PATH for the rest of the launcher.

---

## ChatGPT stage exits code 50 (rate limit)

**Not really a bug.** Exit code 50 is the `ChatGPTRateLimitError` sentinel.
`run_pipeline.cjs` already handles it: rotates `accounts.json[chatgpt]`,
re-runs `auto_login.py --skip-gemini --force-resignin`, and retries the
stage. If your accounts.json only has one ChatGPT account, you'll see the
sentinel + a re-login attempt + the same failure. Add more ChatGPT accounts to
rotate through.

---

## Submit script logs `1095 detected` and image count stops

**Root cause**: Gemini's content-filter rejection. The prompt was flagged
as policy-violating. Common with certain historical/religious/political
themes. The image idx is logged but skipped.

**Mitigation**: Reduce risky vocabulary in `80_prompt_formula.txt` if a
particular topic consistently trips the filter. The dashboard surfaces a
warning banner when 1095 is detected; visit Gemini Chrome at :9223 in your
browser to confirm the rejection visually.

---

## Pipeline keeps generating images but no chapter ever finishes

Check that `images/.../ch{nn}/` actually has 80 files. If image generation
produces duplicates (the index in the filename should be unique 1-80), the
saver counts dupes. Inspect:
```cmd
dir /S images\g10-uz\jahon-tarixi\ch01-* | findstr ".png"
```
Expected: exactly 80 unique `001-*.png` through `080-*.png`. If
`.cca/saved_indices.json` has duplicates or your image dir has gaps, the
saver may be confused.

Recover with `node scripts/check_images.cjs <prompts.json>` which validates
counts and can `--write-missing` to a re-submission list.
