'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXIT_CODES,
  classifyVisibleText,
  normalizeText,
} = require('./video_errors.cjs');

test('normalizeText compacts whitespace', () => {
  assert.equal(normalizeText('  credit\n\nlimit\t reached  '), 'credit limit reached');
});

test('classifyVisibleText recognizes quota and credit blockers', () => {
  const hit = classifyVisibleText('You have reached your daily limit. Please try again tomorrow.');
  assert.equal(hit.category, 'quota');
  assert.equal(hit.state, 'blocked_quota');
  assert.equal(hit.exitCode, EXIT_CODES.quota);
});

test('classifyVisibleText recognizes subscription blockers', () => {
  const hit = classifyVisibleText('This feature is available with Google AI Ultra. Upgrade your plan to continue.');
  assert.equal(hit.category, 'subscription');
  assert.equal(hit.state, 'blocked_subscription');
  assert.equal(hit.exitCode, EXIT_CODES.quota);
});

test('classifyVisibleText recognizes policy blockers', () => {
  const hit = classifyVisibleText('We cannot generate this video because it may violate our safety policies.');
  assert.equal(hit.category, 'policy');
  assert.equal(hit.state, 'blocked_policy');
  assert.equal(hit.exitCode, EXIT_CODES.policy);
});

test('classifyVisibleText recognizes failed render tiles', () => {
  const hit = classifyVisibleText('Generation failed. Try again.');
  assert.equal(hit.category, 'failed_tile');
  assert.equal(hit.state, 'failed_ui');
  assert.equal(hit.exitCode, EXIT_CODES.ui);
});

test('classifyVisibleText recognizes Flow failed tile cards', () => {
  const hit = classifyVisibleText('warning Failed undo Reuse Prompt delete_forever Delete image 99%');
  assert.equal(hit.category, 'failed_tile');
  assert.equal(hit.state, 'failed_ui');
  assert.equal(hit.exitCode, EXIT_CODES.ui);
});

test('classifyVisibleText returns null when no blocker is visible', () => {
  assert.equal(classifyVisibleText('Generating your video. This can take a few minutes.'), null);
});
