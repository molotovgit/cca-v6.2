'use strict';

// Autonomous Google Flow video orchestrator.
//
// Concurrency (controlled via AIMD controller, default behaves as max-in-flight 1):
//   --max-in-flight N   CLI flag; positive integer. Overrides the env var below.
//   CCA_VIDEO_MAX_IN_FLIGHT   env var; default 1, clamped to [1, 4].
// The resolved ceiling seeds a concurrency controller (resolved lazily from
// ../video/video_concurrency.cjs, injectable via deps.concurrency/deps.controller)
// that is created ONCE before the loop so AIMD evidence persists across iterations.
// With no flag and no env, the ceiling is 1, so the loop stays behavior-identical
// to a single-in-flight pass.

const fs = require('fs');
const path = require('path');

const { EXIT_CODES } = require('../video/video_errors.cjs');
const { DEFAULT_STATE_PATH, reconcileVideoState } = require('../video/video_state.cjs');
const {
  determineAggregateExitCode,
  selectNextRetryableItems,
  summarizeVideoState: summarizeVideoBatchState,
} = require('../video/video_batch.cjs');
const {
  chooseBetterExitCode,
  deriveFlowDirs,
  runSmokeWorker,
} = require('../workers/submit_flow_videos.cjs');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_NO_PROGRESS = 3;

