'use strict';

// =============================================================================
//  CCA — Video dashboard summary (pure, testable)
// =============================================================================
//  Compact, UI-facing projection of the video pipeline state for the local
//  dashboard. Built on top of summarizeVideoItems() so the per-state taxonomy
//  stays in one place. Defensive: malformed / null input → null (never throws).
// =============================================================================

const { summarizeVideoItems } = require('./video_batch.cjs');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Pick the "most recent" problem item to surface as the headline blocker.
// We have no reliable per-item timestamp, so "most recent" == highest idx.
// Among problem items we prefer one that carries a lastScreenshot so the UI
// has something to show; ties broken by highest idx.
function pickHeadlineProblem(blockedItems, failedItems) {
  const pool = [];
  const seen = new Set();
  for (const item of [].concat(blockedItems || [], failedItems || [])) {
    if (!isPlainObject(item)) continue;
    const key = String(item.idx);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(item);
  }
  if (pool.length === 0) return null;

  const idxOf = item => (Number.isInteger(item.idx) ? item.idx : -1);
  const hasShot = item => typeof item.lastScreenshot === 'string' && item.lastScreenshot.length > 0;

  pool.sort((a, b) => {
    // Prefer items that have a screenshot.
    const shotA = hasShot(a) ? 1 : 0;
    const shotB = hasShot(b) ? 1 : 0;
    if (shotA !== shotB) return shotB - shotA;
    // Then by highest idx (most recent).
    return idxOf(b) - idxOf(a);
  });

  return pool[0];
}

function extractUpdatedAt(videoState) {
  if (!isPlainObject(videoState)) return null;
  for (const key of ['updatedAt', 'updated_at', 'lastUpdated', 'mtime']) {
    const value = videoState[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// Build a compact object for the dashboard UI. Returns null when there is no
// usable video state (null / not an object / no items).
function summarizeVideoForDashboard(videoState, opts = {}) {
  try {
    if (!isPlainObject(videoState)) return null;

    const options = isPlainObject(opts) ? opts : {};
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : Infinity;

    const summary = summarizeVideoItems(videoState, { maxAttempts });
    if (!summary || summary.totalCount === 0) return null;

    const headline = pickHeadlineProblem(summary.blockedItems, summary.failedItems);

    let lastBlocker = null;
    let lastScreenshot = null;
    if (headline) {
      lastBlocker = {
        idx: Number.isInteger(headline.idx) ? headline.idx : null,
        state: typeof headline.state === 'string' ? headline.state : null,
        lastError: typeof headline.lastError === 'string' ? headline.lastError : null,
      };
      lastScreenshot = (typeof headline.lastScreenshot === 'string' && headline.lastScreenshot)
        ? headline.lastScreenshot
        : null;
    }

    return {
      savedCount: summary.savedCount,
      totalCount: summary.totalCount,
      counts: { ...summary.counts },
      active: summary.activeCount,
      blocked: summary.blockedCount,
      retryable: summary.retryableCount,
      failed: summary.failedCount,
      lastBlocker,
      lastScreenshot,
      updatedAt: extractUpdatedAt(videoState),
    };
  } catch {
    return null;
  }
}

module.exports = {
  summarizeVideoForDashboard,
};
