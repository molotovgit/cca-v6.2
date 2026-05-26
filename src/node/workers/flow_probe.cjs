// flow_probe.cjs — CDP discovery harness for the Google Flow video UI.
//
// A live Flow smoke test never reached a completed video tile, so the
// completed-tile DOM and the MP4 download mechanism are UNKNOWN. This harness
// is meant to be RUN LIVE BY A HUMAN against a real project so it can capture
// those unknowns: it connects to an existing Chrome over CDP, opens the
// Videos / All Media tab, snapshots the media tiles, and writes a JSON report
// + screenshot under data/.cca/flow_probe/.
//
// The DOM-reduction logic lives in the PURE, exported `extractMediaReport`
// (no browser, no I/O) so it can be unit-tested. The `page.evaluate` body only
// produces the raw `snapshot` array; `extractMediaReport` ranks/labels it.
//
// Usage (human, live):
//   node src/node/workers/flow_probe.cjs [projectUrl]
//   CCA_FLOW_PROJECT_URL=... node src/node/workers/flow_probe.cjs
'use strict';

const path = require('path');
const fs = require('fs');

const flowUi = require('../video/flow_ui.cjs');

const REPO = path.resolve(__dirname, '../../..');
// Output is ALWAYS confined to this fixed, in-repo directory. Filenames are
// built from a sanitized timestamp only — never from user/argv input — so the
// probe cannot be steered outside OUT_DIR (no path traversal surface).
const OUT_DIR = path.join(REPO, 'data', '.cca', 'flow_probe');
const DEFAULT_CDP_PORT = parseInt(process.env.GEMINI_CDP_PORT || process.env.FLOW_CDP_PORT || '9223', 10);
const DEFAULT_PROJECT_URL =
  'https://labs.google/fx/tools/flow/project/a14d1a43-d896-4da3-a84b-ebb5195b1b55';

// Tab-click order with hardcoded, lowercase substring needles. We match tab
// labels by plain substring (no dynamic RegExp) so the click logic carries no
// ReDoS surface. The canonical regexes live in flow_ui.MEDIA_TABS; these
// needles are the literal tokens those regexes look for in the observed labels.
const MEDIA_TAB_NEEDLES = [
  { key: 'videos', needles: ['view videos videos', 'videocam', 'videos'] },
  { key: 'allMedia', needles: ['all media'] },
];

// NOTE: flow_ui.PROGRESS_RE is the frozen selectors contract, but its trailing
// `\b` after `%` means it does not actually match real "99%" strings. For the
// in-progress heuristic we use a local, working matcher; PROGRESS_RE stays
// exported verbatim for downstream callers / future correction.
const PROGRESS_LOCAL_RE = /(\d{1,3})\s*%/;

/**
 * Pure DOM-reduction core. Takes the raw `snapshot` array captured in the page
 * and ranks/labels likely completed tiles + download candidates. NO browser,
 * NO I/O — this is the unit-tested surface.
 *
 * @param {Array<{outerHTMLExcerpt?:string, ariaLabels?:string[], videoSrcs?:string[], buttonLabels?:string[]}>} snapshot
 * @returns {{tiles:Array, videoUrls:string[], downloadCandidates:Array, notes:string[]}}
 */
