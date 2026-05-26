// CONTINUOUS image saver — scans all Gemini tabs in the browser, saves any
// rendered image to disk, marks the tab as saved, and closes the tab.
// Reads .cca/tab_map.json (written by submit_prompts.cjs) for tab → entry mapping.
//
// Usage:
//   node scripts/save_images.cjs <prompts.json>          # exits when all expected saved
//   node scripts/save_images.cjs <prompts.json> --watch  # poll forever
//   node scripts/save_images.cjs <prompts.json> --no-close

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
// Additive diagnostics (ROADMAP Phase 3, Lane B). Best-effort JSONL of blocker
// events alongside the existing blocker_alerts.json — never alters control flow.
const diag      = require('../utils/diag_events.cjs');

const CDP_PORT  = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POLL_MS = 3000;

const REPO     = path.resolve(__dirname, '../../..');
const STATE_DIR = path.join(REPO, 'data', '.cca');
const TAB_MAP_FILE       = path.join(STATE_DIR, 'tab_map.json');
const SAVED_FILE         = path.join(STATE_DIR, 'saved_indices.json');
const BLOCKER_ALERTS_FILE = path.join(STATE_DIR, 'blocker_alerts.json');
// Additive diagnostics sink: append-only JSONL of blocker events.
const BLOCKER_EVENTS_FILE = path.join(STATE_DIR, 'blocker_events.jsonl');

// v6.2: per-saver download intercept dir. The in-chat <img> blob is a 1024x572
// preview; the real generated image (2752x1536 / 2528x1696) only arrives via
// the "Download full size image" button on the message. We point Chrome's
// download path at this dir, click the button, and move the resulting
// Gemini_Generated_Image_<guid>.png into our chapter dir with the right name.
const DOWNLOAD_DIR = path.join(STATE_DIR, 'gemini_downloads');

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // pid-suffix the .tmp so concurrent writers don't share the same file
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Best-effort cleanup if rename fails; don't crash the process
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (e.code !== 'ENOENT') throw e;
  }
}

function deriveOutputDir(promptsJsonPath) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = 'images';
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

async function findNewImageOnTab(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    let best = null;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      // width gate only — Gemini varies aspect ratio per prompt; "wide" prompts
      // can produce 456×193 images that the prior height>=200 check rejected.
      // Avatars are filtered by URL pattern below, not by size.
      if (r.width < 200) continue;
      if (r.width * r.height < 30_000) continue;  // area floor catches small UI bits
      const src = img.src || '';
      if (!src) continue;
      if (/lh3\.googleusercontent\.com\/a\//.test(src)) continue;
      if (/avatar|profile|logo|emoji/i.test(src)) continue;
      const area = r.width * r.height;
      if (!best || area > best.area) {
        best = { src, w: Math.round(r.width), h: Math.round(r.height), area };
      }
    }
    return best;
  }).catch(() => null);
}

