'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FlowAdapterError,
  awaitCompletedTile,
  buildScreenshotPath,
  findCompletedTile,
  generateOne,
  hasActiveRenderProgress,
  includesAnyText,
  normalizeDownloadResult,
  resolveDownloadHelper,
  resolveEntryUrl,
  safePart,
  verifyStartFrameAttached,
  verifyVideoMode,
} = require('./flow_adapter.cjs');

// Mock page whose evaluate() actually runs the passed function against a
// stubbed `document`/`window`, so we can exercise in-page logic directly.
function makeEvalPage(bodyText) {
  return {
    evaluate: async (fn, ...args) => {
      const prevDoc = global.document;
      const prevWin = global.window;
      global.document = { body: { innerText: bodyText } };
      global.window = { innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({}) };
      try {
        return await fn(...args);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
      }
    },
  };
}

const VIDEO_MODE_TEXT = 'Video · 4s 16:9 Generating will use 100 credits';

function videoModeSeams(overrides = {}) {
  return {
    readVideoModeText: async () => VIDEO_MODE_TEXT,
    findStartThumbnail: async () => ({ kind: 'thumbnail', source: 'start frame' }),
    ...overrides,
  };
}

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
      ...videoModeSeams(),
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
        ...videoModeSeams(),
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

// hasActiveRenderProgress percent matcher ----------------------------------

test('hasActiveRenderProgress detects in-progress percentages like 7% and 99%', async () => {
  assert.equal(await hasActiveRenderProgress(makeEvalPage('Rendering 7% complete')), true);
  assert.equal(await hasActiveRenderProgress(makeEvalPage('warning Failed Reuse Prompt Delete image 99%')), true);
  assert.equal(await hasActiveRenderProgress(makeEvalPage('Generating your video')), true);
});

test('hasActiveRenderProgress returns false without percent or a progress word', async () => {
  assert.equal(await hasActiveRenderProgress(makeEvalPage('Your video is ready to download')), false);
  // 100% alone (no generating/rendering word) is not "active" progress.
  assert.equal(await hasActiveRenderProgress(makeEvalPage('Done 100%')), false);
});

// A) verifyVideoMode --------------------------------------------------------

test('verifyVideoMode passes when video mode and positive credits are visible', async () => {
  const ok = await verifyVideoMode({}, {
    readVideoModeText: async () => 'Video · 4s 16:9 Generating will use 100 credits',
  });
  assert.equal(ok, true);
});

test('verifyVideoMode throws when Flow is still in image mode (0 credits)', async () => {
  await assert.rejects(
    () => verifyVideoMode({}, {
      readVideoModeText: async () => 'Nano Banana 2 Generating will use 0 credits',
    }),
    (err) => {
      assert.equal(err instanceof FlowAdapterError, true);
      assert.equal(err.state, 'failed_ui');
      assert.equal(err.stage, 'verify_video_mode');
      assert.match(err.message, /still in image mode/i);
      return true;
    }
  );
});

test('verifyVideoMode throws when video-mode confirmation is absent', async () => {
  await assert.rejects(
    () => verifyVideoMode({}, {
      readVideoModeText: async () => 'Generating will use 100 credits',
    }),
    (err) => {
      assert.equal(err.state, 'failed_ui');
      assert.equal(err.stage, 'verify_video_mode');
      return true;
    }
  );
});

test('generateOne throws when the model dropdown stayed in image mode', async () => {
  const dir = tempDir('flow-imgmode-');
  const imagePath = path.join(dir, '001-demo.png');
  fs.writeFileSync(imagePath, Buffer.alloc(1024));
  const calls = [];
  const page = makePage(calls, {
    fileInput: { uploadFile: async () => {} },
  });

  await assert.rejects(
    () => generateOne({
      page,
      item: { idx: 1, slug: 'demo' },
      motion: 'slow camera orbit around the subject',
      imagePath,
      videoPath: path.join(dir, '001-demo.mp4'),
      options: {
        classifyPage: async () => null,
        readVideoModeText: async () => 'Nano Banana 2 Generating will use 0 credits',
      },
    }),
    (err) => {
      assert.equal(err.state, 'failed_ui');
      assert.equal(err.stage, 'verify_video_mode');
      return true;
    }
  );
});

// B) verifyStartFrameAttached ----------------------------------------------