function extractMediaReport(snapshot) {
  const notes = [];
  if (!Array.isArray(snapshot)) {
    return { tiles: [], videoUrls: [], downloadCandidates: [], notes: ['snapshot was not an array'] };
  }

  const tiles = [];
  const videoUrls = [];
  const downloadCandidates = [];

  snapshot.forEach((raw, index) => {
    const entry = raw && typeof raw === 'object' ? raw : {};
    const ariaLabels = Array.isArray(entry.ariaLabels) ? entry.ariaLabels.filter(s => typeof s === 'string') : [];
    const videoSrcs = Array.isArray(entry.videoSrcs) ? entry.videoSrcs.filter(s => typeof s === 'string') : [];
    const buttonLabels = Array.isArray(entry.buttonLabels) ? entry.buttonLabels.filter(s => typeof s === 'string') : [];
    const html = typeof entry.outerHTMLExcerpt === 'string' ? entry.outerHTMLExcerpt : '';

    // Combined text used for activity / failure / download heuristics.
    const text = [html, ...ariaLabels, ...buttonLabels].join(' ');

    const progressMatch = text.match(PROGRESS_LOCAL_RE);
    const progress = progressMatch ? parseInt(progressMatch[1], 10) : null;
    const isActive = flowUi.ACTIVITY_RE.test(text) || (progress != null && progress < 100);
    const failed = flowUi.isFailedCard(text);

    // Download affordance: explicit button label OR a usable video source.
    const downloadButtons = buttonLabels.filter(label => /download|save/i.test(label));
    const usableVideoSrcs = videoSrcs.filter(src => /^(blob:|https?:|data:)/i.test(src) && !/^blob:\s*$/i.test(src));

    // A tile is "likely completed" when it has a real video source / download
    // affordance and is NOT mid-render and NOT a failed card.
    const hasMedia = usableVideoSrcs.length > 0 || downloadButtons.length > 0;
    const likelyCompleted = hasMedia && !isActive && !failed;

    let label;
    if (failed) label = 'failed';
    else if (isActive) label = 'in_progress';
    else if (likelyCompleted) label = 'likely_completed';
    else label = 'unknown';

    // Confidence: media present + terminal state ranks highest.
    let score = 0;
    if (usableVideoSrcs.length) score += 0.5;
    if (downloadButtons.length) score += 0.3;
    if (likelyCompleted) score += 0.2;
    if (isActive) score -= 0.4;
    if (failed) score -= 0.5;

    const tile = {
      index,
      label,
      likelyCompleted,
      isActive,
      failed,
      progress,
      videoSrcs: usableVideoSrcs,
      downloadButtons,
      ariaLabels,
      score: Math.round(score * 100) / 100,
    };
    tiles.push(tile);

    usableVideoSrcs.forEach(src => {
      if (!videoUrls.includes(src)) videoUrls.push(src);
    });

    if (hasMedia) {
      downloadCandidates.push({
        index,
        label,
        likelyCompleted,
        videoSrcs: usableVideoSrcs,
        downloadButtons,
        score: tile.score,
      });
    }
  });

  // Rank completed/download candidates highest.
  tiles.sort((a, b) => b.score - a.score);
  downloadCandidates.sort((a, b) => b.score - a.score);

  if (!tiles.length) notes.push('no tiles found in snapshot');
  if (!videoUrls.length) notes.push('no usable video URLs surfaced — COMPLETED_TILE_SELECTOR / DOWNLOAD_AFFORDANCE still unknown (TODO live)');
  if (tiles.some(t => t.isActive)) notes.push('one or more tiles still in progress');
  if (tiles.some(t => t.failed)) notes.push('one or more failed cards present (non-terminal / advisory)');
  if (downloadCandidates.length) notes.push(`${downloadCandidates.length} download candidate(s) found`);

  return { tiles, videoUrls, downloadCandidates, notes };
}

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Build a filesystem-safe stamp from a Date. Strips anything that is not an
// ASCII alphanumeric or dash so it can never introduce path separators or
// traversal sequences into a filename.
function safeStamp(date = new Date()) {
  return date.toISOString().replace(/[^0-9a-zA-Z]/g, '-');
}

// page.evaluate body, kept as a named function for clarity. Runs IN THE PAGE,
// so it must be self-contained (no closure over Node-side variables). It only
// produces the raw snapshot; ranking/labeling happens in extractMediaReport.
/* istanbul ignore next */
function snapshotMediaInPage() {
  const MAX = 60;
  const nodes = Array.from(
    document.querySelectorAll('[role="listitem"], [data-testid], figure, article, .media-tile, video')
  ).slice(0, MAX);
  return nodes.map(node => {
    const root = node.closest('[role="listitem"], figure, article') || node;
    const videos = Array.from(root.querySelectorAll('video'));
    const videoSrcs = [];
    videos.forEach(v => {
      if (v.src) videoSrcs.push(v.src);
      if (v.currentSrc && v.currentSrc !== v.src) videoSrcs.push(v.currentSrc);
      Array.from(v.querySelectorAll('source')).forEach(s => { if (s.src) videoSrcs.push(s.src); });
    });
    const buttons = Array.from(root.querySelectorAll('button, [role="button"], a[download]'));
    const buttonLabels = buttons.map(b =>
      (b.getAttribute('aria-label') || b.textContent || '').trim()
    ).filter(Boolean);
    const ariaLabels = [];
    const al = root.getAttribute('aria-label');
    if (al) ariaLabels.push(al);
    Array.from(root.querySelectorAll('[aria-label]')).forEach(el => {
      const v = el.getAttribute('aria-label');
      if (v) ariaLabels.push(v);
    });
    return {
      outerHTMLExcerpt: (root.outerHTML || '').slice(0, 1500),
      ariaLabels,
      videoSrcs,
      buttonLabels,
    };
  });
}