// Detect Gemini failure modes that look like "tab is pending forever" but are
// actually unrecoverable for this account: 1095 content-policy + daily quota.
// Returns 'quota' | '1095' | null.
async function detectBlocker(page) {
  try {
    let title = '';
    try { title = await page.title() || ''; } catch (_) {}
    if (/Image Generation Limit/i.test(title)) return 'quota';
    if (/(I can.{1,5}help with that|can't help)/i.test(title)) return '1095';
    // Body-text fallback for explicit error codes / policy strings
    const body = await page.evaluate(() =>
      ((document.body && document.body.innerText) || '').slice(0, 2500)
    ).catch(() => '');
    if (/error 1095|gemini\.google\.com\/.*1095/i.test(body)) return '1095';
    if (/Image Generation Limit Reached/i.test(body)) return 'quota';
    if (/I can.{1,5}help with that|safety policy|content policy/i.test(body)) return '1095';
    return null;
  } catch (_) { return null; }
}

function recordBlocker(idx, slug, type) {
  let alerts = readJsonOr(BLOCKER_ALERTS_FILE, []);
  if (!Array.isArray(alerts)) alerts = [];
  alerts.push({ t: Date.now(), idx, slug, type });
  // Keep last 200 only
  if (alerts.length > 200) alerts.splice(0, alerts.length - 200);
  writeJson(BLOCKER_ALERTS_FILE, alerts);
  // DIAG (additive): also append a structured blocker event to the JSONL stream.
  // Best-effort and wrapped — must never affect the existing alert write or the
  // saver's control flow.
  try {
    diag.appendEvent(BLOCKER_EVENTS_FILE, diag.formatEvent({ type: 'blocker', idx, slug, blockerType: type }), { fs });
  } catch (_) { /* diagnostics are best-effort */ }
}

// Orphan recovery: scan every Gemini conversation tab and return entries
// for tabs that (a) are NOT in tab_map and (b) carry an image whose
// "More options for <prompt>" aria-label matches a known prompt in
// prompts.json that hasn't already been saved. These can arise when
// submit_prompts.cjs is killed after sending a prompt but before writing
// the tab_map entry (orchestrator restart, rotation, etc.), so the saver
// would normally never iterate them.
async function findOrphanTabs(browser, tabMap, prompts, savedIdxs) {
  const orphans = [];
  // Build a quick lookup: image_prompt body -> entry. Strip the resolution
  // preamble we prepend at submit time so the comparison key matches the
  // raw scene text Gemini echoes back in its "More options for ..." label.
  const PREAMBLE_RX = /^4K UHD resolution[^,]*,\s*\d+x\d+,\s*16:9[^,]*,\s*ultra[^,]*,\s*ultra[^,]*,\s*highly[^,]*,\s*crisp[^,]*,\s*fine[^,]*,\s*professional[^,]*,\s*no blur,\s*no compression,\s*/i;
  const promptIndex = new Map();
  for (const p of prompts) {
    if (savedIdxs.has(p.idx)) continue;
    const key = (p.image_prompt || '').replace(/\s+/g, ' ').trim();
    // Use the first 80 chars as the fingerprint to keep matches robust
    // against minor whitespace/punctuation changes Gemini might apply.
    if (key.length >= 30) promptIndex.set(key.slice(0, 80), p);
  }
  if (promptIndex.size === 0) return orphans;

  for (const ctx of browser.browserContexts()) {
    for (const page of await ctx.pages()) {
      const url = (page.url() || '');
      if (!/gemini\.google\.com\/app/.test(url)) continue;
      let tid;
      try { tid = page.target()._targetId; } catch (_) { continue; }
      if (tabMap[tid]) continue;  // already tracked

      // Pull the "More options for <prompt>" aria-label off the page. If
      // there are multiple, pick the longest (the user-message variant is
      // typically the longest because it contains the full preamble+scene).
      const promptText = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('button,[role=button]'))
          .map(b => (b.getAttribute('aria-label') || '').trim())
          .filter(l => /^more options for /i.test(l))
          .map(l => l.replace(/^more options for /i, '').trim());
        if (!labels.length) return '';
        labels.sort((a, b) => b.length - a.length);
        return labels[0];
      }).catch(() => '');
      if (!promptText) continue;

      const stripped = promptText.replace(PREAMBLE_RX, '').replace(/\s+/g, ' ').trim();
      const probe = stripped.slice(0, 80);
      const match = promptIndex.get(probe);
      if (match) {
        orphans.push({ page, tid, entry: { idx: match.idx, slug: match.slug } });
      }
    }
  }
  return orphans;
}

async function isStillGenerating(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button, [role=button]'))
      .some(b => /^Stop /i.test(b.getAttribute('aria-label') || '') ||
                 /^Stop$/i.test((b.innerText || '').trim()))
  ).catch(() => false);
}

async function exportToBuffer(page, src) {
  if (src.startsWith('data:image')) {
    return Buffer.from(src.split(',', 2)[1], 'base64');
  }
  if (src.startsWith('blob:')) {
    const dataUrl = await page.evaluate((s) => {
      const img = Array.from(document.querySelectorAll('img')).find(i => i.src === s);
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width  = img.naturalWidth  || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    }, src);
    if (!dataUrl) throw new Error('canvas export failed');
    return Buffer.from(dataUrl.split(',', 2)[1], 'base64');
  }
  const arr = await page.evaluate(async (url) => {
    const r = await fetch(url);
    const ab = await r.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, src);
  return Buffer.from(arr);
}

// v6.2: Click the "Download full size image" button on a Gemini message and
// capture the resulting Gemini_Generated_Image_*.png that lands in DOWNLOAD_DIR.
// Returns the absolute path of the downloaded file, or throws on timeout.
//
// Race-safety: takes a snapshot of existing files in DOWNLOAD_DIR before the
// click, then watches for a new entry (set-difference). Since the saver loop
// processes one tab at a time, the only way another file could appear is an
// external actor — extremely unlikely during a run.
// Gemini delivers the full-size image as PNG sometimes and as JPEG (.jpg /
// .jfif) other times — appears to depend on account / session / experiment.
// Match every plausible image extension Chrome assigns when serving Gemini's
// download. Bytes are always a valid image regardless of extension.
const GEMINI_DL_RX = /^Gemini_Generated_Image.*\.(png|jpe?g|jfif|webp)$/i;

function snapshotDownloads(dirs) {
  const seen = new Map();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!GEMINI_DL_RX.test(f)) continue;
      seen.set(path.join(d, f), true);
    }
  }
  return seen;
}

