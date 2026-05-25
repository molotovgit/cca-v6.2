'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  DEFAULT_MIN_MP4_BYTES,
  atomicWriteFile,
  buildAtomicTempPath,
  classifyDownloadUrl,
  downloadMp4Buffer,
  downloadMp4ToFile,
  ensureMp4Extension,
  isDownloadableUrl,
  resolveMp4OutputPath,
  validateMp4Size,
} = require('./video_download.cjs');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'video-download-test-'));
}

test('classifyDownloadUrl recognizes supported url types', () => {
  assert.deepEqual(classifyDownloadUrl('data:video/mp4;base64,AA=='), { kind: 'data', protocol: 'data:' });
  assert.deepEqual(classifyDownloadUrl('blob:https://example.test/123'), { kind: 'blob', protocol: 'blob:' });
  assert.deepEqual(classifyDownloadUrl('http://example.test/video.mp4'), { kind: 'http', protocol: 'http:' });
  assert.deepEqual(classifyDownloadUrl('https://example.test/video.mp4'), { kind: 'https', protocol: 'https:' });
  assert.equal(isDownloadableUrl('ftp://example.test/video.mp4'), false);
});

test('ensureMp4Extension strips path segments and enforces .mp4', () => {
  assert.equal(ensureMp4Extension('nested/name.mov'), 'name.mp4');
  assert.equal(ensureMp4Extension('clip.mp4'), 'clip.mp4');
  assert.equal(ensureMp4Extension('', 'fallback'), 'fallback.mp4');
});

test('resolveMp4OutputPath handles directories and file paths', () => {
  const dir = path.join('/tmp', 'flow-download-out');
  assert.equal(resolveMp4OutputPath(`${dir}/`, 'flow-01.mp4'), path.join(dir, 'flow-01.mp4'));
  assert.equal(resolveMp4OutputPath(path.join(dir, 'clip')), path.join(dir, 'clip.mp4'));
  assert.equal(resolveMp4OutputPath(path.join(dir, 'custom-name.mov')), path.join(dir, 'custom-name.mp4'));
});

test('buildAtomicTempPath keeps temp files in the same directory', () => {
  const finalPath = path.join('/tmp', 'flow-download-out', 'clip.mp4');
  const tmpPath = buildAtomicTempPath(finalPath, { pid: 111, now: 222, nonce: 'abc', suffix: '.tmp' });

  assert.equal(path.dirname(tmpPath), path.dirname(path.resolve(finalPath)));
  assert.match(path.basename(tmpPath), /^clip\.mp4\.abc\.tmp$/);
});

test('validateMp4Size enforces a minimum byte size', () => {
  assert.equal(validateMp4Size(DEFAULT_MIN_MP4_BYTES), DEFAULT_MIN_MP4_BYTES);
  assert.throws(() => validateMp4Size(DEFAULT_MIN_MP4_BYTES - 1), /mp4 too small/);
});

test('atomicWriteFile writes final output atomically', () => {
  const dir = makeTmpDir();
  const outFile = path.join(dir, 'nested', 'clip.mp4');
  const result = atomicWriteFile(outFile, Buffer.from('abc123'), { pid: 321, now: 654, nonce: 'zzz' });

  assert.equal(result, path.resolve(outFile));
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'abc123');
  assert.equal(fs.existsSync(path.join(dir, 'nested', 'clip.mp4.zzz.tmp')), false);
});

test('downloadMp4Buffer reads data urls without a browser session', async () => {
  const buf = await downloadMp4Buffer(null, 'data:video/mp4;base64,AAECAw==');
  assert.equal(buf.toString('hex'), '00010203');
});

test('downloadMp4Buffer reads blob urls through page.evaluate', async () => {
  const page = {
    evaluate: async (fn, src) => {
      assert.equal(typeof fn, 'function');
      assert.equal(src, 'blob:https://example.test/abc');
      return [9, 8, 7, 6];
    },
  };

  const buf = await downloadMp4Buffer(page, 'blob:https://example.test/abc');
  assert.equal(buf.toString('hex'), '09080706');
});

test('downloadMp4ToFile downloads authenticated http urls and writes atomically', async () => {
  const dir = makeTmpDir();
  const payload = Buffer.from('hello-mp4-data');
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      assert.equal(req.headers.cookie, 'session=abc123');
      res.statusCode = 302;
      res.setHeader('Location', '/video');
      res.end();
      return;
    }
    assert.equal(req.url, '/video');
    assert.equal(req.headers.cookie, 'session=abc123');
    assert.equal(req.headers.referer, 'https://flow.example.test/project/123');
    res.statusCode = 200;
    res.end(payload);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const page = {
    cookies: async () => [{ name: 'session', value: 'abc123' }],
    evaluate: async fn => {
      assert.equal(typeof fn, 'function');
      return 'MockBrowser/1.0';
    },
  };

  try {
    const result = await downloadMp4ToFile(
      page,
      `http://127.0.0.1:${port}/redirect`,
      path.join(dir, 'clip'),
      {
        minBytes: 5,
        pageUrl: 'https://flow.example.test/project/123',
        fallbackName: 'ignored-name.mov',
        atomic: { pid: 99, now: 100, nonce: 'atom' },
      }
    );

    assert.equal(result.bytes, payload.length);
    assert.equal(result.filePath, path.join(dir, 'clip.mp4'));
    assert.equal(fs.readFileSync(result.filePath).toString(), payload.toString());
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('downloadMp4ToFile rejects tiny outputs with a clear error', async () => {
  const page = { evaluate: async () => 'MockBrowser/1.0' };
  await assert.rejects(
    () => downloadMp4ToFile(page, 'data:video/mp4;base64,AA==', path.join(makeTmpDir(), 'clip.mp4'), { minBytes: 8 }),
    err => err.code === 'ERR_MP4_TOO_SMALL' && /mp4 too small/.test(err.message)
  );
});
