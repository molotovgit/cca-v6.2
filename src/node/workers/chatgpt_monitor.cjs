// =============================================================================
//  CCA v6 — ChatGPT Account Spinner / Blocker Monitor
// =============================================================================
//  Long-running watcher that polls the ChatGPT Chrome (CDP port 9222) for
//  account-level blocker conditions and records them to .cca/chatgpt_alerts.json.
//  The pipeline orchestrator (run_pipeline.cjs) reads those alerts to decide
//  whether to rotate to the next ChatGPT account in accounts.json BEFORE the
//  next REFINE/PROMPTS stage — mirroring the proactive rotation pattern that
//  save_images.cjs + run_autonomous.cjs already implement for Gemini.
//
//  Alert schema (parallel to .cca/blocker_alerts.json):
//      { t: <ms epoch>, idx: <tab targetId>, slug: <url path>, type: <kind> }
//
//  Detected kinds (most → least severe):
//      quota          — "Reached your free message limit / Upgrade to ChatGPT Plus"
//      rate_limit     — "You've sent too many messages / Please try again later"
//      capacity       — "ChatGPT is at capacity right now"
//      session_expired— redirected to /auth/login, body says "Log in"
//      error_5xx      — generic "Something went wrong" / 5xx response
//
//  Usage:
//      node src/node/workers/chatgpt_monitor.cjs --watch
//      node src/node/workers/chatgpt_monitor.cjs --once          (one-shot, for tests)
//      node src/node/workers/chatgpt_monitor.cjs --simulate quota (inject fake alert)
//
//  Env:
//      CDP_PORT (default 9222)
//      CCA_CHATGPT_POLL_MS (default 7000) — interval between full scans
// =============================================================================

'use strict';
// puppeteer is lazy-loaded inside runWatch/runOnce so --simulate works in
// environments where npm install hasn't run yet.
const path = require('path');
const fs   = require('fs');

const CDP_PORT   = parseInt(process.env.CDP_PORT || '9222', 10);
const POLL_MS    = parseInt(process.env.CCA_CHATGPT_POLL_MS || '7000', 10);
const REPO       = path.resolve(__dirname, '..', '..', '..');
const STATE_DIR  = path.join(REPO, '.cca');
const ALERTS_FILE = path.join(STATE_DIR, 'chatgpt_alerts.json');
const MAX_ALERTS = 200;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function ts() { return new Date().toISOString().slice(11, 19); }
function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} if (e.code !== 'ENOENT') throw e; }
}

// ────────────────────────── Detection ───────────────────────────────────────
//
// detectChatgptBlocker(page) -> string|null
//
// Returns one of the kinds listed in the file header, or null if the page
// looks healthy. Tolerant of:
//   - non-English UI (matches English + Russian + Uzbek where known)
//   - DOM not yet hydrated (returns null on transient evaluate failures)
//   - chat tabs vs auth pages (URL-aware)
async function detectChatgptBlocker(page) {
  try {
    const url = page.url() || '';

    // 1. Session expired → redirected to login
    if (/\/auth\/login|\/login(\?|$)/.test(url)) return 'session_expired';

    // 2. Tab is not on chatgpt.com at all — not ours to judge
    if (!/chatgpt\.com/.test(url)) return null;

    let title = '';
    try { title = (await page.title()) || ''; } catch (_) {}

    let body = '';
    try {
      body = (await page.evaluate(
        () => ((document.body && document.body.innerText) || '').slice(0, 3000)
      )) || '';
    } catch (_) { return null; }

    // Combine for matching but keep separate for debugging
    const t = title.toLowerCase();
    const b = body.toLowerCase();

    // 3. Quota / message limit (account-level, requires switching accounts)
    if (
      /you'?ve reached the (free )?(message|gpt-4) limit/.test(b) ||
      /upgrade to chatgpt plus/.test(b) ||
      /reached your (free )?limit/.test(b) ||
      /you'?ve sent too many messages today/.test(b)
    ) return 'quota';

    // 4. Rate limit (transient, but if persistent across attempts -> rotate)
    if (
      /too many requests/.test(b) ||
      /rate.?limit/.test(b) ||
      /please (wait|try again) in \d+ (minute|second)/.test(b) ||
      /you'?re sending messages too fast/.test(b)
    ) return 'rate_limit';

    // 5. Server capacity (global, not account-level — but still blocks us)
    if (
      /chatgpt is at capacity right now/.test(b) ||
      /we'?re at capacity/.test(b)
    ) return 'capacity';

    // 6. Generic server error
    if (
      /something went wrong\. (please )?(try again|reload)/.test(b) ||
      /the server (had|encountered) an error/.test(b)
    ) return 'error_5xx';

    return null;
  } catch (_) { return null; }
}

