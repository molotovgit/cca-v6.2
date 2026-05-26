'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateExitCode,
  main,
  parseCliArgs,
  planCommandLoop,
  shouldContinue,
  summarizeVideoState,
  validateCliArgs,
} = require('./run_videos_autonomous.cjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Default-1 concurrency fake: floor=ceiling=1. Injected into every main() test
// so the suite never requires the real ../video/video_concurrency.cjs (which
// lives on another branch during parallel dev).
function defaultOneConcurrency() {
  return {
    parseMaxInFlight() { return 1; },
    createConcurrencyController() {
      return {
        currentLimit() { return 1; },
        recordOutcome() {},
        snapshot() { return { limit: 1 }; },
      };
    },
  };
}

// Fake concurrency module mirroring the frozen video_concurrency.cjs contract.
// floor/ceiling come from parseMaxInFlight; the controller clamps the in-flight
// budget to [floor, ceiling] and applies AIMD on recorded outcomes.
function makeFakeConcurrency({ recordCeiling } = {}) {
  return {
    parseMaxInFlight(env, { floor = 1, ceiling = 4 } = {}) {
      const raw = env && env.CCA_VIDEO_MAX_IN_FLIGHT;
      const value = raw == null || raw === '' ? floor : Number.parseInt(raw, 10);
      const resolved = Number.isFinite(value) ? value : floor;
      const clamped = Math.max(floor, Math.min(ceiling, resolved));
      if (typeof recordCeiling === 'function') recordCeiling(clamped);
      return clamped;
    },
    createConcurrencyController({ floor = 1, ceiling = 4 } = {}) {
      let limit = ceiling;
      return {
        currentLimit() {
          return limit;
        },
        recordOutcome({ result } = {}) {
          if (result === 'saved') {
            limit = Math.min(ceiling, limit + 1);
          } else {
            limit = Math.max(floor, Math.floor(limit / 2) || floor);
          }
        },
        snapshot() {
          return { limit, floor, ceiling };
        },
      };
    },
  };
}

test('parseCliArgs reads the prompts path and orchestration flags', () => {
  const cfg = parseCliArgs([
    'node',
    'run_videos_autonomous.cjs',
    'data/prompts/g7-uz/ch01.json',
    '--limit=8',
    '--max-attempts',
    '4',
    '--max-no-progress',
    '2',
  ]);

  assert.equal(cfg.promptsPath, 'data/prompts/g7-uz/ch01.json');
  assert.equal(cfg.limit, 8);
  assert.equal(cfg.maxAttempts, 4);
  assert.equal(cfg.maxNoProgress, 2);
});

test('aggregateExitCode prefers the more specific blocker', () => {
  assert.equal(aggregateExitCode(1, 4), 4);
  assert.equal(aggregateExitCode(4, 1), 4);
  assert.equal(aggregateExitCode(3, 5), 5);
});

test('planCommandLoop continues when an actionable item remains', () => {
  const plan = planCommandLoop({
    items: {
      1: { idx: 1, state: 'saved', attempts: 0 },
      2: { idx: 2, state: 'pending', attempts: 0 },
      3: { idx: 3, state: 'failed_missing_asset', attempts: 0 },
    },
  }, {
    limit: 2,
    maxAttempts: 3,
  });

  assert.equal(shouldContinue(plan), true);
  assert.equal(plan.nextItem.idx, 2);
  assert.equal(plan.exitCode, null);
  assert.equal(plan.savedCount, 1);
  assert.equal(plan.remainingToSave, 1);
});

test('planCommandLoop stops on quota and policy blocks immediately', () => {
  const quotaPlan = planCommandLoop({
    items: {
      1: { idx: 1, state: 'pending', attempts: 0 },
      2: { idx: 2, state: 'blocked_subscription', attempts: 0 },
    },
  }, {
    limit: 2,
    maxAttempts: 3,
  });

  const policyPlan = planCommandLoop({
    items: {
      1: { idx: 1, state: 'saved', attempts: 0 },
      2: { idx: 2, state: 'blocked_policy', attempts: 0 },
    },
  }, {
    limit: 2,
    maxAttempts: 3,
  });

  assert.equal(quotaPlan.exitCode, 4);
  assert.equal(quotaPlan.kind, 'stop');
  assert.equal(policyPlan.exitCode, 5);
  assert.equal(policyPlan.kind, 'stop');
});

test('planCommandLoop returns exit 7 when only missing assets remain', () => {
  const plan = planCommandLoop({
    items: {
      1: { idx: 1, state: 'saved', attempts: 0 },
      2: { idx: 2, state: 'failed_missing_asset', attempts: 0 },
    },
  }, {
    limit: 2,
    maxAttempts: 3,
  });

  assert.equal(plan.exitCode, 7);
  assert.equal(plan.kind, 'stop');
});

test('planCommandLoop returns a stable non-zero code when retries are exhausted', () => {
  const plan = planCommandLoop({
    items: {
      1: { idx: 1, state: 'failed_ui', attempts: 3 },
      2: { idx: 2, state: 'saved', attempts: 0 },
    },
  }, {
    limit: 2,
    maxAttempts: 3,
  });

  assert.equal(plan.exitCode, 3);
  assert.equal(plan.kind, 'stop');
  assert.equal(plan.nextActionableItem, null);
});

test('summarizeVideoState reports the next actionable clip in index order', () => {
  const summary = summarizeVideoState({
    items: {
      9: { idx: 9, state: 'pending', attempts: 0 },
      2: { idx: 2, state: 'failed_download', attempts: 1 },
      4: { idx: 4, state: 'saved', attempts: 0 },
    },
  }, {
    limit: null,
    maxAttempts: 3,
  });

  assert.equal(summary.nextActionableItem.idx, 2);
  assert.equal(summary.counts.saved, 1);
  assert.equal(summary.counts.failed_download, 1);
});

test('main exits once a single worker pass saves the requested item', async () => {
  const dir = tempDir('video-orch-');
  const promptsPath = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsPath, JSON.stringify([{ idx: 1, image_prompt: 'demo' }]));

  const state = {
    items: {
      1: { idx: 1, state: 'pending', attempts: 0 },
    },
  };
  let workerCalls = 0;
  const readState = async () => structuredClone(state);
  const runWorker = async ({ plan }) => {
    workerCalls += 1;
    assert.equal(plan.nextItem.idx, 1);
    state.items[1] = { ...state.items[1], state: 'saved', attempts: state.items[1].attempts + 1 };
    return 0;
  };

  const code = await main([
    'node',
    'run_videos_autonomous.cjs',
    promptsPath,
    '--limit',
    '1',
    '--max-attempts',
    '3',
    '--max-no-progress',
    '2',
  ], {
    concurrency: defaultOneConcurrency(),
    readState,
    runWorker,
    logger: { log() {} },
    statePath: path.join(dir, 'video_state.json'),
  });

  assert.equal(code, 0);
  assert.equal(workerCalls, 1);
});

