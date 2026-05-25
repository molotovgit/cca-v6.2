'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_MIN_MP4_BYTES = 50 * 1024;
const DOWNLOADABLE_URL_TYPES = new Set(['data', 'blob', 'http', 'https']);

function classifyDownloadUrl(rawUrl) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) return { kind: 'invalid', protocol: null };
  if (url.startsWith('data:')) return { kind: 'data', protocol: 'data:' };
  if (url.startsWith('blob:')) return { kind: 'blob', protocol: 'blob:' };
  if (url.startsWith('http://')) return { kind: 'http', protocol: 'http:' };
  if (url.startsWith('https://')) return { kind: 'https', protocol: 'https:' };
  return { kind: 'other', protocol: null };
}

function isDownloadableUrl(rawUrl) {
  return DOWNLOADABLE_URL_TYPES.has(classifyDownloadUrl(rawUrl).kind);
}

function ensureMp4Extension(name, fallbackStem = 'video') {
  const input = typeof name === 'string' ? name.trim() : '';
  const baseName = path.basename(input || fallbackStem);
  const cleaned = baseName || fallbackStem;
  const parsed = path.parse(cleaned);
  const stem = parsed.name || fallbackStem;
  return `${stem}.mp4`;
}

function resolveMp4OutputPath(targetPath, fallbackName = 'video.mp4') {
  const input = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!input) throw new Error('output path is required');

  const normalizedFallback = ensureMp4Extension(fallbackName);
  const hasTrailingSep = input.endsWith(path.sep) || input.endsWith('/') || input.endsWith('\\');
  const existsAsDir = !hasTrailingSep && fs.existsSync(input) && fs.statSync(input).isDirectory();

  if (hasTrailingSep || existsAsDir) {
    return path.join(input.replace(/[\/\\]+$/, ''), normalizedFallback);
  }

  const parsed = path.parse(input);
  const file = parsed.ext ? `${parsed.name}.mp4` : `${parsed.base}.mp4`;
  return path.join(parsed.dir || '.', file);
}

function buildAtomicTempPath(finalPath, opts = {}) {
  const absFinal = path.resolve(finalPath);
  const pid = Number.isInteger(opts.pid) ? opts.pid : process.pid;
  const now = Number.isFinite(opts.now) ? Math.trunc(opts.now) : Date.now();
  const nonce = typeof opts.nonce === 'string' && opts.nonce ? opts.nonce : `${pid}-${now}`;
  const suffix = typeof opts.suffix === 'string' && opts.suffix ? opts.suffix : '.tmp';
  return path.join(path.dirname(absFinal), `${path.basename(absFinal)}.${nonce}${suffix}`);
}

function atomicWriteFile(finalPath, data, opts = {}) {
  const absFinal = path.resolve(finalPath);
  fs.mkdirSync(path.dirname(absFinal), { recursive: true });
  const tmpPath = buildAtomicTempPath(absFinal, opts);

  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, absFinal);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch (_) {}
    throw err;
  }

  return absFinal;
}

function validateMp4Size(byteLength, minBytes = DEFAULT_MIN_MP4_BYTES) {
  const size = Number(byteLength);
  const min = Number(minBytes);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`invalid mp4 byte length: ${byteLength}`);
  }
  if (!Number.isFinite(min) || min <= 0) {
    throw new Error(`invalid minimum mp4 size: ${minBytes}`);
  }
  if (size < min) {
    const err = new Error(`mp4 too small: ${size} bytes < minimum ${min} bytes`);
    err.code = 'ERR_MP4_TOO_SMALL';
    err.bytes = size;
    err.minBytes = min;
    throw err;
  }
  return size;
}

function decodeDataUrl(rawUrl) {
  const url = String(rawUrl || '');
  const commaIdx = url.indexOf(',');
  if (commaIdx < 0) throw new Error('invalid data url');
  const meta = url.slice(5, commaIdx);
  const body = url.slice(commaIdx + 1);
  const isBase64 = /;base64(?:;|$)/i.test(meta);
  return isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
}

async function downloadBlobBuffer(page, blobUrl) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('page context is required to download blob: urls');
  }
  const bytes = await page.evaluate(async (src) => {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`blob fetch failed: HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, blobUrl);
  return Buffer.from(bytes);
}

function toHeaderCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return '';
  return cookies
    .filter(cookie => cookie && cookie.name)
    .map(cookie => `${cookie.name}=${cookie.value || ''}`)
    .join('; ');
}

function requestBuffer(url, headers = {}, redirectCount = 0, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;

    const req = transport.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname || ''}${parsed.search || ''}`,
      headers,
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        if (redirectCount >= maxRedirects) {
          reject(new Error(`too many redirects while downloading ${url}`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        res.resume();
        requestBuffer(nextUrl, headers, redirectCount + 1, maxRedirects).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} while downloading ${url}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('error', reject);
  });
}

async function downloadHttpBuffer(page, url, opts = {}) {
  const headers = {
    Accept: '*/*',
    ...(opts.headers || {}),
  };

  if (page && typeof page.cookies === 'function') {
    try {
      const cookies = await page.cookies(url);
      const cookieHeader = toHeaderCookies(cookies);
      if (cookieHeader) headers.Cookie = cookieHeader;
    } catch (_) {}
  }

  if (page && typeof page.evaluate === 'function') {
    try {
      const userAgent = await page.evaluate(() => navigator.userAgent);
      if (userAgent) headers['User-Agent'] = userAgent;
    } catch (_) {}
  }

  if (opts.referer) {
    headers.Referer = opts.referer;
  } else if (opts.pageUrl) {
    headers.Referer = opts.pageUrl;
  }

  return requestBuffer(url, headers, 0, opts.maxRedirects || 5);
}

async function downloadMp4Buffer(page, sourceUrl, opts = {}) {
  const kind = classifyDownloadUrl(sourceUrl).kind;
  if (kind === 'data') return decodeDataUrl(sourceUrl);
  if (kind === 'blob') return downloadBlobBuffer(page, sourceUrl);
  if (kind === 'http' || kind === 'https') return downloadHttpBuffer(page, sourceUrl, opts);
  throw new Error(`unsupported download url: ${sourceUrl}`);
}

async function downloadMp4ToFile(page, sourceUrl, outPath, opts = {}) {
  const finalPath = resolveMp4OutputPath(outPath, opts.fallbackName || 'video.mp4');
  const minBytes = opts.minBytes == null ? DEFAULT_MIN_MP4_BYTES : opts.minBytes;
  const buf = await downloadMp4Buffer(page, sourceUrl, opts);
  validateMp4Size(buf.length, minBytes);
  atomicWriteFile(finalPath, buf, opts.atomic || {});
  return {
    filePath: finalPath,
    bytes: buf.length,
  };
}

module.exports = {
  DEFAULT_MIN_MP4_BYTES,
  atomicWriteFile,
  buildAtomicTempPath,
  classifyDownloadUrl,
  decodeDataUrl,
  downloadBlobBuffer,
  downloadHttpBuffer,
  downloadMp4Buffer,
  downloadMp4ToFile,
  ensureMp4Extension,
  isDownloadableUrl,
  resolveMp4OutputPath,
  requestBuffer,
  toHeaderCookies,
  validateMp4Size,
};