// ────────────────────────── Alert recording ─────────────────────────────────
function recordAlert(idx, slug, type) {
  let alerts = readJsonOr(ALERTS_FILE, []);
  if (!Array.isArray(alerts)) alerts = [];
  alerts.push({ t: Date.now(), idx, slug, type });
  if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
  writeJson(ALERTS_FILE, alerts);
}

// Returns true if this (idx, type) tuple was already logged within the
// debounce window. Prevents flooding when the banner sits on the page.
function recentlySeen(idx, type, windowMs = 60_000) {
  const alerts = readJsonOr(ALERTS_FILE, []);
  if (!Array.isArray(alerts)) return false;
  const now = Date.now();
  return alerts.some(a => a.idx === idx && a.type === type && (now - a.t) < windowMs);
}

// ────────────────────────── Main poll loop ──────────────────────────────────
async function scanOnce(browser) {
  let scanned = 0, flagged = 0;
  for (const ctx of browser.browserContexts()) {
    for (const page of await ctx.pages()) {
      scanned++;
      const url = page.url() || '';
      if (!/chatgpt\.com|\/auth\/login/.test(url) && !/openai\.com/.test(url)) continue;
      const type = await detectChatgptBlocker(page);
      if (type) {
        let idx = 'unknown';
        try { idx = page.target()._targetId || 'unknown'; } catch (_) {}
        const slug = (() => { try { return new URL(url).pathname; } catch (_) { return url; } })();
        if (!recentlySeen(idx, type)) {
          recordAlert(idx, slug, type);
          console.log(`${ts()} [chatgpt-mon] ALERT type=${type} tab=${String(idx).slice(0, 8)} slug=${slug}`);
          flagged++;
        }
      }
    }
  }
  return { scanned, flagged };
}

async function runWatch() {
  const puppeteer = require('puppeteer');
  console.log(`[chatgpt-mon] connecting to CDP on http://127.0.0.1:${CDP_PORT}`);
  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: null,
    });
  } catch (e) {
    console.error(`[chatgpt-mon] cannot connect to Chrome at :${CDP_PORT} — is setup_chrome.cjs running? (${e.message})`);
    process.exit(2);
  }

  console.log(`[chatgpt-mon] connected. polling every ${POLL_MS}ms. alerts -> ${ALERTS_FILE}`);
  process.on('SIGINT', async () => {
    console.log('\n[chatgpt-mon] SIGINT — disconnecting');
    try { browser.disconnect(); } catch (_) {}
    process.exit(0);
  });

  while (true) {
    try {
      const { scanned, flagged } = await scanOnce(browser);
      if (flagged > 0 || (Date.now() % (POLL_MS * 12) < POLL_MS)) {
        // log heartbeat ~1x/min
        console.log(`${ts()} [chatgpt-mon] scanned=${scanned} flagged=${flagged}`);
      }
    } catch (e) {
      console.error(`${ts()} [chatgpt-mon] scan error: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

async function runOnce() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null,
  }).catch(e => { console.error(`cannot connect: ${e.message}`); process.exit(2); });
  const { scanned, flagged } = await scanOnce(browser);
  console.log(`[chatgpt-mon] one-shot: scanned=${scanned} flagged=${flagged}`);
  browser.disconnect();
}

function simulate(kind) {
  const types = new Set(['quota', 'rate_limit', 'capacity', 'session_expired', 'error_5xx']);
  if (!types.has(kind)) {
    console.error(`unknown kind '${kind}'. one of: ${[...types].join(', ')}`); process.exit(1);
  }
  recordAlert(`sim-${Date.now()}`, '/simulated', kind);
  console.log(`[chatgpt-mon] simulated alert: ${kind} -> ${ALERTS_FILE}`);
}

// ────────────────────────── CLI ─────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--simulate')) {
    const i = args.indexOf('--simulate');
    return simulate(args[i + 1] || 'rate_limit');
  }
  if (args.includes('--once')) return runOnce();
  if (args.includes('--watch') || args.length === 0) return runWatch();
  console.error('usage: chatgpt_monitor.cjs [--watch|--once|--simulate <kind>]');
  process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
