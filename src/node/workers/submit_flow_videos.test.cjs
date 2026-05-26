'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  classifyControllerResult,
  createStateWriteMutex,
  deriveFlowDirs,
  motionForItem,
  parseCliArgs,
  runSmokeWorker,
  selectEligibleItems,
  validateSmokeConfig,
} = require('./submit_flow_videos.cjs');

const { EXIT_CODES } = require('../video/video_errors.cjs');

// --- shared test fixtures for the concurrent scheduler --------------------

function padIdx(idx) {
  return String(idx).padStart(3, '0');
}

// Lay out a self-contained prompts/images tree OUTSIDE the repo (absolute
// paths) so reconcileVideoState marks each item `pending`: a PNG must exist
// and no ready MP4. Returns the prompts path + statePath in the same tmp root.
function makeWorkspace(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sched-'));
  const promptsDir = path.join(root, 'prompts', 'g7-uz', 'subject');
  const imagesDir = path.join(root, 'images', 'g7-uz', 'subject', 'ch01');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });

  const prompts = [];
  for (let idx = 1; idx <= count; idx += 1) {
    prompts.push({ idx, motion_script: `motion ${idx}` });
    fs.writeFileSync(path.join(imagesDir, `${padIdx(idx)}-scene-${padIdx(idx)}.png`), 'png');
  }
  const promptsPath = path.join(promptsDir, 'ch01.json');
  fs.writeFileSync(promptsPath, JSON.stringify(prompts));

  return { root, promptsPath, statePath: path.join(root, 'video_state.json') };
}

// A puppeteer-shaped browser stub. Each newPage() records into `calls` and
// returns a distinct page whose close() also records, so ordering and
// open/close counts are observable.
function makeBrowser(calls) {
  let pageSeq = 0;
  return {
    newPage() {
      const id = (pageSeq += 1);
      calls.push(`open:${id}`);
      return Promise.resolve({
        id,
        close() {
          calls.push(`close:${id}`);
          return Promise.resolve();
        },
      });
    },
    disconnect() {
      return Promise.resolve();
    },
  };
}

// Controller stub with a fixed limit; records every recordOutcome call.
function makeController(limit, outcomes) {
  return {
    floor: limit,
    ceiling: limit,
    currentLimit() {
      return limit;
    },
    recordOutcome(o) {
      outcomes.push(o);
    },
  };
}

class FakeFlowAdapterError extends Error {
  constructor(message, { state, exitCode, stage } = {}) {
    super(message);
    this.name = 'FlowAdapterError';
    if (state) this.state = state;
    if (typeof exitCode === 'number') this.exitCode = exitCode;
    if (stage) this.stage = stage;
  }
}

test('parseCliArgs reads limit and max-in-flight flags', () => {
  const cfg = parseCliArgs([
    'node',
    'submit_flow_videos.cjs',
    'data/prompts/g7-uz/ch01.json',
    '--limit',
    '3',
    '--max-in-flight',
    '1',
  ]);

  assert.equal(cfg.promptsPath, 'data/prompts/g7-uz/ch01.json');
  assert.equal(cfg.limit, 3);
  assert.equal(cfg.maxInFlight, 1);
});

test('deriveFlowDirs swaps prompts for images and videos', () => {
  const dirs = deriveFlowDirs(path.join('/repo', 'data', 'prompts', 'g7-uz', 'subject', 'ch01-title.json'));

  assert.equal(dirs.promptsAbs, path.join('/repo', 'data', 'prompts', 'g7-uz', 'subject', 'ch01-title.json'));
  assert.equal(dirs.imagesDir, path.join('/repo', 'data', 'images', 'g7-uz', 'subject', 'ch01-title'));
  assert.equal(dirs.videosDir, path.join('/repo', 'data', 'videos', 'g7-uz', 'subject', 'ch01-title'));
});

test('selectEligibleItems keeps retryable states and skips saved and missing assets', () => {
  const state = {
    items: {
      1: { idx: 1, state: 'pending' },
      2: { idx: 2, state: 'failed_timeout' },
      3: { idx: 3, state: 'failed_ui' },
      4: { idx: 4, state: 'failed_download' },
      5: { idx: 5, state: 'saved' },
      6: { idx: 6, state: 'failed_missing_asset' },
      7: { idx: 7, state: 'blocked_quota' },
    },
  };

  const selection = selectEligibleItems(state, 2);
  assert.deepEqual(selection.selected.map(item => item.idx), [1, 2]);
  assert.deepEqual(selection.eligible.map(item => item.idx), [1, 2, 3, 4]);
  assert.equal(selection.counts.saved, 1);
  assert.equal(selection.counts.failed_missing_asset, 1);
});

