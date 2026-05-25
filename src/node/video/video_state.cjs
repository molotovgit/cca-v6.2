'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_STATE_PATH = path.join(REPO_ROOT, 'data', '.cca', 'video_state.json');
const DEFAULT_MIN_VIDEO_BYTES = 50 * 1024;

const ALLOWED_ITEM_STATES = new Set([
  'pending',
  'submitting',
  'submitted',
  'rendering',
  'saved',
  'blocked_quota',
  'blocked_policy',
  'blocked_subscription',
  'failed_ui',
  'failed_download',
  'failed_timeout',
  'failed_missing_asset',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolvePathForStorage(inputPath) {
  const abs = path.resolve(inputPath);
  const rel = path.relative(REPO_ROOT, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel;
  }
  return abs;
}

function resolvePathForFs(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.join(REPO_ROOT, inputPath);
}

function padIdx(idx) {
  return String(idx).padStart(3, '0');
}

function safeJsonRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readVideoStateFile(statePath = DEFAULT_STATE_PATH) {
  const raw = safeJsonRead(statePath);
  if (!isPlainObject(raw)) return null;
  if (!isPlainObject(raw.items)) raw.items = {};
  return raw;
}

function writeVideoStateFile(statePath, state) {
  const absPath = path.resolve(statePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const tmpPath = path.join(
    path.dirname(absPath),
    `${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch (_) {}
    throw err;
  }
}

function readPromptsFile(promptsPath) {
  const raw = safeJsonRead(promptsPath);
  if (!Array.isArray(raw)) {
    throw new Error(`prompts file must be a JSON array: ${promptsPath}`);
  }
  return raw;
}

function fileSizeIfExists(filePath) {
  try {
    return fs.statSync(resolvePathForFs(filePath)).size;
  } catch (_) {
    return null;
  }
}

function isAllowedState(state) {
  return typeof state === 'string' && ALLOWED_ITEM_STATES.has(state);
}

function isMeaningfulExistingState(state) {
  return isAllowedState(state) && state !== 'pending' && state !== 'saved';
}

function createDefaultItem(idx, slug, imagePath, videoPath) {
  return {
    idx,
    slug,
    imagePath,
    videoPath,
    state: 'pending',
    attempts: 0,
    accountLabel: null,
    flowProjectUrl: null,
    tabId: null,
    submittedAt: null,
    savedAt: null,
    lastError: null,
    lastScreenshot: null,
  };
}

function buildVideoState({
  prompts,
  promptsPath,
  imagesDir,
  videosDir,
  existingState,
  mode = 'flow',
  activeProvider = 'flow',
  now = new Date().toISOString(),
  minVideoBytes = DEFAULT_MIN_VIDEO_BYTES,
}) {
  if (!Array.isArray(prompts)) {
    throw new Error('prompts must be an array');
  }

  const prev = isPlainObject(existingState) ? existingState : {};
  const prevItems = isPlainObject(prev.items) ? prev.items : {};
  const state = {
    ...(isPlainObject(prev) ? prev : {}),
    version: 1,
    mode,
    promptsPath: resolvePathForStorage(promptsPath),
    imagesDir: resolvePathForStorage(imagesDir),
    videosDir: resolvePathForStorage(videosDir),
    activeProvider,
    startedAt: typeof prev.startedAt === 'string' ? prev.startedAt : now,
    updatedAt: now,
    items: {},
  };

  prompts.forEach((prompt, arrayPos) => {
    const idx = Number.isInteger(prompt && prompt.idx) && prompt.idx > 0
      ? prompt.idx
      : arrayPos + 1;
    const existing = isPlainObject(prevItems[String(idx)]) ? prevItems[String(idx)] : {};
    const slug = typeof prompt.slug === 'string' && prompt.slug.trim()
      ? prompt.slug.trim()
      : (typeof existing.slug === 'string' && existing.slug.trim() ? existing.slug.trim() : `scene-${padIdx(idx)}`);
    const imagePath = resolvePathForStorage(path.join(imagesDir, `${padIdx(idx)}-${slug}.png`));
    const videoPath = resolvePathForStorage(path.join(videosDir, `${padIdx(idx)}-${slug}.mp4`));
    const imageExists = fs.existsSync(resolvePathForFs(imagePath));
    const videoBytes = fileSizeIfExists(videoPath);
    const videoReady = typeof videoBytes === 'number' && videoBytes >= minVideoBytes;
    const existingState = isAllowedState(existing.state) ? existing.state : 'pending';

    let nextState = 'pending';
    if (videoReady) {
      nextState = 'saved';
    } else if (!imageExists) {
      nextState = 'failed_missing_asset';
    } else if (isMeaningfulExistingState(existingState)) {
      nextState = existingState;
    }

    const item = {
      ...createDefaultItem(idx, slug, imagePath, videoPath),
      ...existing,
      idx,
      slug,
      imagePath,
      videoPath,
      state: nextState,
      attempts: Number.isInteger(existing.attempts) && existing.attempts >= 0 ? existing.attempts : 0,
      accountLabel: Object.prototype.hasOwnProperty.call(existing, 'accountLabel') ? existing.accountLabel : null,
      flowProjectUrl: Object.prototype.hasOwnProperty.call(existing, 'flowProjectUrl') ? existing.flowProjectUrl : null,
      tabId: Object.prototype.hasOwnProperty.call(existing, 'tabId') ? existing.tabId : null,
      submittedAt: Object.prototype.hasOwnProperty.call(existing, 'submittedAt') ? existing.submittedAt : null,
      savedAt: Object.prototype.hasOwnProperty.call(existing, 'savedAt') ? existing.savedAt : null,
      lastError: Object.prototype.hasOwnProperty.call(existing, 'lastError') ? existing.lastError : null,
      lastScreenshot: Object.prototype.hasOwnProperty.call(existing, 'lastScreenshot') ? existing.lastScreenshot : null,
    };

    if (nextState === 'saved') {
      item.savedAt = typeof existing.savedAt === 'string' ? existing.savedAt : now;
      item.lastError = null;
      item.lastScreenshot = null;
    } else if (nextState === 'failed_missing_asset') {
      item.savedAt = null;
      item.lastError = `missing source image: ${imagePath}`;
      item.lastScreenshot = null;
      item.tabId = null;
      item.submittedAt = null;
    } else if (nextState === 'pending') {
      item.savedAt = null;
      item.lastError = null;
      item.lastScreenshot = null;
      item.tabId = null;
      item.submittedAt = null;
      item.flowProjectUrl = Object.prototype.hasOwnProperty.call(existing, 'flowProjectUrl') ? existing.flowProjectUrl : null;
    }

    state.items[String(idx)] = item;
  });

  return state;
}

function reconcileVideoState({
  promptsPath,
  imagesDir,
  videosDir,
  statePath = DEFAULT_STATE_PATH,
  mode = 'flow',
  activeProvider = 'flow',
  minVideoBytes = DEFAULT_MIN_VIDEO_BYTES,
  now = new Date().toISOString(),
}) {
  const prompts = readPromptsFile(promptsPath);
  const existingState = readVideoStateFile(statePath);
  const state = buildVideoState({
    prompts,
    promptsPath,
    imagesDir,
    videosDir,
    existingState,
    mode,
    activeProvider,
    now,
    minVideoBytes,
  });
  writeVideoStateFile(statePath, state);
  return state;
}

module.exports = {
  ALLOWED_ITEM_STATES,
  DEFAULT_MIN_VIDEO_BYTES,
  DEFAULT_STATE_PATH,
  buildVideoState,
  readVideoStateFile,
  reconcileVideoState,
  resolvePathForFs,
  resolvePathForStorage,
  writeVideoStateFile,
};
