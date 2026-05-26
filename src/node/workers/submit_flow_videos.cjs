'use strict';

const fs = require('fs');
const path = require('path');

const { EXIT_CODES, classifyVisibleText } = require('../video/video_errors.cjs');
const { reconcileVideoState, resolvePathForFs, writeVideoStateFile } = require('../video/video_state.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_STATE_PATH = path.join(REPO_ROOT, 'data', '.cca', 'video_state.json');
const DEFAULT_CDP_PORT = parseInt(process.env.GEMINI_CDP_PORT || process.env.FLOW_CDP_PORT || '9223', 10);
const ALLOWED_RETRY_STATES = new Set(['pending', 'failed_timeout', 'failed_ui', 'failed_download']);
const EXIT_PRIORITY = new Map([
  [EXIT_CODES.ok, 0],
  [EXIT_CODES.generic, 10],
  [EXIT_CODES.missingAsset, 20],
  [EXIT_CODES.ui, 30],
  [EXIT_CODES.timeout, 40],
  [EXIT_CODES.quota, 50],
  [EXIT_CODES.policy, 60],
  [EXIT_CODES.preflight, 100],
]);

function parsePositiveInt(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseCliArgs(argv = process.argv) {
  const args = argv.slice(2);
  const promptsPath = args[0] && !String(args[0]).startsWith('--') ? args[0] : null;
  let limit = 1;
  let maxInFlight = 1;

  for (let i = promptsPath ? 1 : 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--limit') {
      limit = parsePositiveInt(args[i + 1], limit);
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = parsePositiveInt(arg.split('=', 2)[1], limit);
      continue;
    }
    if (arg === '--max-in-flight') {
      maxInFlight = parsePositiveInt(args[i + 1], maxInFlight);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-in-flight=')) {
      maxInFlight = parsePositiveInt(arg.split('=', 2)[1], maxInFlight);
    }
  }

  return { promptsPath, limit, maxInFlight };
}

function deriveFlowDirs(promptsPath) {
  const abs = path.resolve(promptsPath);
  const parts = abs.split(path.sep);
  const promptsIdx = parts.indexOf('prompts');
  if (promptsIdx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);

  const imagesParts = parts.slice();
  const videosParts = parts.slice();
  imagesParts[promptsIdx] = 'images';
  videosParts[promptsIdx] = 'videos';
  imagesParts[imagesParts.length - 1] = imagesParts[imagesParts.length - 1].replace(/\.json$/i, '');
  videosParts[videosParts.length - 1] = videosParts[videosParts.length - 1].replace(/\.json$/i, '');

  return {
    promptsAbs: abs,
    imagesDir: imagesParts.join(path.sep),
    videosDir: videosParts.join(path.sep),
  };
}

function validateSmokeConfig({ promptsPath, limit, maxInFlight, ceiling = 4, smoke = false }) {
  if (!promptsPath) {
    const err = new Error('Usage: node submit_flow_videos.cjs <prompts.json> [--limit N] [--max-in-flight 1]');
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (!fs.existsSync(promptsPath)) {
    const err = new Error(`prompts file not found: ${promptsPath}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (!Number.isFinite(limit) || limit < 1) {
    const err = new Error(`--limit must be a positive integer; got ${limit}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (!Number.isFinite(maxInFlight) || maxInFlight < 1) {
    const err = new Error(`--max-in-flight must be a positive integer; got ${maxInFlight}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  if (smoke === true) {
    // Smoke phase is single-flight only: one tab, one clip at a time.
    if (maxInFlight > 1) {
      const err = new Error(`smoke phase only supports --max-in-flight 1; got ${maxInFlight}`);
      err.code = EXIT_CODES.preflight;
      throw err;
    }
  } else if (maxInFlight > ceiling) {
    const err = new Error(`--max-in-flight must be <= ${ceiling}; got ${maxInFlight}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  return { promptsPath, limit, maxInFlight };
}

function isRetryableState(state) {
  return ALLOWED_RETRY_STATES.has(state);
}

function selectEligibleItems(state, limit) {
  const items = Object.values(state && state.items ? state.items : {})
    .filter(Boolean)
    .sort((a, b) => {
      const idxA = Number.isInteger(a.idx) ? a.idx : Number.MAX_SAFE_INTEGER;
      const idxB = Number.isInteger(b.idx) ? b.idx : Number.MAX_SAFE_INTEGER;
      return idxA - idxB;
    });

  const eligible = items.filter(item => isRetryableState(item.state));
  const selected = eligible.slice(0, limit);
  const skipped = items.filter(item => !isRetryableState(item.state));

  return {
    selected,
    eligible,
    skipped,
    counts: items.reduce((acc, item) => {
      const key = item.state || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

function determineNoWorkExitCode(state) {
  const counts = (state && state.items ? Object.values(state.items) : []).reduce((acc, item) => {
    const key = item && item.state ? item.state : 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  if (counts.blocked_policy) return EXIT_CODES.policy;
  if (counts.blocked_quota || counts.blocked_subscription) return EXIT_CODES.quota;
  if (counts.failed_missing_asset) return EXIT_CODES.missingAsset;
  return EXIT_CODES.ok;
}

function stateFromExitCode(exitCode) {
  switch (exitCode) {
    case EXIT_CODES.ok:
      return 'saved';
    case EXIT_CODES.ui:
      return 'failed_ui';
    case EXIT_CODES.quota:
      return 'blocked_quota';
    case EXIT_CODES.policy:
      return 'blocked_policy';
    case EXIT_CODES.timeout:
      return 'failed_timeout';
    case EXIT_CODES.missingAsset:
      return 'failed_missing_asset';
    default:
      return null;
  }
}

function exitCodeFromState(state) {
  switch (state) {
    case 'saved':
      return EXIT_CODES.ok;
    case 'failed_ui':
      return EXIT_CODES.ui;
    case 'failed_download':
      return EXIT_CODES.generic;
    case 'failed_timeout':
      return EXIT_CODES.timeout;
    case 'blocked_quota':
    case 'blocked_subscription':
      return EXIT_CODES.quota;
    case 'blocked_policy':
      return EXIT_CODES.policy;
    case 'failed_missing_asset':
      return EXIT_CODES.missingAsset;
    default:
      return EXIT_CODES.generic;
  }
}

function classifyError(err) {
  if (!err) return { state: 'failed_ui', exitCode: EXIT_CODES.generic, lastError: 'unknown error' };

  if (typeof err.exitCode === 'number') {
    return {
      state: err.state || stateFromExitCode(err.exitCode) || 'failed_ui',
      exitCode: err.exitCode,
      lastError: err.message || String(err),
      lastScreenshot: err.screenshotPath || null,
    };
  }

  if (typeof err.code === 'number') {
    return {
      state: err.state || stateFromExitCode(err.code) || 'failed_ui',
      exitCode: err.code,
      lastError: err.message || String(err),
      lastScreenshot: err.screenshotPath || null,
    };
  }

  const visible = classifyVisibleText(err.message || String(err));
  if (visible) {
    return {
      state: visible.state,
      exitCode: visible.exitCode,
      lastError: err.message || visible.textExcerpt,
      lastScreenshot: err.screenshotPath || null,
    };
  }

  return {
    state: 'failed_ui',
    exitCode: EXIT_CODES.generic,
    lastError: err.message || String(err),
    lastScreenshot: err.screenshotPath || null,
  };
}

// Maps a per-clip outcome (success object or caught error) to the coarse
// signal the AIMD controller needs: distinguishing render-tile failures
// (which warrant backoff) from blockers and other UI faults.
function classifyControllerResult(outcome, err) {
  // Success path: the worker resolved with a saved/exit-0 outcome.
  if (!err && outcome && typeof outcome === 'object') {
    const state = outcome.state;
    const exitCode = typeof outcome.exitCode === 'number' ? outcome.exitCode : null;
    if (state === 'saved' || exitCode === EXIT_CODES.ok) return 'saved';
  }

  if (err) {
    // A failed render tile is signalled either by the adapter's stage, an
    // explicit failed_tile category, or visible text classified as failed_tile.
    if (err.stage === 'await_completed_tile' || err.category === 'failed_tile') {
      return 'failed_tile';
    }
    const visible = classifyVisibleText(err.message || String(err));
    if (visible && visible.category === 'failed_tile') return 'failed_tile';

    // Quota/subscription/policy blockers map to a backoff-worthy 'blocked'.
    const classified = classifyError(err);
    if (classified.exitCode === EXIT_CODES.quota || classified.exitCode === EXIT_CODES.policy) {
      return 'blocked';
    }
  }

  // Timeout / missing-asset / generic / non-tile failed_ui all fall through here.
  return 'other';
}

function chooseBetterExitCode(current, next) {
  const currentPriority = EXIT_PRIORITY.get(current) ?? 0;
  const nextPriority = EXIT_PRIORITY.get(next) ?? 0;
  return nextPriority >= currentPriority ? next : current;
}

function mergeItemOutcome(item, outcome, nowIso) {
  const resolved = outcome && typeof outcome === 'object' ? outcome : {};
  const state = typeof resolved.state === 'string' && resolved.state ? resolved.state : 'saved';
  const exitCode = typeof resolved.exitCode === 'number' ? resolved.exitCode : exitCodeFromState(state);
  const success = state === 'saved' && exitCode === EXIT_CODES.ok;
  const lastError = success
    ? null
    : (typeof resolved.lastError === 'string' && resolved.lastError
      ? resolved.lastError
      : (typeof resolved.error === 'string' && resolved.error
        ? resolved.error
        : null));

  return {
    ...item,
    state,
    attempts: (Number.isInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0) + 1,
    accountLabel: Object.prototype.hasOwnProperty.call(resolved, 'accountLabel') ? resolved.accountLabel : item.accountLabel,
    flowProjectUrl: Object.prototype.hasOwnProperty.call(resolved, 'flowProjectUrl') ? resolved.flowProjectUrl : item.flowProjectUrl,
    tabId: Object.prototype.hasOwnProperty.call(resolved, 'tabId') ? resolved.tabId : item.tabId,
    submittedAt: Object.prototype.hasOwnProperty.call(resolved, 'submittedAt') ? resolved.submittedAt : (item.submittedAt || nowIso),
    savedAt: success ? (Object.prototype.hasOwnProperty.call(resolved, 'savedAt') ? resolved.savedAt : (item.savedAt || nowIso)) : null,
    lastError,
    lastScreenshot: Object.prototype.hasOwnProperty.call(resolved, 'lastScreenshot') ? resolved.lastScreenshot : (success ? null : item.lastScreenshot),
  };
}

function normalizeAdapterOutcome(outcome) {
  if (outcome && typeof outcome === 'object' && outcome.state) {
    return {
      ...outcome,
      state: outcome.state,
      exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : exitCodeFromState(outcome.state),
      lastError: outcome.lastError || null,
    };
  }

  if (outcome && typeof outcome === 'object' && typeof outcome.exitCode === 'number') {
    return {
      ...outcome,
      state: stateFromExitCode(outcome.exitCode) || 'failed_ui',
      exitCode: outcome.exitCode,
      lastError: outcome.lastError || null,
    };
  }

  return {
    state: 'saved',
    exitCode: EXIT_CODES.ok,
    lastError: null,
  };
}

function loadFlowAdapter() {
  try {
    return require('../video/flow_adapter.cjs');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message || '').includes('flow_adapter.cjs')) {
      const wrapped = new Error('flow adapter is not available yet: src/node/video/flow_adapter.cjs');
      wrapped.code = EXIT_CODES.preflight;
      throw wrapped;
    }
    throw err;
  }
}

function getPuppeteer() {
  return require('puppeteer');
}

async function connectToChrome() {
  const puppeteer = getPuppeteer();
  return puppeteer.connect({
    browserURL: `http://127.0.0.1:${DEFAULT_CDP_PORT}`,
    defaultViewport: null,
  });
}

function motionForItem(item, prompts) {
  const prompt = Array.isArray(prompts)
    ? prompts.find(entry => entry && entry.idx === item.idx)
    : null;
  return (item.motion_script || (prompt && prompt.motion_script) || prompt && prompt.image_prompt || '').trim();
}

async function newPageFromBrowser(browser) {
  if (browser && typeof browser.newPage === 'function') return browser.newPage();
  const contexts = browser && typeof browser.browserContexts === 'function' ? browser.browserContexts() : [];
  if (contexts.length && typeof contexts[0].newPage === 'function') return contexts[0].newPage();
  throw new Error('connected browser does not expose newPage()');
}

// No-op controller used on the default/smoke path: a fixed single slot with no
// AIMD adaptation. Lane C injects a real controller; the shape is the contract.
// currentLimit reflects the configured selection limit so the default path
// still honours --limit N; concurrency stays at 1 (see slotCount below), so
// the default path runs the original sequential loop byte-identically.
function createNoopController(limit = 1) {
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? limit : 1;
  return {
    floor: 1,
    ceiling: 1,
    currentLimit() {
      return safeLimit;
    },
    recordOutcome() {},
  };
}

// Tiny in-process promise-chain mutex so concurrent slots never interleave
// writeVideoStateFile at the syscall level. writeVideoStateFile is already
// atomic (temp file + rename), but serializing the calls keeps the in-memory
// `reconciledState` mutation and its flush together as one critical section.
function createStateWriteMutex() {
  let tail = Promise.resolve();
  return function withStateLock(fn) {
    const run = tail.then(() => fn());
    // Swallow rejection on the chain so one failure does not poison the queue;
    // the caller still receives the real result/rejection from `run`.
    tail = run.then(() => {}, () => {});
    return run;
  };
}

async function runSmokeWorker({
  promptsPath,
  limit,
  maxInFlight,
  adapter,
  browser,
  controller,
  ceiling = 4,
  statePath = DEFAULT_STATE_PATH,
  screenshotsDir = path.join(REPO_ROOT, 'data', '.cca', 'flow_screenshots'),
  now = () => new Date().toISOString(),
} = {}) {
  const validated = validateSmokeConfig({ promptsPath, limit, maxInFlight, ceiling, smoke: false });
  const activeController = controller || createNoopController(validated.limit);
  const { imagesDir, videosDir } = deriveFlowDirs(validated.promptsPath);
  let prompts;
  try {
    prompts = JSON.parse(fs.readFileSync(validated.promptsPath, 'utf8'));
  } catch (_) {
    const wrapped = new Error(`prompts file must be valid JSON: ${validated.promptsPath}`);
    wrapped.code = EXIT_CODES.preflight;
    throw wrapped;
  }
  if (!Array.isArray(prompts)) {
    const err = new Error(`prompts file must be a JSON array: ${validated.promptsPath}`);
    err.code = EXIT_CODES.preflight;
    throw err;
  }

  let reconciledState;
  try {
    reconciledState = reconcileVideoState({
      promptsPath: validated.promptsPath,
      imagesDir,
      videosDir,
      statePath,
      mode: 'flow',
      activeProvider: 'flow',
      now: now(),
    });
  } catch (err) {
    if (!err.code) err.code = EXIT_CODES.preflight;
    throw err;
  }

  // The controller's current limit caps how many clips we pull this run; the
  // no-op default reports 1 so the smoke/default path is unchanged.
  const selection = selectEligibleItems(reconciledState, activeController.currentLimit());
  if (selection.selected.length === 0) return determineNoWorkExitCode(reconciledState);

  const resolvedAdapter = adapter || loadFlowAdapter();
  const ownsBrowser = !browser;
  const activeBrowser = browser || await connectToChrome();
  const withStateLock = createStateWriteMutex();
  let runExitCode = EXIT_CODES.ok;

  // Process a single queue item end-to-end: open a fresh page, drive the
  // adapter, normalize/merge/persist its outcome under the write mutex, fold
  // its exit code into the run aggregate, and report the result to the
  // controller. Each slot only ever mutates its own items[idx] key.
  async function processItem(item) {
    const itemNow = now();
    let page = null;
    let outcome = null;
    let caught = null;
    try {
      if (typeof resolvedAdapter.generateOne !== 'function') throw new Error('flow adapter must export generateOne()');
      page = await newPageFromBrowser(activeBrowser);
      outcome = await resolvedAdapter.generateOne({
        page,
        item,
        motion: motionForItem(item, prompts),
        imagePath: resolvePathForFs(item.imagePath),
        videoPath: resolvePathForFs(item.videoPath),
        options: {
          screenshotsDir,
          minVideoBytes: 50 * 1024,
        },
      });

      const normalized = normalizeAdapterOutcome(outcome);
      await withStateLock(() => {
        const merged = mergeItemOutcome(item, normalized, itemNow);
        reconciledState.items[String(item.idx)] = merged;
        reconciledState.updatedAt = itemNow;
        // writeVideoStateFile is atomic (temp file + rename); the mutex only
        // serializes the read-modify-write of reconciledState across slots.
        writeVideoStateFile(statePath, reconciledState);
      });
      runExitCode = chooseBetterExitCode(runExitCode, normalized.exitCode);
    } catch (err) {
      caught = err;
      const classified = classifyError(err);
      await withStateLock(() => {
        const merged = mergeItemOutcome(item, classified, itemNow);
        reconciledState.items[String(item.idx)] = merged;
        reconciledState.updatedAt = itemNow;
        writeVideoStateFile(statePath, reconciledState);
      });
      runExitCode = chooseBetterExitCode(runExitCode, classified.exitCode);
    } finally {
      if (page && typeof page.close === 'function') await page.close().catch(() => {});
    }
    activeController.recordOutcome({ result: classifyControllerResult(outcome, caught) });
  }

  try {
    // Concurrency is bounded by the controller's live limit AND the requested
    // maxInFlight. The default path runs maxInFlight=1, forcing the sequential
    // fast-path below even when --limit selected several items.
    const slotCount = Math.min(
      validated.maxInFlight,
      activeController.currentLimit(),
      selection.selected.length
    );

    if (slotCount <= 1) {
      // DEFAULT FAST-PATH: identical to the original sequential loop — same
      // ordering, one item fully finished (page closed) before the next opens.
      for (const item of selection.selected) {
        await processItem(item);
      }
      return runExitCode;
    }

    // Concurrent scheduler: a fixed pool of slot-runners draining a shared
    // queue. Each runner repeatedly shifts the next item and processes it.
    const queue = selection.selected.slice();
    const runner = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        await processItem(item);
      }
    };
    const runners = [];
    for (let i = 0; i < slotCount; i += 1) runners.push(runner());
    await Promise.allSettled(runners);

    return runExitCode;
  } finally {
    if (ownsBrowser && activeBrowser) await activeBrowser.disconnect().catch(() => {});
  }
}

async function main(argv = process.argv, deps = {}) {
  try {
    const parsed = parseCliArgs(argv);
    // Standalone CLI keeps smoke-phase semantics: single-flight only.
    const validated = validateSmokeConfig({ ...parsed, smoke: true });
    return await runSmokeWorker({
      promptsPath: validated.promptsPath,
      limit: validated.limit,
      maxInFlight: validated.maxInFlight,
      adapter: deps.adapter,
      browser: deps.browser,
      statePath: deps.statePath || DEFAULT_STATE_PATH,
      screenshotsDir: deps.screenshotsDir,
      now: deps.now,
    });
  } catch (err) {
    const code = typeof err.code === 'number' ? err.code : EXIT_CODES.generic;
    if (code === EXIT_CODES.preflight) {
      console.error(`[flow] preflight failure: ${err.message}`);
      return code;
    }
    console.error(`[flow] unrecovered failure: ${err && err.message ? err.message : err}`);
    return code;
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(`[flow] unrecovered failure: ${err && err.message ? err.message : err}`);
    process.exit(EXIT_CODES.generic);
  });
}

module.exports = {
  DEFAULT_STATE_PATH,
  chooseBetterExitCode,
  classifyControllerResult,
  classifyError,
  createNoopController,
  createStateWriteMutex,
  determineNoWorkExitCode,
  deriveFlowDirs,
  exitCodeFromState,
  loadFlowAdapter,
  main,
  mergeItemOutcome,
  motionForItem,
  newPageFromBrowser,
  normalizeAdapterOutcome,
  parseCliArgs,
  runSmokeWorker,
  selectEligibleItems,
  stateFromExitCode,
  validateSmokeConfig,
};