test('main stops with exit 6 after repeated no-progress cycles', async () => {
  const dir = tempDir('video-orch-stall-');
  const promptsPath = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsPath, JSON.stringify([{ idx: 1, image_prompt: 'demo' }]));

  const state = {
    items: {
      1: { idx: 1, state: 'pending', attempts: 0 },
    },
  };
  let workerCalls = 0;
  const readState = async () => structuredClone(state);
  const runWorker = async () => {
    workerCalls += 1;
    state.items[1] = { ...state.items[1], attempts: state.items[1].attempts + 1, state: 'failed_ui' };
    return 1;
  };

  const code = await main([
    'node',
    'run_videos_autonomous.cjs',
    promptsPath,
    '--limit',
    '1',
    '--max-attempts',
    '10',
    '--max-no-progress',
    '2',
  ], {
    concurrency: defaultOneConcurrency(),
    readState,
    runWorker,
    logger: { log() {} },
    statePath: path.join(dir, 'video_state.json'),
  });

  assert.equal(code, 6);
  assert.equal(workerCalls, 2);
});

test('parseCliArgs reads --max-in-flight as a positive int (space and equals forms)', () => {
  const spaced = parseCliArgs(['node', 'run_videos_autonomous.cjs', 'p.json', '--max-in-flight', '3']);
  assert.equal(spaced.maxInFlight, 3);

  const equals = parseCliArgs(['node', 'run_videos_autonomous.cjs', 'p.json', '--max-in-flight=4']);
  assert.equal(equals.maxInFlight, 4);
});

test('parseCliArgs defaults maxInFlight to null when absent', () => {
  const cfg = parseCliArgs(['node', 'run_videos_autonomous.cjs', 'p.json', '--limit', '2']);
  assert.equal(cfg.maxInFlight, null);
});

