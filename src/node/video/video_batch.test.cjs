'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EXIT_CODES } = require('./video_errors.cjs');
const {
  buildProgressSnapshot,
  capRetryableItem,
  detectNoProgress,
  determineAggregateExitCode,
  progressSignature,
  selectNextRetryableItems,
  summarizeVideoItems,
  summarizeVideoState,
} = require('./video_batch.cjs');

function makeState(items) {
  return { items };
}

test('summarizeVideoState splits complete, retryable, blocked, and missing source items', () => {
  const state = makeState({
    9: { idx: 9, state: 'saved' },
    1: { idx: 1, state: 'pending', attempts: 0 },
    4: { idx: 4, state: 'failed_timeout', attempts: 1 },
    6: { idx: 6, state: 'blocked_quota', attempts: 0 },
    7: { idx: 7, state: 'blocked_subscription', attempts: 0 },
    8: { idx: 8, state: 'blocked_policy', attempts: 0 },
    2: { idx: 2, state: 'failed_missing_asset', attempts: 0 },
    3: { idx: 3, state: 'failed_download', attempts: 0 },
  });

  const summary = summarizeVideoState(state);

  assert.equal(summary.savedCount, 1);
  assert.equal(summary.retryableCount, 3);
  assert.equal(summary.blockedCount, 3);
  assert.equal(summary.missingSourceCount, 1);
  assert.deepEqual(summary.completeItems.map(item => item.idx), [9]);
  assert.deepEqual(summary.retryableItems.map(item => item.idx), [1, 3, 4]);
  assert.deepEqual(summary.blockedItems.map(item => item.idx), [6, 7, 8]);
  assert.deepEqual(summary.missingSourceItems.map(item => item.idx), [2]);
  assert.deepEqual(summary.failedItems.map(item => item.idx), [2, 6, 7, 8]);
});

test('capRetryableItem converts exhausted retries to terminal states', () => {
  const timeoutItem = capRetryableItem({ idx: 1, state: 'failed_timeout', attempts: 2 }, 2);
  const uiItem = capRetryableItem({ idx: 2, state: 'failed_ui', attempts: 3 }, 3);
  const downloadItem = capRetryableItem({ idx: 3, state: 'failed_download', attempts: 1 }, 1);
  const stillRetryable = capRetryableItem({ idx: 4, state: 'pending', attempts: 0 }, 2);

  assert.equal(timeoutItem.state, 'failed_timeout');
  assert.equal(timeoutItem.retryExhausted, true);
  assert.equal(uiItem.state, 'failed_ui');
  assert.equal(uiItem.retryExhausted, true);
  assert.equal(downloadItem.state, 'failed_ui');
  assert.equal(downloadItem.retryExhausted, true);
  assert.equal(stillRetryable.state, 'pending');
  assert.equal(stillRetryable.retryExhausted, undefined);
});

test('selectNextRetryableItems returns the next retryable items sorted by idx and skips capped items', () => {
  const state = makeState({
    8: { idx: 8, state: 'failed_ui', attempts: 0 },
    2: { idx: 2, state: 'pending', attempts: 0 },
    5: { idx: 5, state: 'failed_timeout', attempts: 3 },
    1: { idx: 1, state: 'saved', attempts: 0 },
    4: { idx: 4, state: 'failed_download', attempts: 1 },
    7: { idx: 7, state: 'blocked_quota', attempts: 0 },
  });

  const selection = selectNextRetryableItems(state, { limit: 2, maxAttempts: 2 });

  assert.deepEqual(selection.selected.map(item => item.idx), [2, 4]);
  assert.deepEqual(selection.retryableItems.map(item => item.idx), [2, 4, 8]);
  assert.deepEqual(selection.exhaustedItems.map(item => item.idx), [5]);
  assert.equal(selection.nextItem.idx, 2);
});

test('progress snapshot and signature reflect saved progress', () => {
  const summary = summarizeVideoItems(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'pending' },
  }));

  const snapshot = buildProgressSnapshot(summary);

  assert.deepEqual(snapshot.savedIdxs, [1]);
  assert.equal(progressSignature(snapshot), summary.progressSignature);
  assert.equal(detectNoProgress([
    { ...snapshot, savedCount: 0 },
    { ...snapshot, savedCount: 0 },
    { ...snapshot, savedCount: 0 },
  ], 3), true);
  assert.equal(detectNoProgress([
    { ...snapshot, savedCount: 0 },
    { ...snapshot, savedCount: 0 },
    { ...snapshot, savedCount: 1 },
  ], 3), false);
});

test('determineAggregateExitCode prioritizes quota, policy, timeout, missing asset, ui, generic, and ok', () => {
  assert.equal(determineAggregateExitCode(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'blocked_subscription' },
  })), EXIT_CODES.quota);

  assert.equal(determineAggregateExitCode(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'blocked_policy' },
  })), EXIT_CODES.policy);

  assert.equal(determineAggregateExitCode(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'failed_timeout' },
  })), EXIT_CODES.timeout);

  assert.equal(determineAggregateExitCode(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'failed_missing_asset' },
  })), EXIT_CODES.missingAsset);

  assert.equal(determineAggregateExitCode(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'failed_ui' },
  })), EXIT_CODES.ui);

  assert.equal(determineAggregateExitCode(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'failed_download' },
  })), EXIT_CODES.generic);

  assert.equal(determineAggregateExitCode(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'saved' },
  })), EXIT_CODES.ok);
});

test('determineAggregateExitCode uses no-progress snapshots to signal timeout', () => {
  const summary = summarizeVideoItems(makeState({
    1: { idx: 1, state: 'saved' },
    2: { idx: 2, state: 'pending' },
  }));

  const snapshot = buildProgressSnapshot(summary);
  assert.equal(detectNoProgress([snapshot, snapshot, snapshot], 3), true);
  assert.equal(determineAggregateExitCode(summary, {
    noProgress: true,
  }), EXIT_CODES.timeout);
});