function getPuppeteer() {
  return require('puppeteer');
}

/**
 * Thin live wrapper. Connects to an already-running Chrome over CDP, opens the
 * Videos / All Media tab, snapshots tiles, and writes report + screenshot.
 * Intended to be run by a human against a live session — not exercised by tests.
 *
 * Output files are always written into the fixed OUT_DIR using basename-only,
 * sanitized-timestamp filenames, so the (parameterizable) projectUrl cannot
 * influence where files land.
 */
/* istanbul ignore next */
async function runProbe({
  projectUrl = process.argv[2] || process.env.CCA_FLOW_PROJECT_URL || DEFAULT_PROJECT_URL,
  cdpPort = DEFAULT_CDP_PORT,
} = {}) {
  const puppeteer = getPuppeteer();
  const stamp = safeStamp();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Filenames are basenames built from a sanitized stamp only; join is against
  // the fixed OUT_DIR constant, so there is no path-traversal surface.
  const reportPath = path.join(OUT_DIR, `probe-${stamp}.json`);
  const screenshotPath = path.join(OUT_DIR, `probe-${stamp}.jpg`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${cdpPort}`,
    defaultViewport: null,
  });

  const result = { projectUrl, cdpPort, startedAt: stamp, navigated: false, tabClicked: null };
  let page;
  try {
    page = await browser.newPage();
    await page.goto(projectUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    result.navigated = true;

    // Try to click the Videos tab, then fall back to All Media. The tabs only
    // appear once media exists, so failures are tolerated and just recorded.
    result.tabClicked = await clickMediaTab(page).catch(err => `tab click failed: ${err.message}`);

    await page.waitForNetworkIdle({ timeout: 8000 }).catch(() => {});

    const snapshot = await page.evaluate(snapshotMediaInPage).catch(() => []);
    const report = extractMediaReport(snapshot);

    await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 70, fullPage: true }).catch(() => {});
    writeJson(reportPath, { ...result, screenshotPath, rawSnapshotCount: snapshot.length, report });

    process.stdout.write(`flow_probe: wrote ${reportPath}\n`);
    process.stdout.write(`flow_probe: ${report.notes.join('; ')}\n`);
    return { reportPath, screenshotPath, report };
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}

/* istanbul ignore next */
async function clickMediaTab(page) {
  for (const { key, needles } of MEDIA_TAB_NEEDLES) {
    // Plain, case-insensitive substring match against hardcoded needles — no
    // dynamic RegExp, so no ReDoS surface even though labels are page-derived.
    const clicked = await page.evaluate((needleList) => {
      const els = Array.from(document.querySelectorAll('a, button, [role="tab"], [role="button"]'));
      const hit = els.find(el => {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        return needleList.some(n => label.includes(n));
      });
      if (hit) { hit.click(); return true; }
      return false;
    }, needles).catch(() => false);
    if (clicked) return key;
  }
  return null;
}

module.exports = {
  extractMediaReport,
  runProbe,
  snapshotMediaInPage,
  readJsonOr,
  writeJson,
  safeStamp,
  OUT_DIR,
  DEFAULT_PROJECT_URL,
  DEFAULT_CDP_PORT,
};

/* istanbul ignore next */
if (require.main === module) {
  runProbe().catch(err => {
    process.stderr.write(`flow_probe failed: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
}
