'use strict';

// Pure AIMD (additive-increase / multiplicative-decrease) concurrency
// controller for the Flow video pipeline. No I/O, no external requires.
//
// The controller probes higher concurrency one step at a time when a level's
// window completes cleanly (additive increase), and halves concurrency the
// moment a level's failed-tile rate exceeds the allowed limit (multiplicative
// decrease). Decrease always wins over increase within a single outcome.

const RESULTS = ['saved', 'failed_tile', 'blocked', 'other'];

function clampInt(value, floor, ceiling) {
  if (value < floor) return floor;
  if (value > ceiling) return ceiling;
  return value;
}

// Read CCA_VIDEO_MAX_IN_FLIGHT and clamp to [floor, ceiling].
// unset / NaN / < floor -> floor; > ceiling -> ceiling.
function parseMaxInFlight(env, { floor = 1, ceiling = 4 } = {}) {
  const raw = env ? env.CCA_VIDEO_MAX_IN_FLIGHT : undefined;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return floor;
  return clampInt(parsed, floor, ceiling);
}

function emptyLevel() {
  return { attempts: 0, saved: 0, failedTiles: 0, blocked: 0, other: 0 };
}

function rateFor(level) {
  return level.attempts === 0 ? 0 : level.failedTiles / level.attempts;
}

function createConcurrencyController({
  floor = 1,
  ceiling = 4,
  increaseAfter = 1,
  failedTileRateLimit = 0,
  windowSize = 1,
} = {}) {
  let limit = floor;
  const levels = { [floor]: emptyLevel() };

  function ensureLevel(n) {
    if (!levels[n]) levels[n] = emptyLevel();
    return levels[n];
  }

  function currentLimit() {
    return limit;
  }

  function recordOutcome({ result } = {}) {
    const level = ensureLevel(limit);
    level.attempts += 1;
    switch (result) {
      case 'saved':
        level.saved += 1;
        break;
      case 'failed_tile':
        level.failedTiles += 1;
        break;
      case 'blocked':
        level.blocked += 1;
        break;
      default:
        // Any unrecognized result is bucketed as 'other'.
        level.other += 1;
        break;
    }

    // (a) STEP-DOWN (multiplicative) — checked first; decrease wins.
    // Only failed tiles drive the rate; blocked/other dirty the window but
    // never trigger a step-down.
    if (rateFor(level) > failedTileRateLimit && limit > floor) {
      const newLimit = Math.max(floor, Math.floor(limit / 2));
      // Clear counters of every level above newLimit so re-probing starts clean.
      for (const key of Object.keys(levels)) {
        if (Number(key) > newLimit) delete levels[key];
      }
      ensureLevel(newLimit);
      limit = newLimit;
      return limit;
    }

    // (b) ADDITIVE +1 — only when the current level's window is clean+complete.
    // limit < ceiling guarantees floor===ceiling can NEVER increase.
    const windowCleanComplete =
      level.attempts >= windowSize &&
      level.failedTiles === 0 &&
      level.blocked === 0 &&
      level.saved >= increaseAfter;
    if (limit < ceiling && windowCleanComplete) {
      limit = Math.min(ceiling, limit + 1);
      ensureLevel(limit);
    }

    return limit;
  }

  function snapshot() {
    const out = {};
    for (const key of Object.keys(levels)) {
      const lvl = levels[key];
      out[key] = {
        attempts: lvl.attempts,
        saved: lvl.saved,
        failedTiles: lvl.failedTiles,
        blocked: lvl.blocked,
        other: lvl.other,
        rate: rateFor(lvl),
      };
    }
    return { limit, levels: out };
  }

  return { currentLimit, recordOutcome, snapshot };
}

module.exports = {
  RESULTS,
  createConcurrencyController,
  parseMaxInFlight,
};