test('validateSmokeConfig rejects max-in-flight above one in smoke mode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-submit-'));
  const promptsPath = path.join(tmpDir, 'prompts.json');
  fs.writeFileSync(promptsPath, '[]');

  // smoke:true keeps the original single-flight restriction.
  assert.throws(() => validateSmokeConfig({
    promptsPath,
    limit: 1,
    maxInFlight: 2,
    smoke: true,
  }), /max-in-flight 1/);
});

test('validateSmokeConfig allows up to ceiling and rejects beyond it (non-smoke)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-submit-'));
  const promptsPath = path.join(tmpDir, 'prompts.json');
  fs.writeFileSync(promptsPath, '[]');

  // Non-smoke path accepts maxInFlight up to the ceiling...
  const ok = validateSmokeConfig({ promptsPath, limit: 1, maxInFlight: 4, ceiling: 4 });
  assert.equal(ok.maxInFlight, 4);

  // ...and rejects anything above it with the ceiling message.
  assert.throws(() => validateSmokeConfig({
    promptsPath,
    limit: 1,
    maxInFlight: 5,
    ceiling: 4,
  }), /must be <= 4/);

  // maxInFlight < 1 is still rejected regardless of mode.
  assert.throws(() => validateSmokeConfig({
    promptsPath,
    limit: 1,
    maxInFlight: 0,
  }), /positive integer/);
});

test('motionForItem prefers motion_script and falls back to image_prompt', () => {
  const prompts = [
    { idx: 1, image_prompt: 'image prompt one' },
    { idx: 2, motion_script: 'motion prompt two', image_prompt: 'image prompt two' },
  ];

  assert.equal(motionForItem({ idx: 1 }, prompts), 'image prompt one');
  assert.equal(motionForItem({ idx: 2 }, prompts), 'motion prompt two');
  assert.equal(motionForItem({ idx: 3, motion_script: 'direct item motion' }, prompts), 'direct item motion');
});

test('classifyControllerResult maps stage/category/exit to coarse signals', () => {
  // Success outcome -> saved.
  assert.equal(
    classifyControllerResult({ state: 'saved', exitCode: EXIT_CODES.ok }, null),
    'saved'
  );

  // FlowAdapterError at await_completed_tile -> failed_tile.
  assert.equal(
    classifyControllerResult(null, new FakeFlowAdapterError('no tile', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.timeout,
      stage: 'await_completed_tile',
    })),
    'failed_tile'
  );

  // Explicit failed_tile category -> failed_tile.
  assert.equal(
    classifyControllerResult(null, Object.assign(new Error('tile'), { category: 'failed_tile' })),
    'failed_tile'
  );

  // A non-tile failed_ui (e.g. stage enter_motion) -> other, NOT failed_tile.
  assert.equal(
    classifyControllerResult(null, new FakeFlowAdapterError('motion box missing', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.ui,
      stage: 'enter_motion',
    })),
    'other'
  );

  // Quota blocker (exit 4) -> blocked.
  assert.equal(
    classifyControllerResult(null, new FakeFlowAdapterError('out of credits', {
      state: 'blocked_quota',
      exitCode: EXIT_CODES.quota,
      stage: 'blocked_quota',
    })),
    'blocked'
  );

  // Timeout -> other.
  assert.equal(
    classifyControllerResult(null, new FakeFlowAdapterError('timed out', {
      state: 'failed_timeout',
      exitCode: EXIT_CODES.timeout,
      stage: 'await_project',
    })),
    'other'
  );
});

test('createStateWriteMutex serializes calls in order', async () => {
  const withLock = createStateWriteMutex();
  const order = [];
  const mkTask = (label, delay) => () => new Promise(resolve => {
    setTimeout(() => {
      order.push(label);
      resolve(label);
    }, delay);
  });

  // First task is slow, second is fast; the mutex must still run them in order.
  const p1 = withLock(mkTask('a', 20));
  const p2 = withLock(mkTask('b', 0));
  const results = await Promise.all([p1, p2]);

  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(results, ['a', 'b']);
});

