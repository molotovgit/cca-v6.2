# Creative Content Automation v6.2

A 5-stage pipeline that turns a textbook chapter on Notion into 80 illustrated
prompts, generates images via Google Gemini, and uploads the result back to
the chapter's Notion page. Designed to run unattended across many hosts.

Video automation is being rebuilt as a Flow-first path. The current codebase has
a one-clip Flow smoke worker and supporting state/error/download modules, but
the live Flow UI smoke run still needs to be executed and tuned before batch
video production is considered ready.

```
FETCH ─→ REFINE ─→ PROMPTS ─→ IMAGES ─→ UPLOAD
Notion   ChatGPT    ChatGPT    Gemini    Notion (zip + refined .md)
                                  │
                          on rate-limit
                                  │
       rotate accounts.json → re-login next account → resume
```

A live dashboard at `http://<host>:7777` reports progress, account state, and
recent log lines.

---

## Pick your path

| You want to… | Read |
|---|---|
| **Understand the architecture** | [docs/core/ARCHITECTURE.md](docs/core/ARCHITECTURE.md) |
| **Run on a single host** | [docs/user/QUICKSTART.md](docs/user/QUICKSTART.md) · [docs/user/SETUP.md](docs/user/SETUP.md) |
| **Deploy across many hosts** | [docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md) · [deploy/README.md](deploy/README.md) |
| **Debug something that broke** | [docs/ops/TROUBLESHOOTING.md](docs/ops/TROUBLESHOOTING.md) |
| **Look up a specific command** | [docs/user/RUN.md](docs/user/RUN.md) |
| **Understand video automation status** | [docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md](docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN.md) |
| **Hand the codebase to an AI agent** | [docs/core/CLAUDE.md](docs/core/CLAUDE.md) · [docs/core/PROMPT_FOR_CLAUDE.md](docs/core/PROMPT_FOR_CLAUDE.md) |
| **See what changed** | [CHANGELOG.md](CHANGELOG.md) |

---

## TL;DR — single-host run

```cmd
git clone https://github.com/molotovgit/cca-v6.2.git
cd cca-v6.2
copy config\examples\.env.example .env             :: fill in NOTION_API_KEY + credentials
copy config\examples\accounts.json.example accounts.json   :: fill in your accounts
copy config\examples\lessons.txt.example lessons.txt       :: list chapters to process
setup.bat                                    :: one-time: deps + launch Chromes
start.bat                                    :: run the pipeline
```

Open `http://localhost:7777` to watch progress.

---

## TL;DR — multi-host with MeshCentral + schtasks

Per host, after one-time prereqs (Python 3.12, Node 18+, Git, Chrome,
VC++ Redist):

```cmd
git clone https://github.com/molotovgit/cca-v6.2.git C:\Users\<USER>\cca-v6.2
:: Create a wrapper.bat that sets env vars and calls deploy\launch_template.bat
schtasks /create /tn ccajob /tr "C:\Users\<USER>\cca-v6.2\wrapper.bat" ^
  /sc once /st 23:59 /ru <USER> /it /rl highest /f
schtasks /run /tn ccajob
```

Full walkthrough in [docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md).

---

## Layout

```
.
├── README.md                ← you are here
├── CHANGELOG.md
├── .cca/                    ← runtime state
├── config/                  ← prompts and examples
├── data/                    ← all generated content
├── docs/                    ← all human documentation (core/, user/, ops/)
├── deploy/                  ← deployment infrastructure
├── src/                     ← source code (node/, python/)
├── setup.bat / start.bat    ← single-host quick-start
├── package.json             ← node deps
└── requirements.txt         ← Python deps
```

For a deep dive into each script and how the stages connect, read
[docs/core/ARCHITECTURE.md](docs/core/ARCHITECTURE.md).

---

## Requirements

- Windows 10/11 (the pipeline relies on Chrome + CDP + schtasks)
- Node.js 18+
- Python 3.12 x64
- Microsoft VC++ 2015–2022 Redistributable (x64) — needed by `greenlet` for the Playwright stack
- Google Chrome (at `C:\Program Files\Google\Chrome\Application\chrome.exe`)
- Notion integration with **Insert content** permission on the target database
- ChatGPT and Gemini accounts (1+ each; more = automatic rotation on rate-limit)

---

## License

MIT.
