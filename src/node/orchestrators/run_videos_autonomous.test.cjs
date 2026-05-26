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
} = require('./run_videos_autonomous.cjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    readState,
    runWorker,
    logger: { log() {} },
    statePath: path.join(dir, 'video_state.json'),
  });

  assert.equal(code, 6);
  assert.equal(workerCalls, 2);
});
