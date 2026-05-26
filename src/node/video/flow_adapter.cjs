'use strict';

const fs = require('fs');
const path = require('path');

const { classifyPage, EXIT_CODES } = require('./video_errors.cjs');
const flowUi = require('./flow_ui.cjs');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow';
const DEFAULT_MIN_VIDEO_BYTES = 50 * 1024;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 4000;
const DOWNLOAD_HELPER_NAMES = ['downloadMp4ToFile', 'downloadVideo', 'downloadMp4', 'saveVideo', 'saveMp4'];

const UPLOAD_TEXTS = ['upload', 'upload image', 'add media', 'add files', 'add image', 'attach', 'import'];
const PROMPT_TEXTS = ['prompt', 'motion', 'describe', 'describe your video', 'enter a prompt', 'what do you want to create'];
const SUBMIT_TEXTS = ['generate', 'create', 'send', 'submit', 'run'];
const DOWNLOAD_TEXTS = ['download', 'save', 'export'];

class FlowAdapterError extends Error {
  constructor(message, {
    state = 'failed_ui',
    exitCode = EXIT_CODES.ui,
    stage = null,
    screenshotPath = null,
    cause = null,
  } = {}) {
    super(message);
    this.name = 'FlowAdapterError';
    this.state = state;
    this.exitCode = exitCode;
    this.stage = stage;
    this.screenshotPath = screenshotPath;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function includesAnyText(text, needles) {
  const haystack = normalizeText(text).toLowerCase();
  if (!haystack) return false;
  return needles.some(needle => haystack.includes(String(needle).toLowerCase()));
}

function safePart(value, fallback = 'item') {
  const text = normalizeText(value).toLowerCase();
  const cleaned = text
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function resolveEntryUrl({ flowUrl = DEFAULT_FLOW_URL, projectUrl = null } = {}) {
  return projectUrl || flowUrl || DEFAULT_FLOW_URL;
}

function resolveDownloadHelper(options = {}) {
  if (typeof options.downloadVideo === 'function') return options.downloadVideo;
  if (typeof options.downloadHelper === 'function') return options.downloadHelper;

  const modulePath = options.downloadModulePath || './video_download.cjs';
  let mod = null;
  try {
    mod = require(modulePath);
  } catch (_) {
    return null;
  }

  if (typeof mod === 'function') return mod;
  for (const name of DOWNLOAD_HELPER_NAMES) {
    if (typeof mod[name] === 'function') return mod[name].bind(mod);
  }
  return null;
}

function buildScreenshotPath({ screenshotsDir, item = {}, stage = 'failure', ext = 'png' }) {
  if (!screenshotsDir) return null;
  const idx = Number.isInteger(item.idx) ? String(item.idx).padStart(3, '0') : '000';
  const slug = safePart(item.slug, 'item');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(screenshotsDir, `${idx}-${slug}-${safePart(stage, 'stage')}-${stamp}.${ext}`);
}

async function saveFailureScreenshot(page, { screenshotsDir, item, stage }) {
  const screenshotPath = buildScreenshotPath({ screenshotsDir, item, stage });
  if (!screenshotPath) return null;
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
  return screenshotPath;
}

async function detectBlocker(page, classifyPageFn = classifyPage) {
  if (typeof classifyPageFn !== 'function') return null;
  return Promise.resolve(classifyPageFn(page)).catch(() => null);
}

function shouldIgnoreBlocker(blocker, ignoredCategories = []) {
  if (!blocker || !Array.isArray(ignoredCategories) || ignoredCategories.length === 0) return false;
  return ignoredCategories.includes(blocker.category);
}

function normalizeDownloadResult(result, fallbackPath) {
  if (!result) return fallbackPath || null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    return result.path || result.filePath || result.outputPath || fallbackPath || null;
  }
  return fallbackPath || null;
}

async function validateVideoFile(videoPath, minBytes = DEFAULT_MIN_VIDEO_BYTES) {
  const stat = await fs.promises.stat(videoPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new FlowAdapterError(`expected MP4 file was not created: ${videoPath}`, {
      state: 'failed_download',
      exitCode: EXIT_CODES.generic,
      stage: 'validate_video',
    });
  }
  if (stat.size < minBytes) {
    throw new FlowAdapterError(`video file is too small to be a valid MP4: ${videoPath} (${stat.size} bytes)`, {
      state: 'failed_download',
      exitCode: EXIT_CODES.generic,
      stage: 'validate_video',
    });
  }
  return stat;
}

async function findClickableByText(page, texts, {
  selectors = 'button, [role="button"], a, label, div, span',
  exact = false,
} = {}) {
  return page.evaluate((query) => {
    const { texts, selectors, exact } = query;
    const wanted = texts.map(t => String(t).toLowerCase());
    const nodes = Array.from(document.querySelectorAll(selectors));

    const visible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4 && rect.bottom >= 0 && rect.right >= 0;
    };

    for (const el of nodes) {
      if (!visible(el)) continue;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.textContent,
      ].filter(Boolean).join(' ');
      const normalized = label.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!normalized) continue;
      const hit = wanted.some(needle => exact ? normalized === needle : normalized.includes(needle));
      if (!hit) continue;
      const rect = el.getBoundingClientRect();
      return {
        text: normalized.slice(0, 240),
        tag: el.tagName.toLowerCase(),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }

    return null;
  }, { texts, selectors, exact }).catch(() => null);
}

