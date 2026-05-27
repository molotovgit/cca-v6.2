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
  ensureProjectComposer,
  findCompletedTile,
  generateOne,
  hasActiveRenderProgress,
  includesAnyText,
  normalizeDownloadResult,
  resolveDownloadHelper,
  resolveEntryUrl,
  safePart,
  findStartFrameDropTarget,
  findStartThumbnail,
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
  const page = makePage(calls);

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
      findUploadControl: async () => ({ x: 10, y: 11 }),
      waitForMediaPickerDialog: async () => true,
      dismissUploadNotice: false,
      uploadMediaThroughPicker: async (_page, uploadedPath) => {
        calls.push(['pickerUpload', uploadedPath]);
        return { mode: 'dialog-file-chooser' };
      },
      selectUploadedMediaTile: async (_page, uploadedPath) => {
        calls.push(['selectUploadedTile', path.basename(uploadedPath)]);
        return { x: 12, y: 13 };
      },
      addUploadedMediaToPrompt: async () => {
        calls.push(['addToPrompt']);
        return { x: 14, y: 15 };
      },
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
  assert.deepEqual(calls.find(entry => entry[0] === 'pickerUpload'), ['pickerUpload', imagePath]);
  assert.deepEqual(calls.find(entry => entry[0] === 'selectUploadedTile'), ['selectUploadedTile', '001-demo.png']);
  assert.deepEqual(calls.find(entry => entry[0] === 'addToPrompt'), ['addToPrompt']);
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

test('verifyVideoMode passes on a fresh composer that shows no credits text yet', async () => {
  // A fresh project defaults to "Video · 4s 16:9 1x"; the "generating will use N
  // credits" string only appears once a start frame + prompt are staged, which
  // is after this pre-upload check. The toggle alone must be enough.
  const ok = await verifyVideoMode({}, {
    readVideoModeText: async () => 'Video · 4s crop_16_9 1x Start creating or drop media',
  });
  assert.equal(ok, true);
});

test('verifyVideoMode throws when Flow surfaces an explicit zero credit cost in video mode', async () => {
  await assert.rejects(
    () => verifyVideoMode({}, {
      readVideoModeText: async () => 'Video · 4s 16:9 Generating will use 0 credits',
    }),
    (err) => {
      assert.equal(err.state, 'failed_ui');
      assert.equal(err.stage, 'verify_video_mode');
      assert.match(err.message, /0 credits/i);
      return true;
    }
  );
});

// A2) ensureProjectComposer -------------------------------------------------

test('ensureProjectComposer is a no-op when already inside a project composer', async () => {
  const calls = [];
  const page = {
    url: () => 'https://labs.google/fx/tools/flow/project/abc123',
    evaluate: async () => { calls.push('evaluate'); return null; },
    mouse: { click: async () => { calls.push('click'); } },
  };
  const out = await ensureProjectComposer(page, {});
  assert.match(out, /\/project\/abc123/);
  assert.deepEqual(calls, []); // never tried to click "New project"
});

test('ensureProjectComposer clicks New project from the dashboard and returns the composer url', async () => {
  let navigated = false;
  const calls = [];
  const page = {
    url: () => navigated
      ? 'https://labs.google/fx/tools/flow/project/new789'
      : 'https://labs.google/fx/tools/flow',
    // clickVisibleButton evaluate: return a clickable target for /new project/i
    evaluate: async () => ({ x: 12, y: 34, text: 'New project', area: 999 }),
    mouse: { click: async (x, y) => { calls.push(['click', x, y]); navigated = true; } },
    waitForFunction: async () => true,
  };
  const out = await ensureProjectComposer(page, { readyTimeoutMs: 10, readySettleMs: 0 });
  assert.match(out, /\/project\/new789/);
  assert.ok(calls.some((c) => c[0] === 'click'), 'should click the New project control');
});

test('ensureProjectComposer honours the disable seam', async () => {
  const out = await ensureProjectComposer({ url: () => 'https://labs.google/fx/tools/flow' }, {
    ensureProjectComposer: false,
  });
  assert.equal(out, null);
});