test('verifyStartFrameAttached returns the thumbnail when the Start slot is filled', async () => {
  const thumb = await verifyStartFrameAttached({}, {
    findStartThumbnail: async () => ({ kind: 'filename', text: 'demo.png' }),
  });
  assert.deepEqual(thumb, { kind: 'filename', text: 'demo.png' });
});

test('generateOne throws when the start frame never attaches to the Start slot', async () => {
  const dir = tempDir('flow-noframe-');
  const imagePath = path.join(dir, '001-demo.png');
  fs.writeFileSync(imagePath, Buffer.alloc(1024));
  const calls = [];
  const page = makePage(calls, {
    fileInput: { uploadFile: async () => {} },
  });

  await assert.rejects(
    () => generateOne({
      page,
      item: { idx: 1, slug: 'demo' },
      motion: 'slow camera orbit around the subject',
      imagePath,
      videoPath: path.join(dir, '001-demo.mp4'),
      options: {
        classifyPage: async () => null,
        readVideoModeText: async () => 'Video · 4s 16:9 Generating will use 100 credits',
        findStartThumbnail: async () => null,
      },
    }),
    (err) => {
      assert.equal(err instanceof FlowAdapterError, true);
      assert.equal(err.state, 'failed_ui');
      assert.equal(err.stage, 'verify_start_frame');
      assert.match(err.message, /start frame did not attach/i);
      return true;
    }
  );
});

// C) unknown completed-tile/download seam ----------------------------------

test('findCompletedTile default seam throws the documented live-discovery error', async () => {
  await assert.rejects(
    () => findCompletedTile({}, {}),
    (err) => {
      assert.equal(err instanceof FlowAdapterError, true);
      assert.equal(err.state, 'failed_download');
      assert.equal(err.stage, 'await_completed_tile');
      assert.match(err.message, /needs live discovery/i);
      return true;
    }
  );
});

test('awaitCompletedTile surfaces the unknown-selector error after reload attempts', async () => {
  const calls = [];
  const page = {
    url: () => 'https://labs.google/fx/tools/flow/project/test',
    goto: async (url) => { calls.push(['goto', url]); },
    waitForFunction: async () => true,
    evaluate: async () => '',
    mouse: { click: async () => {} },
    screenshot: async (opts) => {
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
      fs.writeFileSync(opts.path, 'shot');
    },
  };
  const dir = tempDir('flow-unknown-');

  await assert.rejects(
    () => awaitCompletedTile(page, {
      screenshotsDir: dir,
      item: { idx: 1, slug: 'demo' },
      classifyPage: async () => null,
      findDownloadTarget: async () => null,
      timeoutMs: 1,
      pollMs: 1,
      reloadAttempts: 2,
      reloadDelayMs: 0,
      readySettleMs: 0,
      rescanSettleMs: 0,
    }),
    (err) => {
      assert.equal(err.state, 'failed_download');
      assert.equal(err.stage, 'await_completed_tile');
      assert.match(err.message, /needs live discovery/i);
      return true;
    }
  );
  assert.equal(calls.filter(entry => entry[0] === 'goto').length, 2);
});

// D) failed card is non-terminal: reload + rescan recovers -----------------

test('awaitCompletedTile recovers when a failed card precedes a reloaded completed tile', async () => {
  const calls = [];
  let reloaded = false;
  const page = {
    url: () => 'https://labs.google/fx/tools/flow/project/test',
    goto: async (url) => { calls.push(['goto', url]); reloaded = true; },
    waitForFunction: async () => true,
    evaluate: async () => '',
    mouse: { click: async () => {} },
    screenshot: async (opts) => {
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
      fs.writeFileSync(opts.path, 'shot');
    },
  };

  const target = await awaitCompletedTile(page, {
    item: { idx: 1, slug: 'demo' },
    // Live view shows the advisory failed card, never a target.
    classifyPage: async () => ({
      category: 'failed_tile',
      state: 'failed_ui',
      exitCode: 3,
      reason: 'provider reported failed render tile',
    }),
    findDownloadTarget: async () => null,
    failedTileGraceMs: 0,
    timeoutMs: 50,
    pollMs: 1,
    reloadAttempts: 2,
    reloadDelayMs: 0,
    rescanSettleMs: 0,
    readySettleMs: 0,
    openVideosTab: async () => { calls.push(['videosTab']); },
    // After reload + Videos tab, a real completed tile appears.
    findCompletedTile: async () => (reloaded ? { kind: 'tile', src: 'blob:final' } : null),
  });

  assert.deepEqual(target, { kind: 'tile', src: 'blob:final' });
  assert.equal(calls.some(entry => entry[0] === 'goto'), true);
  assert.equal(calls.some(entry => entry[0] === 'videosTab'), true);
});

