'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  deriveFlowDirs,
  motionForItem,
  parseCliArgs,
  selectEligibleItems,
  validateSmokeConfig,
} = require('./submit_flow_videos.cjs');

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

test('validateSmokeConfig rejects max-in-flight above one', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-submit-'));
  const promptsPath = path.join(tmpDir, 'prompts.json');
  fs.writeFileSync(promptsPath, '[]');

  assert.throws(() => validateSmokeConfig({
    promptsPath,
    limit: 1,
    maxInFlight: 2,
  }), /max-in-flight 1/);
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
