'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeVideoForDashboard } = require('./video_dashboard.cjs');

function fixtureState() {
  return {
    updatedAt: '2026-05-26T12:00:00.000Z',
    items: {
      1: { idx: 1, slug: 'intro', state: 'saved', attempts: 1 },
      2: { idx: 2, slug: 'cell-biology', state: 'saved', attempts: 1 },
      3: {
        idx: 3,
        slug: 'photosynthesis',
        state: 'blocked_quota',
        attempts: 2,
        lastError: 'Daily quota exhausted on this account',
        lastScreenshot: 'data/.cca/video_shots/ch03-quota.png',
      },
      4: { idx: 4, slug: 'respiration', state: 'failed_ui', attempts: 3, lastError: 'Submit button never enabled' },
      5: { idx: 5, slug: 'genetics', state: 'rendering', attempts: 1 },
    },
  };
}

test('summarizeVideoForDashboard: mixed states → compact summary', () => {
  const out = summarizeVideoForDashboard(fixtureState());
  assert.ok(out, 'should return an object for valid state');

  assert.equal(out.savedCount, 2);
  assert.equal(out.totalCount, 5);

  assert.deepEqual(out.counts, {
    saved: 2,
    blocked_quota: 1,
    failed_ui: 1,
    rendering: 1,
  });

  assert.equal(out.active, 1, 'rendering counts as active');
  assert.equal(out.blocked, 1, 'one blocked_quota');
  // With the default maxAttempts (Infinity), failed_ui is still RETRYABLE.
  // Only the blocked item lands in the failed bucket (blocked ⊂ failed).
  assert.equal(out.failed, 1, 'blocked_quota lands in failed bucket; failed_ui is still retryable');
  assert.equal(out.retryable, 1, 'failed_ui is retryable until attempts exhaust maxAttempts');

  assert.equal(out.updatedAt, '2026-05-26T12:00:00.000Z');
});

test('summarizeVideoForDashboard: finite maxAttempts exhausts retries into failed bucket', () => {
  const state = {
    items: {
      1: { idx: 1, slug: 'a', state: 'failed_ui', attempts: 3, lastError: 'ui dead' },
      2: { idx: 2, slug: 'b', state: 'pending', attempts: 0 },
    },
  };
  const out = summarizeVideoForDashboard(state, { maxAttempts: 3 });
  assert.equal(out.failed, 1, 'exhausted failed_ui becomes terminal failure');
  assert.equal(out.retryable, 1, 'pending is still retryable');
  assert.ok(out.lastBlocker);
  assert.equal(out.lastBlocker.idx, 1);
  assert.equal(out.lastBlocker.lastError, 'ui dead');
});

test('summarizeVideoForDashboard: lastBlocker/lastScreenshot prefer item with a screenshot', () => {
  const out = summarizeVideoForDashboard(fixtureState());
  assert.ok(out.lastBlocker, 'lastBlocker present');
  // idx 3 (blocked_quota) has the screenshot; idx 4 (failed_ui) is higher idx
  // but has no screenshot → screenshot-bearing item wins.
  assert.equal(out.lastBlocker.idx, 3);
  assert.equal(out.lastBlocker.state, 'blocked_quota');
  assert.equal(out.lastBlocker.lastError, 'Daily quota exhausted on this account');
  assert.equal(out.lastScreenshot, 'data/.cca/video_shots/ch03-quota.png');
});

test('summarizeVideoForDashboard: highest idx wins when no item has a screenshot', () => {
  const state = {
    items: {
      1: { idx: 1, slug: 'a', state: 'failed_ui', attempts: 3, lastError: 'first failure' },
      2: { idx: 2, slug: 'b', state: 'failed_download', attempts: 3, lastError: 'second failure' },
    },
  };
  const out = summarizeVideoForDashboard(state, { maxAttempts: 3 });
  assert.ok(out.lastBlocker);
  assert.equal(out.lastBlocker.idx, 2, 'highest idx wins without screenshots');
  assert.equal(out.lastBlocker.lastError, 'second failure');
  assert.equal(out.lastScreenshot, null);
});

test('summarizeVideoForDashboard: all saved → no blocker, null screenshot', () => {
  const state = {
    items: {
      1: { idx: 1, slug: 'a', state: 'saved' },
      2: { idx: 2, slug: 'b', state: 'saved' },
    },
  };
  const out = summarizeVideoForDashboard(state);
  assert.equal(out.savedCount, 2);
  assert.equal(out.totalCount, 2);
  assert.equal(out.blocked, 0);
  assert.equal(out.failed, 0);
  assert.equal(out.lastBlocker, null);
  assert.equal(out.lastScreenshot, null);
  assert.equal(out.updatedAt, null, 'no updatedAt field → null');
});

test('summarizeVideoForDashboard: null / empty / malformed → null without throwing', () => {
  assert.equal(summarizeVideoForDashboard(null), null);
  assert.equal(summarizeVideoForDashboard(undefined), null);
  assert.equal(summarizeVideoForDashboard({}), null, 'no items → null');
  assert.equal(summarizeVideoForDashboard({ items: {} }), null, 'empty items → null');
  assert.equal(summarizeVideoForDashboard(42), null);
  assert.equal(summarizeVideoForDashboard('nope'), null);
  assert.equal(summarizeVideoForDashboard([]), null, 'empty array → null');
  // Malformed item shapes should not throw.
  assert.doesNotThrow(() => summarizeVideoForDashboard({ items: { 1: null, 2: 'x', 3: 7 } }));
  assert.doesNotThrow(() => summarizeVideoForDashboard({ items: [null, undefined, {}] }));
});

test('summarizeVideoForDashboard: opts is defensive against bad input', () => {
  const out = summarizeVideoForDashboard(fixtureState(), null);
  assert.ok(out, 'null opts is tolerated');
  assert.equal(out.totalCount, 5);
});