test('runSmokeWorker schedules N concurrent slots over the queue', async () => {
  const { promptsPath, statePath } = makeWorkspace(3);
  const calls = [];
  const outcomes = [];
  const generated = [];

  const adapter = {
    generateOne({ item }) {
      generated.push(item.idx);
      // idx 2 fails as a failed tile; the rest succeed.
      if (item.idx === 2) {
        return Promise.reject(new FakeFlowAdapterError('tile failed', {
          state: 'failed_ui',
          exitCode: EXIT_CODES.timeout,
          stage: 'await_completed_tile',
        }));
      }
      return Promise.resolve({ state: 'saved', exitCode: EXIT_CODES.ok });
    },
  };

  const exitCode = await runSmokeWorker({
    promptsPath,
    limit: 3,
    maxInFlight: 3,
    adapter,
    browser: makeBrowser(calls),
    controller: makeController(3, outcomes),
    statePath,
    now: () => '2026-05-26T00:00:00.000Z',
  });

  // All three items generated, three pages opened and closed.
  assert.equal(generated.length, 3);
  assert.deepEqual(generated.slice().sort(), [1, 2, 3]);
  assert.equal(calls.filter(c => c.startsWith('open:')).length, 3);
  assert.equal(calls.filter(c => c.startsWith('close:')).length, 3);

  // Three controller outcomes with the right classified results.
  assert.equal(outcomes.length, 3);
  const results = outcomes.map(o => o.result).sort();
  assert.deepEqual(results, ['failed_tile', 'saved', 'saved']);

  // Aggregate exit code is the worst seen (timeout from the failed tile).
  assert.equal(exitCode, EXIT_CODES.timeout);
});

test('runSmokeWorker default single-flight runs sequentially in order', async () => {
  const { promptsPath, statePath } = makeWorkspace(2);
  const calls = [];
  const outcomes = [];

  // Item 1 resolves on a deferred tick so we can prove item 2's page does not
  // open until item 1's page has closed.
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const adapter = {
    async generateOne({ item }) {
      if (item.idx === 1) await firstGate;
      return { state: 'saved', exitCode: EXIT_CODES.ok };
    },
  };

  // No controller -> default no-op (limit 1) -> sequential fast-path.
  const run = runSmokeWorker({
    promptsPath,
    limit: 2,
    maxInFlight: 1,
    adapter,
    browser: makeBrowser(calls),
    statePath,
    now: () => '2026-05-26T00:00:00.000Z',
  });

  // Let the microtasks settle: only item 1's page should be open so far.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['open:1']);

  releaseFirst();
  const exitCode = await run;

  // Strict sequential ordering: 1 opened+closed before 2 opened.
  assert.deepEqual(calls, ['open:1', 'close:1', 'open:2', 'close:2']);
  assert.equal(outcomes.length, 0); // no-op controller records nothing observable
  assert.equal(exitCode, EXIT_CODES.ok);
});

test('runSmokeWorker aggregates partial-batch exit codes regardless of finish order', async () => {
  const { promptsPath, statePath } = makeWorkspace(2);
  const calls = [];
  const outcomes = [];

  // Deferred promises: the saved item finishes AFTER the quota item to prove
  // the aggregate (exit 4) is order-independent.
  let releaseSaved;
  const savedGate = new Promise(resolve => { releaseSaved = resolve; });

  const adapter = {
    async generateOne({ item }) {
      if (item.idx === 1) {
        await savedGate;
        return { state: 'saved', exitCode: EXIT_CODES.ok };
      }
      // idx 2 hits a quota blocker immediately.
      throw new FakeFlowAdapterError('out of credits', {
        state: 'blocked_quota',
        exitCode: EXIT_CODES.quota,
        stage: 'blocked_quota',
      });
    },
  };

  const run = runSmokeWorker({
    promptsPath,
    limit: 2,
    maxInFlight: 2,
    adapter,
    browser: makeBrowser(calls),
    controller: makeController(2, outcomes),
    statePath,
    now: () => '2026-05-26T00:00:00.000Z',
  });

  // Let idx 2 (quota) settle first, then release the saved item.
  await new Promise(resolve => setTimeout(resolve, 10));
  releaseSaved();
  const exitCode = await run;

  assert.equal(exitCode, EXIT_CODES.quota);
  const results = outcomes.map(o => o.result).sort();
  assert.deepEqual(results, ['blocked', 'saved']);
});

test('runSmokeWorker writes uncorrupted state under 2 concurrent slots', async () => {
  const { promptsPath, statePath } = makeWorkspace(2);
  const calls = [];
  const outcomes = [];

  const adapter = {
    // Both resolve on near-overlapping ticks to exercise the write mutex.
    generateOne({ item }) {
      return new Promise(resolve => {
        setTimeout(() => resolve({ state: 'saved', exitCode: EXIT_CODES.ok }), item.idx === 1 ? 5 : 3);
      });
    },
  };

  await runSmokeWorker({
    promptsPath,
    limit: 2,
    maxInFlight: 2,
    adapter,
    browser: makeBrowser(calls),
    controller: makeController(2, outcomes),
    statePath,
    now: () => '2026-05-26T00:00:00.000Z',
  });

  // State file parses cleanly and contains both items in their final state.
  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw); // throws on corruption
  assert.ok(parsed.items['1']);
  assert.ok(parsed.items['2']);
  assert.equal(parsed.items['1'].state, 'saved');
  assert.equal(parsed.items['2'].state, 'saved');
});
