# Repository Guidelines

## Project Structure & Module Organization

This repo automates an education content pipeline: Notion chapters become refined text, prompts, images, and Flow/Gemini video assets. Node code lives under `src/node/`, with `orchestrators/` for run entry points, `workers/` for browser automation, `video/` for Flow/video state helpers, `dashboard/` for local status UI, and `setup/` for Chrome CDP setup. Python code lives under `src/python/`, split into `pipeline/`, `drivers/`, `infra/`, `auth/`, and `utils/`. Tests live in `tests/` and beside Node modules as `*.test.cjs`. Runtime assets and generated content live under `data/` and are gitignored.

## Build, Test, and Development Commands

- `npm install`: install Node dependencies, including Puppeteer.
- `node --test src/node/video/*.test.cjs src/node/workers/*.test.cjs`: run focused Node tests.
- `node --test tests/node/*.test.cjs`: run Node tests stored under `tests/`.
- `pytest tests/python`: run Python unit tests.
- `GEMINI_CDP_PORT=9223 node src/node/workers/submit_flow_videos.cjs <prompts.json> --limit 1 --max-in-flight 1`: run a one-clip Flow smoke test against an already signed-in Chrome.
- `node src/node/orchestrators/run_videos_autonomous.cjs <prompts.json> --limit <N>`: run sequential Flow video orchestration.

## Coding Style & Naming Conventions

Use CommonJS for Node files (`*.cjs`) and snake_case for Python modules. Keep Node helpers small and exported for tests. Prefer two-space indentation in JavaScript and four-space indentation in Python. Use clear state names such as `failed_ui`, `blocked_quota`, and `saved`. Do not commit generated `data/` artifacts, browser profiles, `.env`, or account files.

## Testing Guidelines

Node tests use the built-in `node:test` module with `node:assert/strict`. Name tests `*.test.cjs` and keep browser-dependent behavior injectable so unit tests do not require live Chrome. Python tests use `pytest` and should avoid real Notion, Google, or browser sessions unless explicitly marked as manual smoke work.

## Commit & Pull Request Guidelines

History uses concise Conventional Commit-style messages, for example `feat: harden Flow live smoke path` and `docs: correct Flow live smoke outcome`. Keep commits scoped and include docs/memory updates when behavior or project status changes. Pull requests should describe the pipeline stage touched, commands run, live-smoke evidence if relevant, and any remaining operational risks.

## Security & Agent Notes

Never automate Google login, 2FA, or CAPTCHA. Use existing signed-in Chrome CDP sessions. Preserve user/runtime artifacts such as Obsidian state, `cca_v4.zip`, `agentdb.rvf`, and ignored `data/` evidence unless explicitly told to clean them.
