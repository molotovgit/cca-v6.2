// =============================================================================
//  WORKSPACE HEALTH CHECK — pre-run readiness probe.
// -----------------------------------------------------------------------------
//  Surfaces setup problems BEFORE the pipeline starts a 60–90-min chapter run,
//  instead of failing mid-stage. Checks credentials, data dirs, deps, prompt
//  files, and (advisory) the two Chrome CDP ports.
//
//  Design: all logic lives in the PURE, exported `checkWorkspace(deps)`. Every
//  side-effect (fs, env, CDP probe) is injected via `deps` so the function is
//  fully testable without touching the real system. The defaults wire in real
//  fs / process.env / HTTP probes.
//
//  USAGE:
//    node src/node/setup/verify_workspace.cjs
//  Exit code: 0 when all REQUIRED checks pass; 1 otherwise. CDP/port checks are
//  advisory (non-required) and never flip the exit code.
// =============================================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.resolve(__dirname, '../../..');

// Env keys that must be present AND non-empty in .env for a credentialed run.
// NOTE: NOTION_API_KEY is the only hard requirement here; ChatGPT/Gemini creds
// can come from data/accounts.json instead (checked separately below).
const REQUIRED_ENV_KEYS = ['NOTION_API_KEY'];

// A value is a "placeholder" (treated as empty) if it's blank or looks like the
// shipped template stand-ins.
function isPlaceholder(value) {
  if (value == null) return true;
  const v = String(value).trim().replace(/^["']|["']$/g, '');
  if (v === '') return true;
  if (v.startsWith('your-')) return true;
  if (v.includes('example.com')) return true;
  if (v === 'paste your notion link here') return true;
  return false;
}

// ─── default (real) dependency implementations ──────────────────────────────

// Resolve a repo-relative path and assert it stays inside REPO. The callers
// below pass only hard-coded internal paths (never external/user input), but
// this guard makes that invariant explicit and defeats path-traversal.
function safeRepoPath(relPath) {
  const resolved = path.resolve(REPO, relPath);
  if (resolved !== REPO && !resolved.startsWith(REPO + path.sep)) {
    throw new Error(`refusing path outside repo: ${relPath}`);
  }
  return resolved;
}

function defaultFileExists(relPath) {
  return fs.existsSync(safeRepoPath(relPath));
}

function defaultIsDir(relPath) {
  try {
    return fs.statSync(safeRepoPath(relPath)).isDirectory();
  } catch (_) {
    return false;
  }
}

// Parse a .env file into a flat object. Returns {} when the file is absent.
function defaultReadEnv() {
  const p = safeRepoPath('.env');
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null; // signal: .env file missing
  }
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    val = val.replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

function defaultReadJson(relPath) {
  try {
    return JSON.parse(fs.readFileSync(safeRepoPath(relPath), 'utf8'));
  } catch (_) {
    return null;
  }
}

// List files (non-recursive) under a repo-relative dir. Returns [] on error.
function defaultListDir(relPath) {
  try {
    return fs.readdirSync(safeRepoPath(relPath));
  } catch (_) {
    return [];
  }
}

// Best-effort CDP reachability probe against 127.0.0.1:<port>/json/version.
function defaultPortReachable(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/json/version', timeout: 1500 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(!!JSON.parse(data).Browser);
          } catch (_) {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ─── schema validation for accounts.json ────────────────────────────────────

// Returns { ok, usable, detail }. `usable` = at least one non-placeholder
// entry exists across chatgpt/gemini. Mirrors src/python/auth/accounts.py.
function validateAccounts(accounts) {
  if (accounts == null || typeof accounts !== 'object') {
    return { ok: false, usable: false, detail: 'accounts.json missing or not an object' };
  }
  let usable = 0;
  for (const provider of ['chatgpt', 'gemini']) {
    const list = accounts[provider];
    if (list === undefined) continue; // provider key optional
    if (!Array.isArray(list)) {
      return { ok: false, usable: false, detail: `'${provider}' must be an array` };
    }
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') {
        return { ok: false, usable: false, detail: `'${provider}' has a non-object entry` };
      }
      for (const field of ['label', 'email', 'password']) {
        if (!(field in entry)) {
          return { ok: false, usable: false, detail: `'${provider}' entry missing '${field}'` };
        }
      }
      if (!isPlaceholder(entry.email) && !isPlaceholder(entry.password)) usable += 1;
    }
  }
  return { ok: true, usable: usable > 0, detail: `${usable} usable account(s)` };
}

// ─── the pure check ──────────────────────────────────────────────────────────

/**
 * Run all workspace readiness checks.
 * @param {object} [deps] - injectable I/O. All optional; default to real probes.
 * @param {(rel:string)=>boolean} [deps.fileExists]
 * @param {(rel:string)=>boolean} [deps.isDir]
 * @param {()=>object|null} [deps.readEnv]   - parsed .env, or null if absent
 * @param {(rel:string)=>any} [deps.readJson]
 * @param {(rel:string)=>string[]} [deps.listDir]
 * @param {(port:number)=>Promise<boolean>} [deps.portReachable]
 * @param {{cdp:number,gemini:number}} [deps.ports]
 * @returns {Promise<{ok:boolean, checks:Array<{name,ok,required,detail}>}>}
 */
async function checkWorkspace(deps = {}) {
  const fileExists    = deps.fileExists    || defaultFileExists;
  const isDir         = deps.isDir         || defaultIsDir;
  const readEnv       = deps.readEnv       || defaultReadEnv;
  const readJson      = deps.readJson      || defaultReadJson;
  const listDir       = deps.listDir       || defaultListDir;
  const portReachable = deps.portReachable || defaultPortReachable;
  const ports         = deps.ports         || { cdp: 9222, gemini: 9223 };

  const checks = [];

  // 1. .env present + required keys non-empty.
  const env = readEnv();
  if (env == null) {
    checks.push({
      name: '.env present',
      ok: false,
      required: true,
      detail: '.env not found — copy config/examples/.env.example to .env and fill it in',
    });
    // No env to inspect; record the key check as failed too.
    checks.push({
      name: '.env required keys',
      ok: false,
      required: true,
      detail: `cannot verify ${REQUIRED_ENV_KEYS.join(', ')} (no .env)`,
    });
  } else {
    checks.push({ name: '.env present', ok: true, required: true, detail: '.env found' });
    const missing = REQUIRED_ENV_KEYS.filter((k) => isPlaceholder(env[k]));
    checks.push({
      name: '.env required keys',
      ok: missing.length === 0,
      required: true,
      detail: missing.length === 0
        ? `${REQUIRED_ENV_KEYS.join(', ')} set`
        : `missing/placeholder: ${missing.join(', ')}`,
    });
  }

  // 2. Credentials: accounts.json schema-valid + usable, OR legacy .env creds.
  const accounts = readJson('data/accounts.json');
  const accountsResult = validateAccounts(accounts);
  const envHasChatgpt =
    env != null && !isPlaceholder(env.CHATGPT_EMAIL) && !isPlaceholder(env.CHATGPT_PASSWORD);
  const envHasGemini =
    env != null && !isPlaceholder(env.GEMINI_EMAIL) && !isPlaceholder(env.GEMINI_PASSWORD);
  const legacyCreds = envHasChatgpt || envHasGemini;

  if (accounts == null) {
    // No accounts.json — fall back to legacy .env creds.
    checks.push({
      name: 'browser credentials',
      ok: legacyCreds,
      required: true,
      detail: legacyCreds
        ? 'data/accounts.json absent; using legacy .env CHATGPT_*/GEMINI_* creds'
        : 'no data/accounts.json and no legacy .env CHATGPT_*/GEMINI_* creds',
    });
  } else if (!accountsResult.ok) {
    checks.push({
      name: 'browser credentials',
      ok: false,
      required: true,
      detail: `data/accounts.json invalid: ${accountsResult.detail}`,
    });
  } else {
    const ok = accountsResult.usable || legacyCreds;
    checks.push({
      name: 'browser credentials',
      ok,
      required: true,
      detail: ok
        ? `data/accounts.json valid (${accountsResult.detail})`
        : `data/accounts.json valid but no usable creds (${accountsResult.detail}) and no legacy .env creds`,
    });
  }

  // 3. data/ and data/.cca/ directories.
  checks.push({
    name: 'data/ dir',
    ok: isDir('data'),
    required: true,
    detail: isDir('data') ? 'data/ exists' : 'data/ missing',
  });
  checks.push({
    name: 'data/.cca/ dir',
    ok: isDir(path.join('data', '.cca')),
    required: true,
    detail: isDir(path.join('data', '.cca')) ? 'data/.cca/ exists' : 'data/.cca/ missing',
  });

  // 4. puppeteer installed.
  const puppeteerOk = isDir(path.join('node_modules', 'puppeteer'));
  checks.push({
    name: 'node_modules/puppeteer',
    ok: puppeteerOk,
    required: true,
    detail: puppeteerOk ? 'puppeteer installed' : 'puppeteer missing — run `npm install`',
  });

  // 5. prompt templates present under config/prompts/.
  const promptFiles = listDir('config/prompts').filter((f) => !f.startsWith('.'));
  checks.push({
    name: 'config/prompts/*',
    ok: promptFiles.length > 0,
    required: true,
    detail: promptFiles.length > 0
      ? `${promptFiles.length} prompt file(s)`
      : 'config/prompts/ empty or missing',
  });

  // 6. CDP ports — ADVISORY (non-required; never flips overall ok).
  const [cdpUp, geminiUp] = await Promise.all([
    Promise.resolve(portReachable(ports.cdp)),
    Promise.resolve(portReachable(ports.gemini)),
  ]);
  checks.push({
    name: `CDP :${ports.cdp} (ChatGPT)`,
    ok: cdpUp,
    required: false,
    detail: cdpUp ? 'reachable' : 'down — run setup_chrome.cjs (advisory)',
  });
  checks.push({
    name: `CDP :${ports.gemini} (Gemini)`,
    ok: geminiUp,
    required: false,
    detail: geminiUp ? 'reachable' : 'down — run setup_chrome.cjs (advisory)',
  });

  // Overall ok = every REQUIRED check passes.
  const ok = checks.every((c) => !c.required || c.ok);
  return { ok, checks };
}

// ─── thin CLI wrapper ─────────────────────────────────────────────────────────

function renderTable(result) {
  const rows = result.checks.map((c) => {
    const mark = c.ok ? 'PASS' : c.required ? 'FAIL' : 'WARN';
    const tag = c.required ? 'required' : 'advisory';
    return `  [${mark}] ${c.name.padEnd(28)} (${tag})  ${c.detail}`;
  });
  return rows.join('\n');
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  WORKSPACE HEALTH CHECK');
  console.log('═══════════════════════════════════════════════════════════════');
  const result = await checkWorkspace();
  console.log(renderTable(result));
  console.log('───────────────────────────────────────────────────────────────');
  console.log(result.ok
    ? '  RESULT: ready — all required checks passed.'
    : '  RESULT: NOT ready — fix the FAIL items above.');
  console.log('  (WARN = advisory; does not block the run.)');
  console.log('═══════════════════════════════════════════════════════════════');
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('verify_workspace: unexpected error:', err);
    process.exit(1);
  });
}

module.exports = {
  checkWorkspace,
  validateAccounts,
  isPlaceholder,
  renderTable,
  REQUIRED_ENV_KEYS,
};