async function findTextInputBox(page, texts, {
  selectors = 'textarea, [contenteditable="true"], [role="textbox"], input:not([type="hidden"])',
  exact = false,
} = {}) {
  return page.evaluate((query) => {
    const { texts, selectors, exact } = query;
    const wanted = texts.map(t => String(t).toLowerCase());
    const nodes = Array.from(document.querySelectorAll(selectors));

    const visible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 16 && rect.height >= 16 && rect.bottom >= 0 && rect.right >= 0;
    };

    for (const el of nodes) {
      if (!visible(el)) continue;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.getAttribute('title'),
      ].filter(Boolean).join(' ');
      const body = `${label} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!body) continue;
      const hit = wanted.some(needle => exact ? body === needle : body.includes(needle));
      if (!hit) continue;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }

    return null;
  }, { texts, selectors, exact }).catch(() => null);
}

async function waitForFlowReady(page, options = {}) {
  if (!page || typeof page.waitForFunction !== 'function') return false;
  const timeout = Number.isFinite(options.readyTimeoutMs) ? options.readyTimeoutMs : 120_000;
  await page.waitForFunction(() => {
    const bodyText = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!bodyText || bodyText === 'loading...' || bodyText === 'loading') return false;
    return bodyText.includes('what do you want to create')
      || bodyText.includes('add media')
      || bodyText.includes('start creating')
      || bodyText.includes('create');
  }, { timeout });
  await sleep(Number.isFinite(options.readySettleMs) ? options.readySettleMs : 1500);
  return true;
}

async function findFileInput(page) {
  return page.$('input[type="file"]').catch(() => null);
}

async function findStartFrameDropTarget(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[role="button"], button, label'));
    const visible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 100 && rect.height >= 100 && rect.bottom >= 0 && rect.right >= 0;
    };

    const candidates = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const rect = el.getBoundingClientRect();
      if (label && !/start|frame|drop|media|upload/.test(label)) continue;
      candidates.push({
        text: label.slice(0, 240),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }

    candidates.sort((a, b) => a.x - b.x || b.width * b.height - a.width * a.height);
    return candidates[0] || null;
  }).catch(() => null);
}

async function clickVisibleButton(page, matcher) {
  if (!page || typeof page.evaluate !== 'function' || typeof page.mouse?.click !== 'function') return null;
  const target = await page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const visible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4 && rect.bottom >= 0 && rect.right >= 0;
    };

    const candidates = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!pattern.test(label)) continue;
      const rect = el.getBoundingClientRect();
      candidates.push({
        text: label.slice(0, 240),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        area: Math.round(rect.width * rect.height),
      });
    }
    candidates.sort((a, b) => b.area - a.area);
    return candidates[0] || null;
  }, matcher.source || String(matcher)).catch(() => null);

  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 20 });
  return target;
}

async function configureVideoMode(page, options = {}) {
  if (options.configureVideoMode === false) return false;
  const settle = Number.isFinite(options.modeSettleMs) ? options.modeSettleMs : 600;

  const opened = await clickVisibleButton(page, /(?:nano banana|video\s*[·.]|crop_16_9|omni flash)/i);
  if (!opened) return false;
  await sleep(settle);

  const steps = [
    /play_circle\s*video|video/i,
    /crop_free\s*frames|frames/i,
    /crop_16_9\s*16:9|16:9/i,
    /^1x$/i,
    /^4s$/i,
  ];
  for (const step of steps) {
    const clicked = await clickVisibleButton(page, step);
    if (clicked) await sleep(settle);
  }
  return true;
}

async function readBodyText(page) {
  if (!page || typeof page.evaluate !== 'function') return '';
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText || '' : '';
    return bodyText.replace(/\s+/g, ' ').trim();
  }).catch(() => '');
}

async function verifyVideoMode(page, options = {}) {
  if (options.verifyVideoMode === false) return true;

  const bodyText = typeof options.readVideoModeText === 'function'
    ? await options.readVideoModeText(page, options)
    : await readBodyText(page);

  const videoModeConfirmed = /video\s*[·.]\s*4s/i.test(bodyText);
  const creditsMatch = bodyText.match(/generating will use (\d+) credits/i);
  const credits = creditsMatch ? Number.parseInt(creditsMatch[1], 10) : null;

  if (!videoModeConfirmed || credits === null || !(credits > 0)) {
    throw new FlowAdapterError('Flow is still in image mode (0 credits) — video mode not selected', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.ui,
      stage: 'verify_video_mode',
    });
  }
  return true;
}

async function findStartThumbnail(page, options = {}) {
  if (typeof options.findStartThumbnail === 'function') {
    return options.findStartThumbnail(page, options);
  }
  if (!page || typeof page.evaluate !== 'function') return null;
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 8 && rect.height >= 8 && rect.bottom >= 0 && rect.right >= 0;
    };

    const zones = Array.from(document.querySelectorAll('[role="button"], button, label, div'));
    for (const zone of zones) {
      if (!visible(zone)) continue;
      const zoneLabel = [
        zone.getAttribute('aria-label'),
        zone.getAttribute('title'),
        zone.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!/start/.test(zoneLabel)) continue;
      const thumb = zone.querySelector('img[src], [style*="background-image"], video[src]');
      if (thumb && visible(thumb)) {
        return { kind: 'thumbnail', source: zoneLabel.slice(0, 120) };
      }
      const filenameMatch = zoneLabel.match(/[\w.-]+\.(?:png|jpe?g|webp|gif|bmp)\b/);
      if (filenameMatch) {
        return { kind: 'filename', text: filenameMatch[0] };
      }
    }
    return null;
  }).catch(() => null);
}

async function verifyStartFrameAttached(page, options = {}) {
  if (options.verifyStartFrame === false) return true;
  const thumbnail = await findStartThumbnail(page, options);
  if (!thumbnail) {
    await decorateAndThrow(page, options, 'verify_start_frame', 'start frame did not attach to the Start slot', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.ui,
    });
  }
  return thumbnail;
}

async function findCompletedTile(page, options = {}) {
  if (typeof options.findCompletedTile === 'function') {
    return options.findCompletedTile(page, options);
  }

  // LIVE (flow_probe): a completed tile is a visible <video> whose src matches
  // media.getMediaUrlRedirect?name=<UUID>. Reuse the findDownloadTarget <video>
  // scan and keep only a hit whose src matches the completed-tile pattern.
  const videoSrcRe = flowUi.COMPLETED_TILE_SELECTOR
    && flowUi.COMPLETED_TILE_SELECTOR.videoSrcRe;
  if (videoSrcRe && page && typeof page.evaluate === 'function') {
    const tile = await page.evaluate((source) => {
      const pattern = new RegExp(source, 'i');
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 4 && rect.height >= 4 && rect.bottom >= 0 && rect.right >= 0;
      };

      const videos = Array.from(document.querySelectorAll('video'));
      for (const video of videos) {
        if (!isVisible(video)) continue;
        const src = video.currentSrc || video.src || video.querySelector('source[src]')?.src || '';
        if (!src || !pattern.test(src)) continue;
        const rect = video.getBoundingClientRect();
        return {
          kind: 'video',
          src,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }
      return null;
    }, videoSrcRe.source).catch(() => null);

    if (tile) return tile;
  }

  // No completed <video> present yet. Only now is the live-discovery error
  // appropriate — the reload/rescan loop catches this and retries.
  throw new FlowAdapterError('completed-tile/download selector unknown — needs live discovery (see flow_probe)', {
    state: 'failed_download',
    exitCode: EXIT_CODES.generic,
    stage: 'await_completed_tile',
  });
}

async function openVideosTab(page, options = {}) {
  if (options.openVideosTab === false) return null;
  if (typeof options.openVideosTab === 'function') {
    return options.openVideosTab(page, options);
  }
  const clicked = await clickVisibleButton(page, /view videos videos|videocam|all media/i);
  return clicked;
}

async function reloadAndRescan(page, options = {}) {
  const projectUrl = typeof page.url === 'function' ? page.url() : null;
  const targetUrl = options.projectUrl || projectUrl || resolveEntryUrl({
    flowUrl: options.flowUrl || DEFAULT_FLOW_URL,
  });

  await page.goto(targetUrl, {
    waitUntil: options.waitUntil || 'domcontentloaded',
    timeout: Number.isFinite(options.gotoTimeoutMs) ? options.gotoTimeoutMs : 60_000,
  });
  await waitForFlowReady(page, options).catch(() => false);
  await openVideosTab(page, options);
  await sleep(Number.isFinite(options.rescanSettleMs) ? options.rescanSettleMs : 1500);
  return findCompletedTile(page, options);
}

async function decorateAndThrow(page, options, stage, message, meta = {}) {
  const screenshotPath = await saveFailureScreenshot(page, {
    screenshotsDir: options.screenshotsDir,
    item: options.item,
    stage,
  });
  throw new FlowAdapterError(message, { ...meta, stage, screenshotPath });
}

async function uploadStartFrame(page, imagePath, options, stage = 'upload_start_frame') {
  const directInput = await findFileInput(page);
  if (directInput && typeof directInput.uploadFile === 'function') {
    await directInput.uploadFile(imagePath);
    return { mode: 'file-input' };
  }

  const uploadBox = typeof options.findUploadControl === 'function'
    ? await options.findUploadControl(page, options)
    : (await findClickableByText(page, UPLOAD_TEXTS) || await findStartFrameDropTarget(page));

  if (!uploadBox) {
    await decorateAndThrow(page, options, stage, 'could not find an upload control', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.ui,
    });
  }

  if (typeof page.waitForFileChooser === 'function') {
    const chooserPromise = page.waitForFileChooser({ timeout: options.fileChooserTimeoutMs || 10_000 });
    await page.mouse.click(uploadBox.x, uploadBox.y, { delay: 20 });
    const chooser = await chooserPromise.catch(() => null);
    if (chooser && typeof chooser.accept === 'function') {
      await chooser.accept([imagePath]);
      return { mode: 'file-chooser', control: uploadBox };
    }
  }

  await decorateAndThrow(page, options, stage, 'file chooser did not open for upload', {
    state: 'failed_ui',
    exitCode: EXIT_CODES.ui,
  });
}

async function enterMotionPrompt(page, motion, options, stage = 'enter_motion') {
  const promptBox = typeof options.findPromptControl === 'function'
    ? await options.findPromptControl(page, options)
    : await findTextInputBox(page, PROMPT_TEXTS);

  if (!promptBox) {
    await decorateAndThrow(page, options, stage, 'could not find the motion prompt field', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.ui,
    });
  }

  await page.mouse.click(promptBox.x, promptBox.y, { delay: 20 });
  await page.keyboard.type(String(motion || '').replace(/\s*\n\s*/g, ' ').trim(), { delay: 12 });
  return promptBox;
}

async function submitGeneration(page, options, stage = 'submit_generation') {
  const submitBox = typeof options.findSubmitControl === 'function'
    ? await options.findSubmitControl(page, options)
    : await findSubmitButton(page, SUBMIT_TEXTS);

  if (!submitBox) {
    await decorateAndThrow(page, options, stage, 'could not find a submit button', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.ui,
    });
  }

  await page.mouse.click(submitBox.x, submitBox.y, { delay: 20 });
  return submitBox;
}

async function findSubmitButton(page, texts = SUBMIT_TEXTS) {
  if (!page || typeof page.evaluate !== 'function') return null;
  return page.evaluate((query) => {
    const { texts } = query;
    const wanted = texts.map(t => String(t).toLowerCase());
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));

    const visible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4 && rect.bottom >= 0 && rect.right >= 0;
    };

    const candidates = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!label) continue;
      if (label.includes('add media') || label.includes('add_2')) continue;
      if (!wanted.some(needle => label.includes(needle)) && !label.includes('arrow_forward')) continue;
      const rect = el.getBoundingClientRect();
      let score = 0;
      if (label.includes('arrow_forward')) score += 100;
      if (label.includes('generate')) score += 60;
      if (label.includes('create')) score += 40;
      if (rect.left > window.innerWidth / 2) score += 10;
      candidates.push({
        text: label.slice(0, 240),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        score,
      });
    }

    candidates.sort((a, b) => b.score - a.score || b.x - a.x);
    return candidates[0] || null;
  }, { texts }).catch(() => null);
}

async function findDownloadTarget(page, options = {}) {
  if (typeof options.findDownloadTarget === 'function') {
    return options.findDownloadTarget(page, options);
  }

  return page.evaluate((texts) => {
    const wanted = texts.map(t => String(t).toLowerCase());
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4 && rect.bottom >= 0 && rect.right >= 0;
    };

    const videos = Array.from(document.querySelectorAll('video'));
    for (const video of videos) {
      if (!isVisible(video)) continue;
      const src = video.currentSrc || video.src || video.querySelector('source[src]')?.src || '';
      if (src) {
        const rect = video.getBoundingClientRect();
        return {
          kind: 'video',
          src,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }
    }

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [download]'));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!label) continue;
      if (!wanted.some(needle => label.includes(needle))) continue;
      const rect = el.getBoundingClientRect();
      return {
        kind: 'button',
        text: label.slice(0, 240),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }

    return null;
  }, DOWNLOAD_TEXTS).catch(() => null);
}

async function hasActiveRenderProgress(page) {
  if (!page || typeof page.evaluate !== 'function') return false;
  return page.evaluate(() => {
    const bodyText = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
    // NOTE: a trailing \b after `%` is unsatisfiable (`%` is non-word, the next
    // char is space/end which is also non-word), so the old /\b(\d{1,3})%\b/g
    // NEVER matched "7%" or "99%" — the failed-tile grace check then never saw
    // live progress and threw on the "Failed … 99%" card mid-render.
    const progressMatches = Array.from(bodyText.matchAll(/(\d{1,3})\s*%/g))
      .map(match => Number.parseInt(match[1], 10))
      .filter(value => Number.isFinite(value));
    return progressMatches.some(value => value >= 0 && value < 100)
      || /\b(generating|rendering|creating)\b/i.test(bodyText);
  }).catch(() => false);
}

async function waitForCompletion(page, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0
    ? options.pollMs
    : DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  const failedTileGraceMs = Number.isFinite(options.failedTileGraceMs)
    ? options.failedTileGraceMs
    : 30_000;
  const classifyPageFn = typeof options.classifyPage === 'function'
    ? options.classifyPage
    : classifyPage;

  while (Date.now() < deadline) {
    const blocker = await detectBlocker(page, classifyPageFn);
    if (
      blocker
      && blocker.category === 'failed_tile'
      && (Date.now() - startedAt < failedTileGraceMs || await hasActiveRenderProgress(page))
    ) {
      await sleep(pollMs);
      continue;
    }
    // The Flow `failed`/`warning … 99%` card is advisory, not terminal: it can
    // persist next to a fresh render. Stop polling the live view and let the
    // caller reload + rescan the Videos tab before concluding a real failure.
    if (blocker && blocker.category === 'failed_tile') {
      return { advisory: 'failed_tile', target: null };
    }
    if (blocker) {
      const screenshotPath = await saveFailureScreenshot(page, {
        screenshotsDir: options.screenshotsDir,
        item: options.item,
        stage: `blocked_${blocker.category || 'flow'}`,
      });
      throw new FlowAdapterError(
        blocker.reason || `Flow reported a blocker: ${blocker.category || 'unknown'}`,
        {
          state: blocker.state || 'failed_ui',
          exitCode: blocker.exitCode || EXIT_CODES.ui,
          stage: `blocked_${blocker.category || 'flow'}`,
          screenshotPath,
        }
      );
    }

    const target = await findDownloadTarget(page, options);
    if (target) return { advisory: null, target };

    await sleep(pollMs);
  }

  return { advisory: 'timeout', target: null };
}

async function awaitCompletedTile(page, options = {}) {
  // Phase 1: poll the live generating view for a brief render window.
  const live = await waitForCompletion(page, options);
  if (live && live.target) return live.target;

  // Phase 2: trust nothing from the live view. Reload the project, open the
  // Videos/All Media tab, and rescan for a real completed tile. Repeat a few
  // times because Flow often renders only after a reload.
  const reloadAttempts = Number.isFinite(options.reloadAttempts) && options.reloadAttempts > 0
    ? options.reloadAttempts
    : 2;
  const reloadDelayMs = Number.isFinite(options.reloadDelayMs) && options.reloadDelayMs >= 0
    ? options.reloadDelayMs
    : 15_000;

  let lastErr = null;
  for (let attempt = 0; attempt < reloadAttempts; attempt += 1) {
    if (attempt > 0) await sleep(reloadDelayMs);
    try {
      const tile = await reloadAndRescan(page, options);
      if (tile) return tile;
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr instanceof FlowAdapterError) {
    const screenshotPath = await saveFailureScreenshot(page, {
      screenshotsDir: options.screenshotsDir,
      item: options.item,
      stage: lastErr.stage || 'await_completed_tile',
    });
    lastErr.screenshotPath = lastErr.screenshotPath || screenshotPath;
    throw lastErr;
  }

  const screenshotPath = await saveFailureScreenshot(page, {
    screenshotsDir: options.screenshotsDir,
    item: options.item,
    stage: live && live.advisory === 'failed_tile' ? 'await_completed_tile' : 'wait_timeout',
  });

  if (live && live.advisory === 'failed_tile') {
    throw new FlowAdapterError('Flow render failed — no completed tile after reload + Videos-tab rescan', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.ui,
      stage: 'await_completed_tile',
      screenshotPath,
    });
  }

  throw new FlowAdapterError('timed out waiting for Flow to finish rendering', {
    state: 'failed_timeout',
    exitCode: EXIT_CODES.timeout,
    stage: 'wait_timeout',
    screenshotPath,
  });
}

async function runDownloadHelper(helper, { page, item, motion, imagePath, videoPath, options, target }) {
  let result;
  if (target && target.src && helper.length >= 3) {
    result = await helper(page, target.src, videoPath, {
      minBytes: options.minVideoBytes || DEFAULT_MIN_VIDEO_BYTES,
      pageUrl: typeof page.url === 'function' ? page.url() : undefined,
      fallbackName: `${String(item.idx).padStart(3, '0')}-${item.slug || 'flow'}.mp4`,
    });
  } else {
    result = await helper({
      page,
      item,
      motion,
      imagePath,
      videoPath,
      target,
      sourceUrl: target && target.src,
      options,
    });
  }

  const outputPath = normalizeDownloadResult(result, videoPath);
  if (!outputPath) {
    throw new FlowAdapterError('download helper did not return an MP4 path', {
      state: 'failed_download',
      exitCode: EXIT_CODES.generic,
      stage: 'download_video',
    });
  }
  return outputPath;
}

async function generateOne({
  page,
  item,
  motion,
  imagePath,
  videoPath,
  options = {},
}) {
  if (!page) throw new Error('generateOne requires a page');
  if (!item) throw new Error('generateOne requires an item');
  if (!imagePath) throw new Error('generateOne requires imagePath');
  if (!videoPath) throw new Error('generateOne requires videoPath');
  if (!String(motion || '').trim()) {
    throw new FlowAdapterError('motion prompt is required', {
      state: 'failed_ui',
      exitCode: EXIT_CODES.preflight,
      stage: 'preflight',
    });
  }

  const imageStat = await fs.promises.stat(imagePath).catch(() => null);
  if (!imageStat || !imageStat.isFile()) {
    throw new FlowAdapterError(`missing source image: ${imagePath}`, {
      state: 'failed_missing_asset',
      exitCode: EXIT_CODES.missingAsset,
      stage: 'preflight',
    });
  }

  const flowUrl = resolveEntryUrl({
    flowUrl: options.flowUrl || DEFAULT_FLOW_URL,
    projectUrl: options.projectUrl || item.flowProjectUrl || null,
  });

  await page.goto(flowUrl, {
    waitUntil: options.waitUntil || 'domcontentloaded',
    timeout: Number.isFinite(options.gotoTimeoutMs) ? options.gotoTimeoutMs : 60_000,
  });
  try {
    await waitForFlowReady(page, options);
  } catch (err) {
    const screenshotPath = await saveFailureScreenshot(page, {
      screenshotsDir: options.screenshotsDir,
      item,
      stage: 'flow_ready',
    });
    throw new FlowAdapterError('timed out waiting for Flow project UI to load', {
      state: 'failed_timeout',
      exitCode: EXIT_CODES.timeout,
      stage: 'flow_ready',
      screenshotPath,
      cause: err,
    });
  }

  const classifyPageFn = typeof options.classifyPage === 'function'
    ? options.classifyPage
    : classifyPage;
  await configureVideoMode(page, options);
  await verifyVideoMode(page, { ...options, item });
  const initialBlocker = await detectBlocker(page, classifyPageFn);
  if (initialBlocker && !shouldIgnoreBlocker(initialBlocker, ['failed_tile'])) {
    const screenshotPath = await saveFailureScreenshot(page, {
      screenshotsDir: options.screenshotsDir,
      item,
      stage: `blocked_${initialBlocker.category || 'flow'}`,
    });
    throw new FlowAdapterError(initialBlocker.reason || 'Flow blocked the page before upload', {
      state: initialBlocker.state || 'failed_ui',
      exitCode: initialBlocker.exitCode || EXIT_CODES.ui,
      stage: `blocked_${initialBlocker.category || 'flow'}`,
      screenshotPath,
    });
  }

  await uploadStartFrame(page, imagePath, { ...options, item }, 'upload_start_frame');
  await verifyStartFrameAttached(page, { ...options, item });
  const postUploadBlocker = await detectBlocker(page, classifyPageFn);
  if (postUploadBlocker && !shouldIgnoreBlocker(postUploadBlocker, ['failed_tile'])) {
    const screenshotPath = await saveFailureScreenshot(page, {
      screenshotsDir: options.screenshotsDir,
      item,
      stage: `blocked_${postUploadBlocker.category || 'flow'}`,
    });
    throw new FlowAdapterError(postUploadBlocker.reason || 'Flow blocked the page after upload', {
      state: postUploadBlocker.state || 'failed_ui',
      exitCode: postUploadBlocker.exitCode || EXIT_CODES.ui,
      stage: `blocked_${postUploadBlocker.category || 'flow'}`,
      screenshotPath,
    });
  }

  await enterMotionPrompt(page, motion, { ...options, item }, 'enter_motion');
  await submitGeneration(page, { ...options, item }, 'submit_generation');

  const target = await awaitCompletedTile(page, { ...options, item, classifyPage: classifyPageFn });
  const helper = resolveDownloadHelper(options);
  if (!helper) {
    const screenshotPath = await saveFailureScreenshot(page, {
      screenshotsDir: options.screenshotsDir,
      item,
      stage: 'download_helper_missing',
    });
    throw new FlowAdapterError('video download helper is unavailable', {
      state: 'failed_download',
      exitCode: EXIT_CODES.generic,
      stage: 'download_helper_missing',
      screenshotPath,
    });
  }

  const expectedPath = await runDownloadHelper(helper, {
    page,
    item,
    motion,
    imagePath,
    videoPath,
    options: { ...options, item },
    target,
  });

  const stat = await validateVideoFile(expectedPath, options.minVideoBytes || DEFAULT_MIN_VIDEO_BYTES);
  return {
    state: 'saved',
    exitCode: EXIT_CODES.ok,
    videoPath: expectedPath,
    bytes: stat.size,
    flowUrl,
    flowProjectUrl: typeof page.url === 'function' ? page.url() : flowUrl,
    target,
  };
}

module.exports = {
  DEFAULT_FLOW_URL,
  DEFAULT_MIN_VIDEO_BYTES,
  DOWNLOAD_HELPER_NAMES,
  DOWNLOAD_TEXTS,
  FlowAdapterError,
  PROMPT_TEXTS,
  SUBMIT_TEXTS,
  UPLOAD_TEXTS,
  awaitCompletedTile,
  buildScreenshotPath,
  clickVisibleButton,
  configureVideoMode,
  decorateAndThrow,
  detectBlocker,
  enterMotionPrompt,
  findClickableByText,
  findCompletedTile,
  findDownloadTarget,
  findStartFrameDropTarget,
  findStartThumbnail,
  findSubmitButton,
  findTextInputBox,
  generateOne,
  hasActiveRenderProgress,
  openVideosTab,
  readBodyText,
  reloadAndRescan,
  verifyStartFrameAttached,
  verifyVideoMode,
  includesAnyText,
  normalizeDownloadResult,
  normalizeText,
  resolveDownloadHelper,
  resolveEntryUrl,
  runDownloadHelper,
  safePart,
  saveFailureScreenshot,
  submitGeneration,
  uploadStartFrame,
  validateVideoFile,
  waitForCompletion,
  waitForFlowReady,
};
