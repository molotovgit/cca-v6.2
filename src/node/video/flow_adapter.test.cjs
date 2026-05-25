'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FlowAdapterError,
  buildScreenshotPath,
  generateOne,
  includesAnyText,
  normalizeDownloadResult,
  resolveDownloadHelper,
  resolveEntryUrl,
  safePart,
} = require('./flow_adapter.cjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makePage(calls, overrides = {}) {
  return {
    url: () => 'https://labs.google/fx/tools/flow/project/test',
    goto: async (url, opts) => {
      calls.push(['goto', url, opts]);
    },
    $: async (selector) => {
      calls.push(['query', selector]);
      return overrides.fileInput || null;
    },
    screenshot: async (opts) => {
      calls.push(['screenshot', opts.path]);
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
      fs.writeFileSync(opts.path, 'shot');
    },
    mouse: {
      click: async (x, y) => {
        calls.push(['click', x, y]);
      },
    },
    keyboard: {
      type: async (text) => {
        calls.push(['type', text]);
      },
    },
  };
}

test('selector helpers are stable and sanitized', () => {
  assert.equal(resolveEntryUrl({ flowUrl: 'https://labs.google/fx/tools/flow', projectUrl: 'https://labs.google/fx/tools/flow/project/abc' }), 'https://labs.google/fx/tools/flow/project/abc');
  assert.equal(includesAnyText('Upload your image now', ['upload', 'save']), true);
  assert.equal(includesAnyText('Nothing to see here', ['upload', 'save']), false);
  assert.equal(safePart('  Lesson: Intro / Motion  ', 'item'), 'lesson-intro-motion');
  assert.equal(normalizeDownloadResult({ path: '/tmp/out.mp4' }, '/tmp/fallback.mp4'), '/tmp/out.mp4');
});

test('buildScreenshotPath creates readable file names', () => {
  const dir = tempDir('flow-shot-');
  const shot = buildScreenshotPath({
    screenshotsDir: dir,
    item: { idx: 7, slug: 'chapter-one' },
    stage: 'submit_generation',
  });
  assert.match(path.basename(shot), /^007-chapter-one-submit_generation-/);
});

test('resolveDownloadHelper late-binds the video_download export', () => {
  const dir = tempDir('flow-helper-');
  const helperFile = path.join(dir, 'video_download.cjs');
  fs.writeFileSync(helperFile, `
    'use strict';
    module.exports = {
      downloadMp4ToFile: async () => ({ filePath: '/tmp/out.mp4' }),
    };
  `);

  const helper = resolveDownloadHelper({ downloadModulePath: helperFile });
  assert.equal(typeof helper, 'function');
});

test('generateOne saves one MP4 on the happy path', async () => {
  const dir = tempDir('flow-happy-');
  const imagePath = path.join(dir, '001-demo.png');
  const videoPath = path.join(dir, '001-demo.mp4');
  fs.writeFileSync(imagePath, Buffer.alloc(1024));

  const calls = [];
  const page = makePage(calls, {
    fileInput: {
      uploadFile: async (files) => {
        calls.push(['uploadFile', files]);
      },
    },
  });

  const result = await generateOne({
    page,
    item: { idx: 1, slug: 'demo' },
    motion: 'slow camera orbit around the subject',
    imagePath,
    videoPath,
    options: {
      flowUrl: 'https://labs.google/fx/tools/flow',
      classifyPage: async () => null,
      findPromptControl: async () => ({ x: 20, y: 30 }),
      findSubmitControl: async () => ({ x: 40, y: 50 }),
      findDownloadTarget: async () => ({ kind: 'video', src: 'blob:rendered' }),
      downloadVideo: async ({ videoPath: outPath, target }) => {
        calls.push(['download', target]);
        fs.writeFileSync(outPath, Buffer.alloc(64 * 1024));
        return { path: outPath };
      },
      minVideoBytes: 50 * 1024,
    },
  });

  assert.equal(result.state, 'saved');
  assert.equal(result.videoPath, videoPath);
  assert.equal(fs.statSync(videoPath).size >= 50 * 1024, true);
  assert.deepEqual(calls[0][0], 'goto');
  assert.deepEqual(calls.find(entry => entry[0] === 'uploadFile'), ['uploadFile', imagePath]);
  assert.deepEqual(calls.find(entry => entry[0] === 'type'), ['type', 'slow camera orbit around the subject']);
  assert.deepEqual(calls.find(entry => entry[0] === 'download'), ['download', { kind: 'video', src: 'blob:rendered' }]);
});

test('generateOne captures a screenshot and throws on a visible blocker', async () => {
  const dir = tempDir('flow-blocked-');
  const imagePath = path.join(dir, '001-demo.png');
  fs.writeFileSync(imagePath, Buffer.alloc(1024));
  const screenshotDir = path.join(dir, 'shots');
  const calls = [];
  const page = makePage(calls);

  await assert.rejects(
    () => generateOne({
      page,
      item: { idx: 1, slug: 'demo' },
      motion: 'slow camera orbit around the subject',
      imagePath,
      videoPath: path.join(dir, '001-demo.mp4'),
      options: {
        screenshotsDir: screenshotDir,
        classifyPage: async () => ({
          category: 'policy',
          state: 'blocked_policy',
          exitCode: 5,
          reason: 'policy block',
        }),
      },
    }),
    (err) => {
      assert.equal(err instanceof FlowAdapterError, true);
      assert.equal(err.state, 'blocked_policy');
      assert.equal(err.exitCode, 5);
      assert.ok(err.screenshotPath);
      assert.equal(fs.existsSync(err.screenshotPath), true);
      return true;
    }
  );

  assert.equal(calls.some(entry => entry[0] === 'screenshot'), true);
});