test('generateOne completes via reload/rescan after a failed card and downloads the tile', async () => {
  const dir = tempDir('flow-reload-');
  const imagePath = path.join(dir, '001-demo.png');
  const videoPath = path.join(dir, '001-demo.mp4');
  fs.writeFileSync(imagePath, Buffer.alloc(1024));

  const calls = [];
  let reloadCount = 0;
  const page = {
    url: () => 'https://labs.google/fx/tools/flow/project/test',
    goto: async (url, opts) => { calls.push(['goto', url, opts]); reloadCount += 1; },
    $: async () => ({ uploadFile: async (f) => { calls.push(['uploadFile', f]); } }),
    waitForFunction: async () => true,
    evaluate: async () => '',
    screenshot: async (opts) => {
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
      fs.writeFileSync(opts.path, 'shot');
    },
    mouse: { click: async (x, y) => { calls.push(['click', x, y]); } },
    keyboard: { type: async (text) => { calls.push(['type', text]); } },
  };

  const result = await generateOne({
    page,
    item: { idx: 1, slug: 'demo' },
    motion: 'slow camera orbit around the subject',
    imagePath,
    videoPath,
    options: {
      flowUrl: 'https://labs.google/fx/tools/flow',
      ...videoModeSeams(),
      // Advisory failed card on the live view; never resolves there.
      classifyPage: async () => ({
        category: 'failed_tile',
        state: 'failed_ui',
        exitCode: 3,
        reason: 'provider reported failed render tile',
      }),
      findPromptControl: async () => ({ x: 20, y: 30 }),
      findSubmitControl: async () => ({ x: 40, y: 50 }),
      findDownloadTarget: async () => null,
      failedTileGraceMs: 0,
      timeoutMs: 50,
      pollMs: 1,
      reloadAttempts: 2,
      reloadDelayMs: 0,
      rescanSettleMs: 0,
      readySettleMs: 0,
      openVideosTab: async () => { calls.push(['videosTab']); },
      findCompletedTile: async () => (reloadCount > 1 ? { kind: 'tile', src: 'blob:final' } : null),
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
  // initial goto + at least one reload goto
  assert.equal(reloadCount >= 2, true);
  assert.deepEqual(calls.find(entry => entry[0] === 'download'), ['download', { kind: 'tile', src: 'blob:final' }]);
});

test('awaitCompletedTile concludes failure only after reload finds no tile', async () => {
  const calls = [];
  const page = {
    url: () => 'https://labs.google/fx/tools/flow/project/test',
    goto: async (url) => { calls.push(['goto', url]); },
    waitForFunction: async () => true,
    evaluate: async () => '',
    mouse: { click: async () => {} },
    screenshot: async (opts) => {
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
      fs.writeFileSync(opts.path, 'shot');
    },
  };
  const dir = tempDir('flow-stillfailed-');

  await assert.rejects(
    () => awaitCompletedTile(page, {
      screenshotsDir: dir,
      item: { idx: 1, slug: 'demo' },
      classifyPage: async () => ({
        category: 'failed_tile',
        state: 'failed_ui',
        exitCode: 3,
        reason: 'provider reported failed render tile',
      }),
      findDownloadTarget: async () => null,
      failedTileGraceMs: 0,
      timeoutMs: 50,
      pollMs: 1,
      reloadAttempts: 2,
      reloadDelayMs: 0,
      rescanSettleMs: 0,
      readySettleMs: 0,
      openVideosTab: async () => {},
      findCompletedTile: async () => null,
    }),
    (err) => {
      assert.equal(err instanceof FlowAdapterError, true);
      assert.equal(err.state, 'failed_ui');
      assert.equal(err.stage, 'await_completed_tile');
      assert.match(err.message, /no completed tile after reload/i);
      return true;
    }
  );
  // Reload happened before concluding failure.
  assert.equal(calls.some(entry => entry[0] === 'goto'), true);
});
