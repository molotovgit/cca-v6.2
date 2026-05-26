'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { formatEvent, appendEvent, rotationStateSnapshot } = require('./diag_events.cjs');

const ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

test('formatEvent: stamps type + ISO timestamp and carries supplied fields', () => {
  const ev = formatEvent({ type: 'rotate', provider: 'gemini', accountLabel: 'acct-2', exitCode: 0 });
  assert.strictEqual(ev.type, 'rotate');
  assert.match(ev.timestamp, ISO_RX);
  assert.strictEqual(ev.provider, 'gemini');
  assert.strictEqual(ev.accountLabel, 'acct-2');
  assert.strictEqual(ev.exitCode, 0);
});

test('formatEvent: defaults type to "unknown" and omits absent optional fields', () => {
  const ev = formatEvent({});
  assert.strictEqual(ev.type, 'unknown');
  assert.match(ev.timestamp, ISO_RX);
  assert.ok(!('provider' in ev));
  assert.ok(!('reason' in ev));
});

test('formatEvent: trims stderrExcerpt to a bounded length', () => {
  const ev = formatEvent({ type: 'login', stderrExcerpt: 'x'.repeat(2000) });
  assert.ok(ev.stderrExcerpt.length <= 500);
});

test('formatEvent: keeps exitCode 0 (does not drop falsy-but-meaningful values)', () => {
  const ev = formatEvent({ type: 'login', exitCode: 0, resumedImageIndex: 0 });
  assert.strictEqual(ev.exitCode, 0);
  assert.strictEqual(ev.resumedImageIndex, 0);
});

test('appendEvent: writes valid JSONL via injected fs and returns true', () => {
  const writes = [];
  const mkdirs = [];
  const fakeFs = {
    mkdirSync: (dir, opts) => { mkdirs.push({ dir, opts }); },
    appendFileSync: (file, data) => { writes.push({ file, data }); },
  };
  const ev = formatEvent({ type: 'rotation_complete', provider: 'gemini' });
  const ok = appendEvent('/tmp/cca/rotation_events.jsonl', ev, { fs: fakeFs });

  assert.strictEqual(ok, true);
  assert.strictEqual(mkdirs.length, 1);
  assert.deepStrictEqual(mkdirs[0].opts, { recursive: true });
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].file, '/tmp/cca/rotation_events.jsonl');
  // valid JSONL: exactly one trailing newline, parseable body
  assert.ok(writes[0].data.endsWith('\n'));
  const parsed = JSON.parse(writes[0].data.trim());
  assert.strictEqual(parsed.type, 'rotation_complete');
  assert.strictEqual(parsed.provider, 'gemini');
});

test('appendEvent: returns false (does NOT throw) when the injected fs write fails', () => {
  const fakeFs = {
    mkdirSync: () => {},
    appendFileSync: () => { throw new Error('ENOSPC: simulated disk full'); },
  };
  let result;
  assert.doesNotThrow(() => {
    result = appendEvent('/tmp/cca/rotation_events.jsonl', formatEvent({ type: 'rotate' }), { fs: fakeFs });
  });
  assert.strictEqual(result, false);
});

test('appendEvent: returns false (does NOT throw) when mkdir fails', () => {
  const fakeFs = {
    mkdirSync: () => { throw new Error('EACCES: simulated permission denied'); },
    appendFileSync: () => { throw new Error('should not reach here'); },
  };
  let result;
  assert.doesNotThrow(() => {
    result = appendEvent('/tmp/cca/x.jsonl', formatEvent({ type: 'blocker' }), { fs: fakeFs });
  });
  assert.strictEqual(result, false);
});

test('appendEvent: returns false on empty filePath without throwing', () => {
  const fakeFs = { mkdirSync: () => {}, appendFileSync: () => {} };
  assert.strictEqual(appendEvent('', formatEvent({ type: 'rotate' }), { fs: fakeFs }), false);
});

test('rotationStateSnapshot: produces the expected shape with ISO timestamp', () => {
  const snap = rotationStateSnapshot({
    provider: 'gemini',
    accountLabel: 'acct-3',
    accountIndex: 2,
    accountEmail: 'a@b.com',
    rotationCount: 4,
    resumedImageIndex: 17,
    total: 40,
    reason: 'silent-blocker',
  });
  assert.match(snap.timestamp, ISO_RX);
  assert.strictEqual(snap.provider, 'gemini');
  assert.strictEqual(snap.accountLabel, 'acct-3');
  assert.strictEqual(snap.accountIndex, 2);
  assert.strictEqual(snap.accountEmail, 'a@b.com');
  assert.strictEqual(snap.rotationCount, 4);
  assert.strictEqual(snap.resumedImageIndex, 17);
  assert.strictEqual(snap.total, 40);
  assert.strictEqual(snap.reason, 'silent-blocker');
});

test('rotationStateSnapshot: defaults missing fields to null (stable shape)', () => {
  const snap = rotationStateSnapshot({});
  assert.match(snap.timestamp, ISO_RX);
  for (const k of ['provider', 'accountLabel', 'accountIndex', 'accountEmail',
    'rotationCount', 'resumedImageIndex', 'total', 'reason']) {
    assert.strictEqual(snap[k], null, `${k} should default to null`);
  }
});
