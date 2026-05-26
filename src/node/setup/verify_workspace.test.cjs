// =============================================================================
//  Tests for the PURE checkWorkspace() — all I/O injected via fake `deps`.
//  Never touches the real filesystem, env, or network.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkWorkspace,
  validateAccounts,
  isPlaceholder,
} = require('./verify_workspace.cjs');

// ─── fixtures ─────────────────────────────────────────────────────────────────

const GOOD_ENV = {
  NOTION_API_KEY: 'ntn_realkeyvalue1234567890',
  CHATGPT_EMAIL: 'real@gmail.com',
  CHATGPT_PASSWORD: 'hunter2',
  GEMINI_EMAIL: 'real2@gmail.com',
  GEMINI_PASSWORD: 'hunter3',
  CDP_PORT: '9222',
  GEMINI_CDP_PORT: '9223',
};

const GOOD_ACCOUNTS = {
  chatgpt: [{ label: 'primary', email: 'real@gmail.com', password: 'hunter2' }],
  gemini: [{ label: 'primary', email: 'real2@gmail.com', password: 'hunter3' }],
};

const PROMPT_FILES = ['refine_prompt.txt', '80_prompt_formula.txt'];

// Build a deps object; overrides shallow-merge over an all-healthy baseline.
function makeDeps(overrides = {}) {
  const base = {
    fileExists: () => true,
    isDir: () => true,
    readEnv: () => ({ ...GOOD_ENV }),
    readJson: (rel) => (rel === 'data/accounts.json' ? GOOD_ACCOUNTS : null),
    listDir: () => [...PROMPT_FILES],
    portReachable: () => Promise.resolve(true),
    ports: { cdp: 9222, gemini: 9223 },
  };
  return { ...base, ...overrides };
}

