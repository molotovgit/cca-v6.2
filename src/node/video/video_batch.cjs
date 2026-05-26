'use strict';

const path = require('path');

const { EXIT_CODES } = require('./video_errors.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../..');

const COMPLETE_STATES = new Set(['saved']);
const RETRYABLE_STATES = new Set(['pending', 'failed_timeout', 'failed_ui', 'failed_download']);
const BLOCKED_STATES = new Set(['blocked_quota', 'blocked_subscription', 'blocked_policy']);
const MISSING_SOURCE_STATES = new Set(['failed_missing_asset']);
const ACTIVE_STATES = new Set(['submitting', 'submitted', 'rendering']);
const TERMINAL_FAILURE_STATES = new Set([
  'blocked_quota',
  'blocked_subscription',
  'blocked_policy',
  'failed_ui',
  'failed_download',
  'failed_timeout',
  'failed_missing_asset',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isItemLike(value) {
  return isPlainObject(value) && (
    Object.prototype.hasOwnProperty.call(value, 'idx')
    || Object.prototype.hasOwnProperty.call(value, 'state')
    || Object.prototype.hasOwnProperty.call(value, 'attempts')
  );
}

function resolveItems(input) {
  if (Array.isArray(input)) return input.filter(Boolean);
  if (!isPlainObject(input)) return [];
  if (Array.isArray(input.items)) return input.items.filter(Boolean);
  if (isPlainObject(input.items)) return Object.values(input.items).filter(Boolean);
  return Object.values(input).filter(isItemLike);
}

function normalizeAttempts(attempts) {
  return Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
}

function normalizeIdx(idx, fallback) {
  return Number.isInteger(idx) && idx > 0 ? idx : fallback;
}

function sortByIdx(a, b) {
  const idxA = Number.isInteger(a.idx) ? a.idx : Number.MAX_SAFE_INTEGER;
  const idxB = Number.isInteger(b.idx) ? b.idx : Number.MAX_SAFE_INTEGER;
  if (idxA !== idxB) return idxA - idxB;
  const slugA = typeof a.slug === 'string' ? a.slug : '';
  const slugB = typeof b.slug === 'string' ? b.slug : '';
  return slugA.localeCompare(slugB);
}

function cloneItem(item, fallbackIdx) {
  const source = isPlainObject(item) ? item : {};
  const idx = normalizeIdx(source.idx, fallbackIdx);
  return {
    ...source,
    idx,
    attempts: normalizeAttempts(source.attempts),
    state: typeof source.state === 'string' && source.state ? source.state : 'pending',
  };
}

function capRetryableItem(item, maxAttempts = Infinity) {
  const normalized = cloneItem(item, item && item.idx);
  if (!RETRYABLE_STATES.has(normalized.state)) return normalized;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 0) return normalized;
  if (normalized.attempts < maxAttempts) return normalized;

  return {
    ...normalized,
    retrySourceState: normalized.state,
    state: normalized.state === 'failed_timeout' ? 'failed_timeout' : 'failed_ui',
    retryExhausted: true,
  };
}

function categorizeState(state) {
  if (COMPLETE_STATES.has(state)) return 'complete';
  if (BLOCKED_STATES.has(state)) return 'blocked';
  if (MISSING_SOURCE_STATES.has(state)) return 'missing_source';
  if (RETRYABLE_STATES.has(state)) return 'retryable';
  if (ACTIVE_STATES.has(state)) return 'active';
  if (TERMINAL_FAILURE_STATES.has(state)) return 'failed';
  return 'unknown';
}

function summarizeVideoItems(input, options = {}) {
  const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : Infinity;
  const items = resolveItems(input)
    .map((item, index) => capRetryableItem(cloneItem(item, index + 1), maxAttempts))
    .sort(sortByIdx);

  const summary = {
    repoRoot: REPO_ROOT,
    maxAttempts,
    totalCount: items.length,
    items,
    itemsByIdx: {},
    counts: {},
    completeItems: [],
    retryableItems: [],
    blockedItems: [],
    missingSourceItems: [],
    activeItems: [],
    failedItems: [],
    exhaustedItems: [],
    unknownItems: [],
    pendingItems: [],
  };

  for (const item of items) {
    const state = item.state;
    summary.itemsByIdx[String(item.idx)] = item;
    summary.counts[state] = (summary.counts[state] || 0) + 1;

    if (item.retryExhausted) {
      summary.exhaustedItems.push(item);
      summary.failedItems.push(item);
      continue;
    }

    const category = categorizeState(state);
    switch (category) {
      case 'complete':
        summary.completeItems.push(item);
        break;
      case 'retryable':
        summary.retryableItems.push(item);
        if (state === 'pending') summary.pendingItems.push(item);
        break;
      case 'blocked':
        summary.blockedItems.push(item);
        summary.failedItems.push(item);
        break;
      case 'missing_source':
        summary.missingSourceItems.push(item);
        summary.failedItems.push(item);
        break;
      case 'active':
        summary.activeItems.push(item);
        break;
      case 'failed':
        summary.failedItems.push(item);
        break;
      default:
        summary.unknownItems.push(item);
        break;
    }
  }

  summary.completeCount = summary.completeItems.length;
  summary.retryableCount = summary.retryableItems.length;
  summary.blockedCount = summary.blockedItems.length;
  summary.missingSourceCount = summary.missingSourceItems.length;
  summary.activeCount = summary.activeItems.length;
  summary.failedCount = summary.failedItems.length;
  summary.exhaustedCount = summary.exhaustedItems.length;
  summary.pendingCount = summary.pendingItems.length;
  summary.unknownCount = summary.unknownItems.length;
  summary.savedCount = summary.completeCount;
  summary.terminalCount = summary.completeCount + summary.failedCount + summary.unknownCount;
  summary.hasAllSaved = summary.totalCount > 0 && summary.savedCount === summary.totalCount;
  summary.progressSnapshot = buildProgressSnapshot(summary);
  summary.progressSignature = progressSignature(summary.progressSnapshot);

  return summary;
}

function summarizeVideoState(state, options = {}) {
  return summarizeVideoItems(state, options);
}

function selectNextRetryableItems(input, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 1;
  const summary = input && Array.isArray(input.items)
    ? input
    : summarizeVideoItems(input, options);
  const selected = summary.retryableItems.slice().sort(sortByIdx).slice(0, limit);

  return {
    ...summary,
    limit,
    selected,
    nextItem: selected[0] || null,
  };
}

function buildProgressSnapshot(input) {
  const summary = input && input.progressSnapshot && typeof input.progressSnapshot === 'object'
    ? input
    : (input && Array.isArray(input.items) && typeof input.totalCount === 'number'
      ? input
      : summarizeVideoItems(input));

  return {
    totalCount: summary.totalCount || 0,
    savedCount: summary.savedCount || 0,
    retryableCount: summary.retryableCount || 0,
    blockedCount: summary.blockedCount || 0,
    missingSourceCount: summary.missingSourceCount || 0,
    activeCount: summary.activeCount || 0,
    failedCount: summary.failedCount || 0,
    exhaustedCount: summary.exhaustedCount || 0,
    pendingCount: summary.pendingCount || 0,
    savedIdxs: (summary.completeItems || []).map(item => item.idx),
    retryableIdxs: (summary.retryableItems || []).map(item => item.idx),
    blockedIdxs: (summary.blockedItems || []).map(item => item.idx),
    missingSourceIdxs: (summary.missingSourceItems || []).map(item => item.idx),
  };
}

function progressSignature(snapshot) {
  const data = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const joinIdxs = value => (Array.isArray(value) ? value.join(',') : '');

  return [
    `total:${data.totalCount || 0}`,
    `saved:${data.savedCount || 0}`,
    `retryable:${data.retryableCount || 0}`,
    `blocked:${data.blockedCount || 0}`,
    `missing:${data.missingSourceCount || 0}`,
    `active:${data.activeCount || 0}`,
    `failed:${data.failedCount || 0}`,
    `savedIdxs:${joinIdxs(data.savedIdxs)}`,
    `retryableIdxs:${joinIdxs(data.retryableIdxs)}`,
    `blockedIdxs:${joinIdxs(data.blockedIdxs)}`,
    `missingIdxs:${joinIdxs(data.missingSourceIdxs)}`,
  ].join('|');
}

function detectNoProgress(snapshots, stallIterations = 3) {
  if (!Array.isArray(snapshots) || !Number.isInteger(stallIterations) || stallIterations < 2) return false;
  if (snapshots.length < stallIterations) return false;

  const tail = snapshots.slice(-stallIterations);
  if (tail.some(snapshot => !snapshot || typeof snapshot.savedCount !== 'number')) return false;

  const savedCount = tail[0].savedCount;
  if (tail.some(snapshot => snapshot.savedCount !== savedCount)) return false;

  const latest = tail[tail.length - 1];
  if (typeof latest.totalCount === 'number' && latest.savedCount >= latest.totalCount) return false;

  return true;
}

function determineAggregateExitCode(input, options = {}) {
  const summary = input && Array.isArray(input.items)
    ? input
    : summarizeVideoItems(input, options);

  const noProgress = Boolean(options.noProgress) || detectNoProgress(options.snapshots, options.stallIterations);

  if (summary.hasAllSaved) return EXIT_CODES.ok;
  if (summary.counts.blocked_quota || summary.counts.blocked_subscription) return EXIT_CODES.quota;
  if (summary.counts.blocked_policy) return EXIT_CODES.policy;
  if (noProgress || summary.counts.failed_timeout) return EXIT_CODES.timeout;
  if (summary.counts.failed_missing_asset) return EXIT_CODES.missingAsset;
  if (summary.counts.failed_ui) return EXIT_CODES.ui;
  if (summary.counts.failed_download || summary.failedCount || summary.retryableCount || summary.activeCount || summary.pendingCount) {
    return EXIT_CODES.generic;
  }
  return EXIT_CODES.ok;
}

module.exports = {
  ACTIVE_STATES,
  BLOCKED_STATES,
  COMPLETE_STATES,
  MISSING_SOURCE_STATES,
  RETRYABLE_STATES,
  TERMINAL_FAILURE_STATES,
  buildProgressSnapshot,
  capRetryableItem,
  categorizeState,
  detectNoProgress,
  determineAggregateExitCode,
  progressSignature,
  selectNextRetryableItems,
  summarizeVideoItems,
  summarizeVideoState,
};