function parseRequiredPositiveInt(raw) {
  if (raw == null || raw === '') return Number.NaN;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

function parseCliArgs(argv = process.argv) {
  const args = argv.slice(2);
  const promptsPath = args[0] && !String(args[0]).startsWith('--') ? args[0] : null;
  let limit = null;
  let maxInFlight = null;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  let maxNoProgress = DEFAULT_MAX_NO_PROGRESS;

  for (let i = promptsPath ? 1 : 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--limit') {
      limit = parseRequiredPositiveInt(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = parseRequiredPositiveInt(arg.split('=', 2)[1]);
      continue;
    }
    if (arg === '--max-in-flight') {
      maxInFlight = parseRequiredPositiveInt(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-in-flight=')) {
      maxInFlight = parseRequiredPositiveInt(arg.split('=', 2)[1]);
      continue;
    }
    if (arg === '--max-attempts') {
      maxAttempts = parseRequiredPositiveInt(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-attempts=')) {
      maxAttempts = parseRequiredPositiveInt(arg.split('=', 2)[1]);
      continue;
    }
    if (arg === '--max-no-progress') {
      maxNoProgress = parseRequiredPositiveInt(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-no-progress=')) {
      maxNoProgress = parseRequiredPositiveInt(arg.split('=', 2)[1]);
    }
  }

  return { promptsPath, limit, maxInFlight, maxAttempts, maxNoProgress };
}

function validateCliArgs(parsed) {
  const { promptsPath, limit, maxInFlight, maxAttempts, maxNoProgress } = parsed || {};

  if (!promptsPath) {
    const err = new Error('Usage: node run_videos_autonomous.cjs <prompts.json> [--limit N] [--max-in-flight N] [--max-attempts N] [--max-no-progress N]');
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (!fs.existsSync(promptsPath)) {
    const err = new Error(`prompts file not found: ${promptsPath}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (limit != null && (!Number.isFinite(limit) || limit < 1)) {
    const err = new Error(`--limit must be a positive integer; got ${limit}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  // When supplied, --max-in-flight must be a positive integer. We do NOT reject
  // values over the ceiling here; the concurrency controller clamps to [1, 4].
  if (maxInFlight != null && (!Number.isFinite(maxInFlight) || maxInFlight < 1)) {
    const err = new Error(`--max-in-flight must be a positive integer; got ${maxInFlight}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    const err = new Error(`--max-attempts must be a positive integer; got ${maxAttempts}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (!Number.isFinite(maxNoProgress) || maxNoProgress < 1) {
    const err = new Error(`--max-no-progress must be a positive integer; got ${maxNoProgress}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  return { promptsPath, limit, maxInFlight, maxAttempts, maxNoProgress };
}

function summarizeVideoState(state, { limit = null, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const summary = summarizeVideoBatchState(state, { maxAttempts });
  const desiredCount = limit == null ? summary.totalCount : Math.min(limit, summary.totalCount);
  const remainingToSave = Math.max(0, desiredCount - summary.savedCount);
  const selection = selectNextRetryableItems(summary, { limit: 1, maxAttempts });

  return {
    ...summary,
    desiredCount,
    remainingToSave,
    nextActionableItem: selection.nextItem,
    hasQuotaBlock: (summary.counts.blocked_quota || 0) > 0 || (summary.counts.blocked_subscription || 0) > 0,
    hasPolicyBlock: (summary.counts.blocked_policy || 0) > 0,
    hasMissingAssets: (summary.counts.failed_missing_asset || 0) > 0,
    hasActionableWork: Boolean(selection.nextItem),
  };
}

function aggregateExitCode(current, next) {
  if (typeof current !== 'number') return next;
  if (typeof next !== 'number') return current;
  return chooseBetterExitCode(current, next);
}

function aggregateExitCodes(codes) {
  return (Array.isArray(codes) ? codes : []).reduce(
    (acc, code) => aggregateExitCode(acc, code),
    EXIT_CODES.ok
  );
}

function classifyStopDecision(summary) {
  if (!summary) return { kind: 'stop', exitCode: EXIT_CODES.generic, reason: 'missing state summary' };
  if (summary.remainingToSave <= 0) return { kind: 'done', exitCode: EXIT_CODES.ok, reason: 'all selected/requested clips saved' };
  if (summary.hasQuotaBlock) return { kind: 'stop', exitCode: EXIT_CODES.quota, reason: 'quota or subscription block' };
  if (summary.hasPolicyBlock) return { kind: 'stop', exitCode: EXIT_CODES.policy, reason: 'policy block' };
  if (summary.hasActionableWork) {
    return { kind: 'continue', exitCode: null, reason: 'work remains', nextItem: summary.nextActionableItem };
  }
  if (summary.exhaustedItems.length > 0) {
    return {
      kind: 'stop',
      exitCode: determineAggregateExitCode(summary),
      reason: 'retry budget exhausted',
    };
  }
  if (summary.hasMissingAssets) return { kind: 'stop', exitCode: EXIT_CODES.missingAsset, reason: 'missing source assets' };
  return { kind: 'stop', exitCode: determineAggregateExitCode(summary), reason: 'no eligible items remain' };
}

function shouldContinue(plan) {
  return Boolean(plan && plan.kind === 'continue');
}

function planCommandLoop(state, options = {}) {
  const summary = summarizeVideoState(state, options);
  const decision = classifyStopDecision(summary);
  return { ...summary, ...decision };
}

function defaultReadState({ promptsPath, statePath = DEFAULT_STATE_PATH, now = () => new Date().toISOString() } = {}) {
  const { imagesDir, videosDir } = deriveFlowDirs(promptsPath);
  return reconcileVideoState({
    promptsPath,
    imagesDir,
    videosDir,
    statePath,
    mode: 'flow',
    activeProvider: 'flow',
    now: now(),
  });
}

async function defaultRunWorker({
  promptsPath,
  statePath = DEFAULT_STATE_PATH,
  controller,
  adapter,
  browser,
  screenshotsDir,
  now,
} = {}) {
  // Derive the in-flight budget from the AIMD controller. With the default
  // ceiling of 1 this resolves to 1, matching the previous hardcoded behavior.
  const inFlight = controller ? controller.currentLimit() : 1;
  return runSmokeWorker({
    promptsPath,
    limit: inFlight,
    maxInFlight: inFlight,
    controller,
    statePath,
    adapter,
    browser,
    screenshotsDir,
    now,
  });
}

async function main(argv = process.argv, deps = {}) {
  const parsed = validateCliArgs(parseCliArgs(argv));
  const statePath = deps.statePath || DEFAULT_STATE_PATH;
  const readState = deps.readState || defaultReadState;
  const runWorker = deps.runWorker || defaultRunWorker;
  const logger = deps.logger || console;
  const now = deps.now || (() => new Date().toISOString());
  let noProgressStreak = 0;

  // Resolve the concurrency module lazily so this file does not require
  // ../video/video_concurrency.cjs at module top — during parallel dev that
  // file lives on another branch. deps.concurrency overrides it for tests.
  const concurrency = deps.concurrency || require('../video/video_concurrency.cjs');
  // CLI flag overrides env; default 1; clamp to [1, 4].
  const ceiling = concurrency.parseMaxInFlight(
    { CCA_VIDEO_MAX_IN_FLIGHT: parsed.maxInFlight != null ? String(parsed.maxInFlight) : process.env.CCA_VIDEO_MAX_IN_FLIGHT },
    { floor: 1, ceiling: 4 }
  );
  // Created ONCE before the loop so AIMD evidence persists across iterations.
  const controller = deps.controller || concurrency.createConcurrencyController({ floor: 1, ceiling });

  while (true) {
    const state = await readState({ promptsPath: parsed.promptsPath, statePath, now });
    const plan = planCommandLoop(state, {
      limit: parsed.limit,
      maxAttempts: parsed.maxAttempts,
    });

    if (!shouldContinue(plan)) return plan.exitCode;

    const savedBefore = plan.savedCount;
    if (logger && typeof logger.log === 'function') {
      logger.log(`[videos] next idx=${plan.nextItem && plan.nextItem.idx} state=${plan.nextItem && plan.nextItem.state} attempts=${plan.nextItem && plan.nextItem.attempts}`);
    }

    const workerExit = await runWorker({
      promptsPath: parsed.promptsPath,
      statePath,
      plan,
      controller,
      adapter: deps.adapter,
      browser: deps.browser,
      screenshotsDir: deps.screenshotsDir,
      now,
    });

    const refreshed = await readState({ promptsPath: parsed.promptsPath, statePath, now });
    const refreshedPlan = planCommandLoop(refreshed, {
      limit: parsed.limit,
      maxAttempts: parsed.maxAttempts,
    });

    const madeProgress = refreshedPlan.savedCount > savedBefore;

    // Feed the AIMD controller evidence from this pass so its in-flight budget
    // additively increases on progress and multiplicatively decreases on stall.
    if (controller && typeof controller.recordOutcome === 'function') {
      controller.recordOutcome({ result: madeProgress ? 'saved' : 'failed_tile' });
    }

    if (!shouldContinue(refreshedPlan)) return refreshedPlan.exitCode;

    if (madeProgress) {
      noProgressStreak = 0;
    } else {
      noProgressStreak += 1;
    }

    if (noProgressStreak >= parsed.maxNoProgress) return EXIT_CODES.timeout;

    if (typeof workerExit === 'number' && (
      workerExit === EXIT_CODES.quota
      || workerExit === EXIT_CODES.policy
      || workerExit === EXIT_CODES.missingAsset
    )) {
      return workerExit;
    }
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    const code = typeof err.code === 'number' ? err.code : EXIT_CODES.generic;
    console.error(`[videos] unrecovered failure: ${err && err.message ? err.message : err}`);
    process.exit(code);
  });
}

module.exports = {
  aggregateExitCode,
  aggregateExitCodes,
  classifyStopDecision,
  defaultReadState,
  defaultRunWorker,
  main,
  parseCliArgs,
  planCommandLoop,
  shouldContinue,
  summarizeVideoState,
  validateCliArgs,
};