// Find a check row by exact name.
function find(result, name) {
  return result.checks.find((c) => c.name === name);
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('all-good workspace → ok:true and every required check passes', async () => {
  const result = await checkWorkspace(makeDeps());
  assert.equal(result.ok, true);
  for (const c of result.checks) {
    if (c.required) assert.equal(c.ok, true, `required check failed: ${c.name} (${c.detail})`);
  }
  // Sanity: we produced the expected set of checks.
  assert.ok(result.checks.length >= 8, 'expected at least 8 checks');
});

test('missing .env → ok:false with a failing .env present check', async () => {
  const result = await checkWorkspace(makeDeps({ readEnv: () => null }));
  assert.equal(result.ok, false);
  const present = find(result, '.env present');
  assert.equal(present.ok, false);
  assert.equal(present.required, true);
  // The required-keys check should also fail when .env is absent.
  const keys = find(result, '.env required keys');
  assert.equal(keys.ok, false);
});

test('placeholder NOTION_API_KEY → failing required-keys check', async () => {
  const env = { ...GOOD_ENV, NOTION_API_KEY: '' };
  const result = await checkWorkspace(makeDeps({ readEnv: () => env }));
  assert.equal(result.ok, false);
  const keys = find(result, '.env required keys');
  assert.equal(keys.ok, false);
  assert.match(keys.detail, /NOTION_API_KEY/);
});

test('bad accounts schema (chatgpt not an array) → failing credentials check', async () => {
  const bad = { chatgpt: 'oops', gemini: [] };
  const result = await checkWorkspace(
    makeDeps({ readJson: (rel) => (rel === 'data/accounts.json' ? bad : null) })
  );
  assert.equal(result.ok, false);
  const creds = find(result, 'browser credentials');
  assert.equal(creds.ok, false);
  assert.match(creds.detail, /invalid/);
});

test('accounts entry missing a required field → failing credentials check', async () => {
  const bad = { chatgpt: [{ label: 'x', email: 'a@b.com' }] }; // no password
  const result = await checkWorkspace(
    makeDeps({ readJson: (rel) => (rel === 'data/accounts.json' ? bad : null) })
  );
  assert.equal(result.ok, false);
  const creds = find(result, 'browser credentials');
  assert.equal(creds.ok, false);
  assert.match(creds.detail, /password/);
});

test('no accounts.json but legacy .env creds present → credentials check passes', async () => {
  const result = await checkWorkspace(
    makeDeps({ readJson: () => null }) // no accounts.json; GOOD_ENV has legacy creds
  );
  const creds = find(result, 'browser credentials');
  assert.equal(creds.ok, true);
  assert.match(creds.detail, /legacy/);
  assert.equal(result.ok, true);
});

test('no accounts.json AND no legacy creds → failing credentials check', async () => {
  const env = {
    NOTION_API_KEY: 'ntn_realkeyvalue1234567890',
    CHATGPT_EMAIL: '',
    CHATGPT_PASSWORD: '',
    GEMINI_EMAIL: '',
    GEMINI_PASSWORD: '',
  };
  const result = await checkWorkspace(makeDeps({ readJson: () => null, readEnv: () => env }));
  assert.equal(result.ok, false);
  const creds = find(result, 'browser credentials');
  assert.equal(creds.ok, false);
});

test('placeholder accounts (your-/example.com) are not usable; falls back to legacy', async () => {
  const placeholderAccounts = {
    chatgpt: [{ label: 'primary', email: 'your-chatgpt@example.com', password: 'your-password' }],
    gemini: [{ label: 'primary', email: 'your-g@example.com', password: 'your-password-1' }],
  };
  // Legacy .env creds still good → overall ok, schema valid but 0 usable.
  const result = await checkWorkspace(
    makeDeps({ readJson: (rel) => (rel === 'data/accounts.json' ? placeholderAccounts : null) })
  );
  const creds = find(result, 'browser credentials');
  assert.equal(creds.ok, true); // legacy fallback
  assert.match(creds.detail, /0 usable account/);
});

test('missing puppeteer → failing dependency check', async () => {
  const result = await checkWorkspace(
    makeDeps({ isDir: (rel) => rel !== 'node_modules/puppeteer' })
  );
  assert.equal(result.ok, false);
  const dep = find(result, 'node_modules/puppeteer');
  assert.equal(dep.ok, false);
  assert.equal(dep.required, true);
});

test('missing data/ and data/.cca/ dirs → failing required dir checks', async () => {
  const result = await checkWorkspace(makeDeps({ isDir: () => false }));
  assert.equal(result.ok, false);
  assert.equal(find(result, 'data/ dir').ok, false);
  assert.equal(find(result, 'data/.cca/ dir').ok, false);
});

test('no prompt files → failing config/prompts check', async () => {
  const result = await checkWorkspace(makeDeps({ listDir: () => [] }));
  assert.equal(result.ok, false);
  const prompts = find(result, 'config/prompts/*');
  assert.equal(prompts.ok, false);
});

test('CDP ports down → advisory only; does NOT flip ok when rest is healthy', async () => {
  const result = await checkWorkspace(makeDeps({ portReachable: () => Promise.resolve(false) }));
  assert.equal(result.ok, true, 'advisory port checks must not fail the overall result');
  const cdp = find(result, 'CDP :9222 (ChatGPT)');
  const gem = find(result, 'CDP :9223 (Gemini)');
  assert.equal(cdp.ok, false);
  assert.equal(cdp.required, false);
  assert.equal(gem.ok, false);
  assert.equal(gem.required, false);
});

test('custom ports are honored and probed', async () => {
  const probed = [];
  const result = await checkWorkspace(
    makeDeps({
      ports: { cdp: 9000, gemini: 9001 },
      portReachable: (p) => {
        probed.push(p);
        return Promise.resolve(true);
      },
    })
  );
  assert.deepEqual(probed.sort(), [9000, 9001]);
  assert.ok(find(result, 'CDP :9000 (ChatGPT)'));
  assert.ok(find(result, 'CDP :9001 (Gemini)'));
});

// ─── unit tests for the helper exports ────────────────────────────────────────

test('validateAccounts: valid schema with usable creds', () => {
  const r = validateAccounts(GOOD_ACCOUNTS);
  assert.equal(r.ok, true);
  assert.equal(r.usable, true);
});

test('validateAccounts: non-object input is invalid', () => {
  assert.equal(validateAccounts(null).ok, false);
  assert.equal(validateAccounts('nope').ok, false);
});

test('validateAccounts: provider key may be omitted entirely', () => {
  const r = validateAccounts({ chatgpt: [{ label: 'x', email: 'a@b.com', password: 'p' }] });
  assert.equal(r.ok, true);
  assert.equal(r.usable, true);
});

test('isPlaceholder recognizes blanks and template stand-ins', () => {
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder(null), true);
  assert.equal(isPlaceholder('   '), true);
  assert.equal(isPlaceholder('your-password'), true);
  assert.equal(isPlaceholder('a@example.com'), true);
  assert.equal(isPlaceholder('paste your notion link here'), true);
  assert.equal(isPlaceholder('ntn_realkey'), false);
  assert.equal(isPlaceholder('"ntn_quoted"'), false);
});