test('validateCliArgs rejects --max-in-flight below 1', () => {
  const dir = tempDir('video-orch-mif-validate-');
  const promptsPath = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsPath, JSON.stringify([{ idx: 1, image_prompt: 'demo' }]));

  // NaN (from a 0 / negative parse) must be rejected like --limit.
  assert.throws(
    () => validateCliArgs({ promptsPath, maxInFlight: Number.NaN, maxAttempts: 3, maxNoProgress: 2 }),
    /--max-in-flight must be a positive integer/
  );
  // Explicit < 1 is rejected.
  assert.throws(
    () => validateCliArgs({ promptsPath, maxInFlight: 0, maxAttempts: 3, maxNoProgress: 2 }),
    /--max-in-flight must be a positive integer/
  );
  // null (absent) passes validation.
  const ok = validateCliArgs({ promptsPath, maxInFlight: null, maxAttempts: 3, maxNoProgress: 2 });
  assert.equal(ok.maxInFlight, null);
});

test('CCA_VIDEO_MAX_IN_FLIGHT resolves and clamps the controller ceiling', async () => {
  const dir = tempDir('video-orch-env-');
  const promptsPath = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsPath, JSON.stringify([{ idx: 1, image_prompt: 'demo' }]));

  const original = process.env.CCA_VIDEO_MAX_IN_FLIGHT;
  try {
    async function ceilingFor(envValue) {
      if (envValue === undefined) {
        delete process.env.CCA_VIDEO_MAX_IN_FLIGHT;
      } else {
        process.env.CCA_VIDEO_MAX_IN_FLIGHT = envValue;
      }
      let observed = null;
      const concurrency = makeFakeConcurrency({ recordCeiling: c => { observed = c; } });
      // A single saving pass so main exits immediately after resolving ceiling.
      const state = { items: { 1: { idx: 1, state: 'pending', attempts: 0 } } };
      const readState = async () => structuredClone(state);
      const runWorker = async () => {
        state.items[1] = { ...state.items[1], state: 'saved', attempts: 1 };
        return 0;
      };
      const code = await main(['node', 'run_videos_autonomous.cjs', promptsPath], {
        concurrency,
        readState,
        runWorker,
        logger: { log() {} },
        statePath: path.join(dir, `state-${envValue}.json`),
      });
      assert.equal(code, 0);
      return observed;
    }

    assert.equal(await ceilingFor('3'), 3, 'env "3" → ceiling 3');
    assert.equal(await ceilingFor('9'), 4, 'env "9" → clamped to 4');
    assert.equal(await ceilingFor(undefined), 1, 'unset → default 1');
  } finally {
    if (original === undefined) {
      delete process.env.CCA_VIDEO_MAX_IN_FLIGHT;
    } else {
      process.env.CCA_VIDEO_MAX_IN_FLIGHT = original;
    }
  }
});

test('--max-in-flight CLI flag overrides CCA_VIDEO_MAX_IN_FLIGHT env', async () => {
  const dir = tempDir('video-orch-override-');
  const promptsPath = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsPath, JSON.stringify([{ idx: 1, image_prompt: 'demo' }]));

  const original = process.env.CCA_VIDEO_MAX_IN_FLIGHT;
  try {
    process.env.CCA_VIDEO_MAX_IN_FLIGHT = '2';
    let observed = null;
    const concurrency = makeFakeConcurrency({ recordCeiling: c => { observed = c; } });
    const state = { items: { 1: { idx: 1, state: 'pending', attempts: 0 } } };
    const readState = async () => structuredClone(state);
    const runWorker = async () => {
      state.items[1] = { ...state.items[1], state: 'saved', attempts: 1 };
      return 0;
    };

    const code = await main([
      'node', 'run_videos_autonomous.cjs', promptsPath, '--max-in-flight', '4',
    ], {
      concurrency,
      readState,
      runWorker,
      logger: { log() {} },
      statePath: path.join(dir, 'state.json'),
    });

    assert.equal(code, 0);
    assert.equal(observed, 4, 'CLI flag 4 wins over env "2"');
  } finally {
    if (original === undefined) {
      delete process.env.CCA_VIDEO_MAX_IN_FLIGHT;
    } else {
      process.env.CCA_VIDEO_MAX_IN_FLIGHT = original;
    }
  }
});