// Selector that recognises "Download full size image" (English + localised
// variants we've observed) on a Gemini message toolbar. Centralised so the
// poll-wait and direct-click code paths stay in sync.
const DL_BUTTON_SELECTOR_FN = () => {
  const btns = Array.from(document.querySelectorAll('button,[role=button]'));
  const labelMatchers = [
    /^download full size image$/i,
    /download full size/i,
    /download.*image/i,
    /\bscarica\b.*\bimmagine\b/i,             // Italian: "Scarica immagine"
    /(скачать|загрузить).*изображен/i,         // Russian: "Скачать изображение"
    /(скачать|загрузить).*полн/i,             // Russian: "...полноразмерное"
    /yuklab.*olish/i,                          // Uzbek: "yuklab olish"
    /to'?liq.*o'?lcham/i,                      // Uzbek: "to'liq o'lchamdagi rasm"
    /полный.*размер/i,                         // Russian variant
  ];
  for (const rx of labelMatchers) {
    const hit = btns.find(b => rx.test((b.getAttribute('aria-label') || '').trim())
                              || rx.test((b.innerText || '').trim()));
    if (hit) return hit;
  }
  return null;
};

async function clickAndCaptureDownload(page, watchDirs, timeoutMs = 20_000) {
  for (const d of watchDirs) fs.mkdirSync(d, { recursive: true });
  const before = snapshotDownloads(watchDirs);

  // 1. Poll for the download button: Gemini may inject the toolbar a beat
  //    after the image finishes rendering. Wait up to 5s before giving up.
  let clicked = false;
  const findStart = Date.now();
  while (Date.now() - findStart < 5_000) {
    clicked = await page.evaluate((fnStr) => {
      const fn = new Function('return ' + fnStr)();
      const btn = fn();
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }, DL_BUTTON_SELECTOR_FN.toString()).catch(() => false);
    if (clicked) break;
    await sleep(300);
  }

  // 2. If the direct button isn't visible, the menu may be collapsed.
  //    Click "More options" / "Show more options" / "Ещё" first, then look
  //    again inside the opened popup.
  if (!clicked) {
    const openedMenu = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button,[role=button]'));
      // Prefer the per-message "More options for ..." button (one per
      // generated image) over the global "Show more options" gear.
      const moreBtn = cands.find(b => /^more options for /i.test(
        (b.getAttribute('aria-label') || '').trim()
      )) || cands.find(b => /^show more options$/i.test(
        (b.getAttribute('aria-label') || '').trim()
      )) || cands.find(b => /(more options|показать ещё|больше параметров|ko'?proq)/i.test(
        b.getAttribute('aria-label') || b.innerText || ''
      ));
      if (!moreBtn) return false;
      moreBtn.scrollIntoView({ block: 'center' });
      moreBtn.click();
      return true;
    }).catch(() => false);
    if (openedMenu) {
      await sleep(450);
      // Retry the download-button click inside the now-open menu.
      const findStart2 = Date.now();
      while (Date.now() - findStart2 < 3_000) {
        clicked = await page.evaluate((fnStr) => {
          const fn = new Function('return ' + fnStr)();
          const btn = fn();
          if (!btn) return false;
          btn.click();
          return true;
        }, DL_BUTTON_SELECTOR_FN.toString()).catch(() => false);
        if (clicked) break;
        await sleep(200);
      }
    }
  }

  if (!clicked) {
    // Dump a small diagnostic so the orchestrator log shows what aria-labels
    // WERE on the page — speeds up future regex extension.
    const dump = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button,[role=button]'))
        .map(b => (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 80))
        .filter(s => s.length > 0)
        .slice(0, 12);
    }).catch(() => []);
    throw new Error('Download full size image button not found. Visible labels (sample): '
      + JSON.stringify(dump));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = snapshotDownloads(watchDirs);
    const fresh = [];
    for (const p of now.keys()) if (!before.has(p)) fresh.push(p);
    if (fresh.length) {
      // Pick the newest by mtime if multiple
      const full = fresh
        .map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0].p;
      // Wait until size stops changing (download still in flight)
      let last = -1; let stable = 0;
      while (Date.now() < deadline) {
        const sz = fs.statSync(full).size;
        if (sz === last && sz > 1024) { stable++; if (stable >= 3) break; }
        else { stable = 0; last = sz; }
        await sleep(150);
      }
      return full;
    }
    await sleep(150);
  }
  throw new Error('timed out waiting for Gemini download to appear in ' + watchDirs.join(' or '));
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node save_images.cjs <prompts.json> [--watch] [--no-close]');
    process.exit(1);
  }
  const watchMode = process.argv.includes('--watch');
  const closeTabs = !process.argv.includes('--no-close');
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const outDir = deriveOutputDir(promptsPath);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[save] watching ${path.basename(promptsPath)}  (${prompts.length} expected)`);
  console.log(`[save] output: ${outDir}`);
  console.log(`[save] close-tabs after save: ${closeTabs}, watch: ${watchMode}`);

  const savedIdxs = new Set(readJsonOr(SAVED_FILE, []));
  for (const entry of prompts) {
    const expected = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.png`);
    if (fs.existsSync(expected) && fs.statSync(expected).size > 5 * 1024) {
      savedIdxs.add(entry.idx);
    }
  }
  writeJson(SAVED_FILE, [...savedIdxs]);
  console.log(`[save] starting with ${savedIdxs.size} already-saved entries`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${CDP_PORT}`,
    defaultViewport: null,
  });

  // v6.2: configure Chrome's download path for this browser. Browser-level
  // CDP is the modern API; we also try the deprecated Page-level form as a
  // belt-and-suspenders fallback. If both fail the click flow still works
  // because we watch the user's default Downloads folder too — see the
  // WATCH_DIRS list below.
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const USER_DOWNLOADS = path.join(require('os').homedir(), 'Downloads');
  const WATCH_DIRS = [DOWNLOAD_DIR, USER_DOWNLOADS];
  try {
    const bSession = await browser.target().createCDPSession();
    await bSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: false,
    });
    console.log(`[save] downloads redirected via CDP to ${DOWNLOAD_DIR}`);
  } catch (e) {
    console.log(`[save] CDP download redirect failed (${e.message}); will watch ${USER_DOWNLOADS}`);
  }

  let iter = 0;
  while (true) {
    iter++;
    const tabMap = readJsonOr(TAB_MAP_FILE, {});

    const wantedTids = new Set(
      Object.entries(tabMap)
        .filter(([_tid, m]) => !savedIdxs.has(m.idx))
        .map(([tid]) => tid)
    );

    // Pre-pass: discover orphan tabs (image rendered but no tab_map entry)
    // and SYNTHESISE tab_map rows for them, so the main scan below treats
    // them identically to normal tabs.
    let orphansSeen = 0;
    try {
      const orphans = await findOrphanTabs(browser, tabMap, prompts, savedIdxs);
      if (orphans.length) {
        for (const o of orphans) {
          tabMap[o.tid] = { ...o.entry, prompts_path: path.resolve(promptsPath), submitted_at: '', recovered: true };
          wantedTids.add(o.tid);
          orphansSeen++;
        }
        writeJson(TAB_MAP_FILE, tabMap);
        console.log(`[save] iter ${iter}: recovered ${orphansSeen} orphan tab(s) into tab_map (idx ${orphans.map(o => o.entry.idx).join(',')})`);
      }
    } catch (e) {
      console.log(`[save] orphan scan error: ${e.message}`);
    }

    let scanned = 0, savedThisIter = 0;
    for (const ctx of browser.browserContexts()) {
      for (const page of await ctx.pages()) {
        let tid;
        try { tid = page.target()._targetId; } catch (_) { continue; }
        if (!wantedTids.has(tid)) continue;
        const entry = tabMap[tid];
        if (!entry) continue;

        scanned++;

        // Wake the background tab WITHOUT stealing focus. screenshot() forces
        // a render; we discard the bytes. Hard 4s timeout so a hung tab can't
        // freeze the entire saver loop.
        try {
          await Promise.race([
            page.screenshot({ type: 'jpeg', quality: 1, fullPage: false }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 4000)),
          ]);
        } catch (_) {}
        // Override visibility state — some apps pause rendering when hidden
        try {
          await Promise.race([
            page.evaluate(() => {
              try {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
                document.dispatchEvent(new Event('visibilitychange'));
              } catch (_) {}
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('eval timeout')), 3000)),
          ]);
        } catch (_) {}
        await sleep(200);

        // Image-first check: Gemini's "Stop" button sometimes stays mounted
        // even after the image is fully rendered (known UI quirk). The OLD
        // logic of `if (isStillGenerating) continue` would then skip the tab
        // forever even though the image was sitting right there ready to
        // capture. Now: look for the image first, and ONLY treat "Stop button
        // present" as a reason to skip if there's no image yet.
        const found = await findNewImageOnTab(page);
        if (!found) {
          if (await isStillGenerating(page)) continue;
          // Tab is no longer generating AND has no image — check for known blockers
          // (1095 content-policy / daily-quota). If detected, record an alert so the
          // orchestrator can decide to rotate accounts; close the tab so the queue
          // keeps moving regardless.
          const blocker = await detectBlocker(page);
          if (blocker) {
            console.log(`[save] ${String(entry.idx).padStart(3, '0')} BLOCKER ${blocker.toUpperCase()} on ${entry.slug}  → recording alert + closing tab`);
            recordBlocker(entry.idx, entry.slug, blocker);
            if (closeTabs) {
              try { await page.close(); } catch (_) {}
              const m2 = readJsonOr(TAB_MAP_FILE, {});
              delete m2[tid];
              writeJson(TAB_MAP_FILE, m2);
            }
          }
          continue;
        }

        try {
          // v6.2: the in-chat <img> is a 1024x572 preview blob. Click the
          // "Download full size image" button instead — that delivers the
          // native ~2752x1536 render Gemini actually generated. Source file
          // may arrive as .png, .jpg, or .jfif depending on Gemini's session;
          // we always rename to .png so the rest of the pipeline (which
          // filters by *.png) treats every image uniformly. The bytes inside
          // are still a valid image — viewers, browsers, and Notion all
          // sniff magic bytes rather than trusting the extension.
          const dlPath = await clickAndCaptureDownload(page, WATCH_DIRS, 20_000);
          const outFile = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.png`);
          fs.renameSync(dlPath, outFile);  // atomic move; deletes the source
          const sz = fs.statSync(outFile).size;
          // Best-effort dimension read — recognise PNG IHDR + JPEG SOF markers.
          let dims = '';
          let kind = '?';
          try {
            const fd = fs.openSync(outFile, 'r');
            const hdr = Buffer.alloc(4096);
            fs.readSync(fd, hdr, 0, 4096, 0);
            fs.closeSync(fd);
            if (hdr[0] === 0x89 && hdr.slice(1, 4).toString() === 'PNG') {
              kind = 'PNG';
              dims = `${hdr.readUInt32BE(16)}x${hdr.readUInt32BE(20)}`;
            } else if (hdr[0] === 0xFF && hdr[1] === 0xD8 && hdr[2] === 0xFF) {
              kind = 'JPEG';
              let i = 2;
              while (i < hdr.length - 8) {
                if (hdr[i] === 0xFF) {
                  const m = hdr[i + 1];
                  const isSof = (m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7)
                              || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF);
                  if (isSof) {
                    const h = hdr.readUInt16BE(i + 5);
                    const w = hdr.readUInt16BE(i + 7);
                    dims = `${w}x${h}`;
                    break;
                  }
                  const segLen = hdr.readUInt16BE(i + 2);
                  i += 2 + segLen;
                } else {
                  i++;
                }
              }
            }
          } catch (_) {}
          savedIdxs.add(entry.idx);
          writeJson(SAVED_FILE, [...savedIdxs]);
          savedThisIter++;
          console.log(`[save] ${String(entry.idx).padStart(3, '0')} ${entry.slug}  → ${kind} ${dims || '?'} ${(sz / 1024).toFixed(0)} KB`);

          if (closeTabs) {
            try { await page.close(); } catch (_) {}
            const m2 = readJsonOr(TAB_MAP_FILE, {});
            delete m2[tid];
            writeJson(TAB_MAP_FILE, m2);
          }
        } catch (e) {
          console.log(`[save] ${String(entry.idx).padStart(3, '0')} export error: ${e.message}`);
        }
      }
    }

    if ((iter % 4) === 1) {
      console.log(`[save] iter ${iter}: ${scanned} pending tabs, +${savedThisIter} this round  (total ${savedIdxs.size}/${prompts.length})`);
    }

    if (savedIdxs.size >= prompts.length && !watchMode) {
      console.log(`[save] all ${prompts.length} saved — exiting`);
      break;
    }

    await sleep(POLL_MS);
  }

  console.log(`\n[save] DONE — ${savedIdxs.size} / ${prompts.length} saved`);
  console.log(`[save] images at: ${outDir}`);
  await browser.disconnect();
})();
