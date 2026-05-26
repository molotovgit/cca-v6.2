'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deriveVideosDir,
  countSavedVideos,
  videoStageStatus,
  buildVideoSpawnArgs,
} = require('./video_stage.cjs');

// ── deriveVideosDir ─────────────────────────────────────────────────────────
test('deriveVideosDir maps prompts path to videos dir and strips .json', () => {
  assert.equal(
    deriveVideosDir('data/prompts/g7-uz/sub/ch01.json'),
    'data/videos/g7-uz/sub/ch01',
  );
});

test('deriveVideosDir only replaces the prompts segment, not lookalikes', () => {
  assert.equal(
    deriveVideosDir('data/prompts/prompts-archive/ch02.json'),
    'data/videos/prompts-archive/ch02',
  );
});

test('deriveVideosDir throws when prompts segment is missing', () => {
  assert.throws(() => deriveVideosDir('data/refined/g7-uz/ch01.json'), /prompts/);
});

test('deriveVideosDir throws on empty input', () => {
  assert.throws(() => deriveVideosDir(''), /required/);
});

// ── countSavedVideos / videoStageStatus (temp dir) ──────────────────────────
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'video-stage-'));
}

function writeFile(dir, name, bytes) {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0));
}

test('countSavedVideos returns 0 when dir is missing', () => {
  assert.equal(countSavedVideos(path.join(os.tmpdir(), 'does-not-exist-xyz')), 0);
});

test('countSavedVideos counts only .mp4 files at/above minBytes', () => {
  const dir = makeTempDir();
  try {
    const min = 50 * 1024;
    writeFile(dir, 'a.mp4', min);          // exactly min → counts
    writeFile(dir, 'b.mp4', min + 100);    // above min → counts
    writeFile(dir, 'c.mp4', min - 1);      // under min → excluded
    writeFile(dir, 'd.png', min + 100);    // wrong ext → excluded
    writeFile(dir, 'e.txt', min + 100);    // wrong ext → excluded
    assert.equal(countSavedVideos(dir), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countSavedVideos honors a custom minBytes', () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'a.mp4', 100);
    writeFile(dir, 'b.mp4', 200);
    assert.equal(countSavedVideos(dir, 150), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('videoStageStatus: 0 files → not done', () => {
  const dir = makeTempDir();
  try {
    const status = videoStageStatus({ videosDir: dir, total: 3 });
    assert.deepEqual(status, { have: 0, total: 3, done: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('videoStageStatus: have >= total → done', () => {
  const dir = makeTempDir();
  try {
    const min = 50 * 1024;
    writeFile(dir, 'a.mp4', min);
    writeFile(dir, 'b.mp4', min);
    writeFile(dir, 'c.mp4', min);
    const status = videoStageStatus({ videosDir: dir, total: 3 });
    assert.deepEqual(status, { have: 3, total: 3, done: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('videoStageStatus: under-size files do not count toward done', () => {
  const dir = makeTempDir();
  try {
    const min = 50 * 1024;
    writeFile(dir, 'a.mp4', min);          // counts
    writeFile(dir, 'b.mp4', min - 1);      // too small
    writeFile(dir, 'c.mp4', min - 1);      // too small
    const status = videoStageStatus({ videosDir: dir, total: 3 });
    assert.deepEqual(status, { have: 1, total: 3, done: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── buildVideoSpawnArgs ─────────────────────────────────────────────────────
test('buildVideoSpawnArgs win32 → cmd /c node with backslash path', () => {
  assert.deepEqual(buildVideoSpawnArgs('p.json', 'win32'), {
    cmd: 'cmd',
    args: ['/c', 'node', 'src\\node\\orchestrators\\run_videos_autonomous.cjs', 'p.json'],
  });
});

test('buildVideoSpawnArgs linux → node with forward-slash path', () => {
  assert.deepEqual(buildVideoSpawnArgs('p.json', 'linux'), {
    cmd: 'node',
    args: ['src/node/orchestrators/run_videos_autonomous.cjs', 'p.json'],
  });
});

test('buildVideoSpawnArgs darwin (non-win32) → node form', () => {
  assert.deepEqual(buildVideoSpawnArgs('p.json', 'darwin'), {
    cmd: 'node',
    args: ['src/node/orchestrators/run_videos_autonomous.cjs', 'p.json'],
  });
});