test('generateOne throws when the model dropdown stayed in image mode', async () => {
  const dir = tempDir('flow-imgmode-');
  const imagePath = path.join(dir, '001-demo.png');
  fs.writeFileSync(imagePath, Buffer.alloc(1024));
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

function makeElement({ text = '', attrs = {}, rect = {}, children = [], parent = null }) {
  const el = {
    textContent: text,
    parentElement: parent,
    children,
    getAttribute: (name) => attrs[name] || null,
    getBoundingClientRect: () => ({
      left: rect.left ?? 0,
      top: rect.top ?? 0,
      width: rect.width ?? 50,
      height: rect.height ?? 50,
      bottom: (rect.top ?? 0) + (rect.height ?? 50),
      right: (rect.left ?? 0) + (rect.width ?? 50),
    }),
    querySelector: (selector) => {
      if (!/img|video|background-image/.test(selector)) return null;
      return children.find(child => child.kind === 'thumb') || null;
    },
  };
  for (const child of children) child.parentElement = el;
  return el;
}

function makeElementsPage(elements) {
  return {
    evaluate: async (fn, ...args) => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevElement = global.Element;
      global.Element = function Element() {};
      const flatten = (items) => items.flatMap(el => [el, ...(el.children ? flatten(el.children) : [])]);
      const all = flatten(elements);
      for (const el of all) Object.setPrototypeOf(el, global.Element.prototype);
      global.document = { querySelectorAll: () => elements.slice() };
      global.window = {
        innerWidth: 1920,
        innerHeight: 963,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      };
      try {
        return await fn(...args);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.Element = prevElement;
      }
    },
  };
}

test('findStartFrameDropTarget finds the real compact Start chip', async () => {
  const fullViewport = makeElement({ text: 'Start creating or drop media', rect: { width: 1920, height: 963 } });
  const start = makeElement({ text: 'Start', rect: { left: 670, top: 800, width: 50, height: 50 } });
  const target = await findStartFrameDropTarget(makeElementsPage([fullViewport, start]));
  assert.equal(target.text, 'start');
  assert.equal(target.width, 50);
  assert.equal(target.height, 50);
});

test('findStartThumbnail rejects full-viewport Start matches with unrelated images', async () => {
  const thumb = makeElement({ attrs: { src: 'unrelated.png' }, rect: { left: 20, top: 20, width: 100, height: 60 } });
  thumb.kind = 'thumb';
  const fullViewport = makeElement({
    text: 'Start creating or drop media',
    rect: { width: 1920, height: 963 },
    children: [thumb],
  });
  assert.equal(await findStartThumbnail(makeElementsPage([fullViewport])), null);
});

test('findStartThumbnail accepts a real thumbnail near the compact Start chip', async () => {
  const thumb = makeElement({ attrs: { src: '001-demo.png' }, rect: { width: 42, height: 42 } });
  thumb.kind = 'thumb';
  const start = makeElement({ text: 'Start', rect: { width: 50, height: 50 }, children: [thumb] });
  assert.deepEqual(await findStartThumbnail(makeElementsPage([start])), {
    kind: 'thumbnail',
    source: 'start slot',
  });
});

test('generateOne throws when the start frame never attaches to the Start slot', async () => {
  const dir = tempDir('flow-noframe-');
  const imagePath = path.join(dir, '001-demo.png');
  fs.writeFileSync(imagePath, Buffer.alloc(1024));
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
        classifyPage: async () => null,
        readVideoModeText: async () => 'Video · 4s 16:9 Generating will use 100 credits',
        findUploadControl: async () => ({ x: 10, y: 11 }),
        waitForMediaPickerDialog: async () => true,
        dismissUploadNotice: false,
        uploadMediaThroughPicker: async () => ({ mode: 'dialog-file-chooser' }),
        selectUploadedMediaTile: async () => ({ x: 12, y: 13 }),
        addUploadedMediaToPrompt: async () => ({ x: 14, y: 15 }),
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

// LIVE (flow_probe): a completed tile is a visible <video> whose src is the
// media.getMediaUrlRedirect endpoint. Build an eval page exposing a stubbed
// <video> DOM so the default scan can run in-process.
function makeVideoDomPage(videos) {
  const makeEl = (v) => ({
    currentSrc: v.currentSrc || '',
    src: v.src || '',
    getBoundingClientRect: () => ({
      left: v.left ?? 10,
      top: v.top ?? 20,
      width: v.width ?? 320,
      height: v.height ?? 180,
      bottom: (v.top ?? 20) + (v.height ?? 180),
      right: (v.left ?? 10) + (v.width ?? 320),
    }),
    querySelector: (sel) => (sel === 'source[src]' && v.sourceSrc ? { src: v.sourceSrc } : null),
  });
  const els = videos.map(makeEl);
  // Tag each element so `instanceof Element` passes inside the evaluate body.
  return {
    evaluate: async (fn, ...args) => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevElement = global.Element;
      global.Element = function Element() {};
      for (const el of els) Object.setPrototypeOf(el, global.Element.prototype);
      global.document = {
        querySelectorAll: (sel) => (sel === 'video' ? els.slice() : []),
      };
      global.window = { innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({}) };
      try {
        return await fn(...args);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.Element = prevElement;
      }
    },
  };
}

test('findCompletedTile returns the media.getMediaUrlRedirect <video src> from the page DOM', async () => {
  const src = 'https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=11111111-2222-3333-4444-555555555555';
  const page = makeVideoDomPage([{ src, left: 100, top: 200, width: 320, height: 180 }]);

  const tile = await findCompletedTile(page, {});
  assert.deepEqual(tile, { kind: 'video', src, x: 260, y: 290 });
});

test('findCompletedTile prefers currentSrc and reads source[src] for the redirect <video>', async () => {
  const src = 'https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  // A bare <video> with no src/currentSrc but a matching <source src>.
  const page = makeVideoDomPage([{ sourceSrc: src, left: 0, top: 0, width: 200, height: 100 }]);

  const tile = await findCompletedTile(page, {});
  assert.equal(tile.kind, 'video');
  assert.equal(tile.src, src);
});

test('findCompletedTile falls back to the live-discovery throw when no matching <video> is present', async () => {
  // A visible <video>, but its src is not the getMediaUrlRedirect endpoint.
  const page = makeVideoDomPage([{ src: 'blob:https://labs.google/fx/preview-not-complete' }]);

  await assert.rejects(
    () => findCompletedTile(page, {}),
    (err) => {
      assert.equal(err instanceof FlowAdapterError, true);
      assert.equal(err.state, 'failed_download');
      assert.equal(err.stage, 'await_completed_tile');
      assert.match(err.message, /needs live discovery/i);
      return true;
    }
  );
});

test('awaitCompletedTile resolves the default redirect <video> after a reload rescan', async () => {
  const src = 'https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=99999999-8888-7777-6666-555555555555';
  let reloaded = false;
  const videoPage = makeVideoDomPage([{ src, left: 50, top: 60, width: 320, height: 180 }]);
  const calls = [];
  const page = {
    url: () => 'https://labs.google/fx/tools/flow/project/test',
    goto: async (url) => { calls.push(['goto', url]); reloaded = true; },
    waitForFunction: async () => true,
    // Before reload: live view exposes no completed <video>; after reload the
    // Videos tab DOM has the real redirect <video>, so the default scan finds it.
    evaluate: async (fn, ...args) => (reloaded ? videoPage.evaluate(fn, ...args) : ''),
    mouse: { click: async () => {} },
    screenshot: async (opts) => {
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
      fs.writeFileSync(opts.path, 'shot');
    },
  };

  const target = await awaitCompletedTile(page, {
    item: { idx: 1, slug: 'demo' },
    classifyPage: async () => null,
    findDownloadTarget: async () => null,
    timeoutMs: 1,
    pollMs: 1,
    reloadAttempts: 2,
    reloadDelayMs: 0,
    rescanSettleMs: 0,
    readySettleMs: 0,
    openVideosTab: async () => { calls.push(['videosTab']); },
  });

  assert.deepEqual(target, { kind: 'video', src, x: 210, y: 150 });
  assert.equal(calls.some(entry => entry[0] === 'goto'), true);
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
      findUploadControl: async () => ({ x: 10, y: 11 }),
      waitForMediaPickerDialog: async () => true,
      dismissUploadNotice: false,
      uploadMediaThroughPicker: async (_page, uploadedPath) => {
        calls.push(['pickerUpload', uploadedPath]);
        return { mode: 'dialog-file-chooser' };
      },
      selectUploadedMediaTile: async () => ({ x: 12, y: 13 }),
      addUploadedMediaToPrompt: async () => ({ x: 14, y: 15 }),
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
