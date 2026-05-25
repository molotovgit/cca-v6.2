'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  DEFAULT_MIN_VIDEO_BYTES,
  readVideoStateFile,
  reconcileVideoState,
} = require('../../src/node/video/video_state.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cca-video-state-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('readVideoStateFile returns null for missing or corrupt files', () => {
  const tmp = makeTempDir();
  const missingPath = path.join(tmp, 'missing.json');
  const corruptPath = path.join(tmp, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{not valid json');

  assert.equal(readVideoStateFile(missingPath), null);
  assert.equal(readVideoStateFile(corruptPath), null);
});

test('reconcileVideoState rebuilds item state from disk and writes atomically', () => {
  const root = makeTempDir();
  const promptsPath = path.join(root, 'data', 'prompts', 'g7-uz', 'subject', 'ch01-title.json');
  const imagesDir = path.join(root, 'data', 'images', 'g7-uz', 'subject', 'ch01-title');
  const videosDir = path.join(root, 'data', 'videos', 'g7-uz', 'subject', 'ch01-title');
  const statePath = path.join(root, 'data', '.cca', 'video_state.json');

  fs.mkdirSync(path.dirname(promptsPath), { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(videosDir, { recursive: true });

  const prompts = [
    { idx: 1, slug: 'alpha' },
    { idx: 2, slug: 'bravo' },
    { idx: 3, slug: 'charlie' },
  ];
  writeJson(promptsPath, prompts);

  const savedVideo = path.join(videosDir, '001-alpha.mp4');
  fs.writeFileSync(path.join(imagesDir, '001-alpha.png'), Buffer.alloc(16));
  fs.writeFileSync(savedVideo, Buffer.alloc(DEFAULT_MIN_VIDEO_BYTES + 1));

  fs.writeFileSync(path.join(imagesDir, '003-charlie.png'), Buffer.alloc(16));
  writeJson(statePath, {
    version: 1,
    mode: 'flow',
    promptsPath: 'old/prompts.json',
    imagesDir: 'old/images',
    videosDir: 'old/videos',
    activeProvider: 'flow',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: {
      3: {
        idx: 3,
        slug: 'charlie',
        imagePath: 'old/images/003-charlie.png',
        videoPath: 'old/videos/003-charlie.mp4',
        state: 'submitted',
        attempts: 2,
        accountLabel: 'acct-a',
        flowProjectUrl: 'https://example.test/project',
        tabId: 'tab-123',
        submittedAt: '2026-01-01T00:01:00.000Z',
        savedAt: null,
        lastError: 'waiting for render',
        lastScreenshot: '/tmp/snap.png',
      },
    },
  });

  const before = fs.readdirSync(path.dirname(statePath));
  const state = reconcileVideoState({
    promptsPath,
    imagesDir,
    videosDir,
    statePath,
    minVideoBytes: 1024,
    now: '2026-05-26T00:00:00.000Z',
  });
  const after = fs.readdirSync(path.dirname(statePath));

  assert.deepEqual(before.filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual(after.filter(name => name.endsWith('.tmp')), []);
  assert.equal(state.version, 1);
  assert.equal(state.promptsPath, promptsPath);
  assert.equal(state.imagesDir, imagesDir);
  assert.equal(state.videosDir, videosDir);
  assert.equal(state.updatedAt, '2026-05-26T00:00:00.000Z');

  assert.equal(state.items['1'].state, 'saved');
  assert.equal(state.items['1'].videoPath, savedVideo);
  assert.equal(state.items['1'].lastError, null);
  assert.equal(state.items['1'].savedAt, '2026-05-26T00:00:00.000Z');

  assert.equal(state.items['2'].state, 'failed_missing_asset');
  assert.match(state.items['2'].lastError, /missing source image/);

  assert.equal(state.items['3'].state, 'submitted');
  assert.equal(state.items['3'].attempts, 2);
  assert.equal(state.items['3'].tabId, 'tab-123');
  assert.equal(state.items['3'].lastError, 'waiting for render');

  const onDisk = readVideoStateFile(statePath);
  assert.equal(onDisk.items['1'].state, 'saved');
  assert.equal(onDisk.items['2'].state, 'failed_missing_asset');
  assert.equal(onDisk.items['3'].state, 'submitted');
});
