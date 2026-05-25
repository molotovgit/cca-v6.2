'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_IDLE_MS,
  EXIT_TIMEOUT,
  parseCliArgs,
  shouldTimeout,
  idleTimeoutMessage,
} = require('./save_videos.cjs');

test('parseCliArgs uses env timeout in non-watch mode', () => {
  const cfg = parseCliArgs(['node', 'save_videos.cjs', 'prompts/foo.json'], {
    CCA_SAVE_VIDEOS_MAX_IDLE_MS: '12345',
  });

  assert.equal(cfg.promptsPath, 'prompts/foo.json');
  assert.equal(cfg.watchMode, false);
  assert.equal(cfg.closeTabs, true);
  assert.equal(cfg.maxIdleMs, 12345);
});

test('parseCliArgs lets CLI override env timeout', () => {
  const cfg = parseCliArgs([
    'node',
    'save_videos.cjs',
    'prompts/foo.json',
    '--no-close',
    '--max-idle-ms',
    '2500',
  ], {
    CCA_SAVE_VIDEOS_MAX_IDLE_MS: '99999',
  });

  assert.equal(cfg.closeTabs, false);
  assert.equal(cfg.maxIdleMs, 2500);
});

test('watch mode disables the idle timeout', () => {
  const cfg = parseCliArgs([
    'node',
    'save_videos.cjs',
    'prompts/foo.json',
    '--watch',
  ], {
    CCA_SAVE_VIDEOS_MAX_IDLE_MS: '2500',
  });

  assert.equal(cfg.watchMode, true);
  assert.equal(cfg.maxIdleMs, null);
});

test('shouldTimeout only fires for non-watch runs with no new saves', () => {
  const now = Date.now();

  assert.equal(shouldTimeout({
    watchMode: false,
    savedCount: 0,
    totalCount: 1,
    lastSavedAt: now - 31 * 60 * 1000,
    now,
    maxIdleMs: DEFAULT_MAX_IDLE_MS,
  }), true);

  assert.equal(shouldTimeout({
    watchMode: true,
    savedCount: 0,
    totalCount: 1,
    lastSavedAt: now - 31 * 60 * 1000,
    now,
    maxIdleMs: DEFAULT_MAX_IDLE_MS,
  }), false);

  assert.equal(shouldTimeout({
    watchMode: false,
    savedCount: 1,
    totalCount: 1,
    lastSavedAt: now - 31 * 60 * 1000,
    now,
    maxIdleMs: DEFAULT_MAX_IDLE_MS,
  }), false);
});

test('idleTimeoutMessage includes the timeout exit code', () => {
  const msg = idleTimeoutMessage({
    savedCount: 0,
    totalCount: 3,
    lastSavedAt: Date.now() - 10_000,
    maxIdleMs: 20_000,
  });

  assert.match(msg, new RegExp(`code ${EXIT_TIMEOUT}`));
  assert.match(msg, /saved 0\/3/);
});