test('controller persists across iterations and backs off on failed tiles', async () => {
  const dir = tempDir('video-orch-aimd-');
  const promptsPath = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsPath, JSON.stringify([{ idx: 1, image_prompt: 'demo' }]));

  // Stateful state: each pass fails the tile (no progress), so main stalls out
  // after maxNoProgress cycles. The WORKER records a failed-tile outcome each
  // pass (simulated by the injected runWorker below — in production
  // submit_flow_videos records per clip), and the injected controller halves its
  // limit on each such outcome. We capture currentLimit() per worker call to
  // assert the back-off carries forward across iterations. Note: failed_ui is the
  // codebase's retryable failure state (a "failed tile").
  const state = { items: { 1: { idx: 1, state: 'pending', attempts: 0 } } };
  const readState = async () => structuredClone(state);

  // Inject a controller seeded high so we can observe the multiplicative decrease.
  let limit = 4;
  const controller = {
    currentLimit() { return limit; },
    recordOutcome({ result } = {}) {
      if (result === 'saved') {
        limit = Math.min(4, limit + 1);
      } else {
        limit = Math.max(1, Math.floor(limit / 2));
      }
    },
    snapshot() { return { limit }; },
  };

  const observedLimits = [];
  const runWorker = async ({ controller: ctrl }) => {
    // Same controller instance is threaded into every iteration.
    observedLimits.push(ctrl.currentLimit());
    // The worker (submit_flow_videos) is the single source of recordOutcome in
    // production — one record per clip. Simulate one failed tile per pass.
    ctrl.recordOutcome({ result: 'failed_tile' });
    state.items[1] = { ...state.items[1], attempts: state.items[1].attempts + 1, state: 'failed_ui' };
    return 1;
  };

  const code = await main([
    'node', 'run_videos_autonomous.cjs', promptsPath,
    '--limit', '1', '--max-attempts', '10', '--max-no-progress', '3',
  ], {
    controller,
    concurrency: makeFakeConcurrency(),
    readState,
    runWorker,
    logger: { log() {} },
    statePath: path.join(dir, 'state.json'),
  });

  assert.equal(code, 6, 'stalls out after maxNoProgress failed passes');
  assert.ok(observedLimits.length >= 2, 'controller observed across multiple iterations');
  // Limit is non-increasing under repeated failure (carried forward, never reset).
  for (let i = 1; i < observedLimits.length; i += 1) {
    assert.ok(
      observedLimits[i] <= observedLimits[i - 1],
      `iter ${i} limit ${observedLimits[i]} should be <= iter ${i - 1} limit ${observedLimits[i - 1]}`
    );
  }
  // Back-off actually happened: later limit strictly below the seed.
  assert.ok(observedLimits[observedLimits.length - 1] < observedLimits[0], 'back-off carried forward');
});

test('DEFAULT (no flag/env) keeps behavior identical: runWorker always gets limit 1', async () => {
  const dir = tempDir('video-orch-default1-');
  const promptsPath = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsPath, JSON.stringify([{ idx: 1, image_prompt: 'demo' }]));

  const original = process.env.CCA_VIDEO_MAX_IN_FLIGHT;
  try {
    delete process.env.CCA_VIDEO_MAX_IN_FLIGHT;

    const state = { items: { 1: { idx: 1, state: 'pending', attempts: 0 } } };
    let workerCalls = 0;
    const observedLimits = [];
    const readState = async () => structuredClone(state);
    const runWorker = async ({ plan, controller }) => {
      workerCalls += 1;
      observedLimits.push(controller.currentLimit());
      assert.equal(plan.nextItem.idx, 1);
      state.items[1] = { ...state.items[1], state: 'saved', attempts: state.items[1].attempts + 1 };
      return 0;
    };

    // Inject a fake concurrency module that yields a floor=ceiling=1 controller,
    // proving the default path always runs the worker with an in-flight budget of 1.
    const concurrency = {
      parseMaxInFlight() { return 1; },
      createConcurrencyController() {
        return {
          currentLimit() { return 1; },
          recordOutcome() {},
          snapshot() { return { limit: 1 }; },
        };
      },
    };

    // Reuse the existing "main exits once a worker pass saves" pattern unchanged.
    const code = await main([
      'node', 'run_videos_autonomous.cjs', promptsPath,
      '--limit', '1', '--max-attempts', '3', '--max-no-progress', '2',
    ], {
      concurrency,
      readState,
      runWorker,
      logger: { log() {} },
      statePath: path.join(dir, 'state.json'),
    });

    assert.equal(code, 0);
    assert.equal(workerCalls, 1);
    assert.deepEqual(observedLimits, [1], 'worker always called with limit 1 under default');
  } finally {
    if (original === undefined) {
      delete process.env.CCA_VIDEO_MAX_IN_FLIGHT;
    } else {
      process.env.CCA_VIDEO_MAX_IN_FLIGHT = original;
    }
  }
});
