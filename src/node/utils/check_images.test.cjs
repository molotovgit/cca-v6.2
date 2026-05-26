'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deriveOutputDir,
  checkArtifacts,
  MIN_VALID_BYTES,
} = require('./check_images.cjs');

// Read-only consistency check against the parallel prompts→videos mapping so
// the prompts→images layout never drifts from prompts→videos.
const { deriveVideosDir } = require('../video/video_stage.cjs');

// ── deriveOutputDir ─────────────────────────────────────────────────────────
// NOTE: deriveOutputDir resolves to an absolute path (path.resolve) and joins
// on the OS separator, so assertions compare against absolute, sep-normalized
// expectations rather than the literal relative input.

test('deriveOutputDir maps a nested prompts path to its images dir and strips .json', () => {
  const out = deriveOutputDir('data/prompts/g7-uz/sub/ch01-intro.json');
  assert.equal(out, path.resolve('data/images/g7-uz/sub/ch01-intro'));
});

test('deriveOutputDir strips the .json extension only from the basename', () => {
  const out = deriveOutputDir('data/prompts/g7-uz/ch01.json');
  assert.equal(path.basename(out), 'ch01');
  assert.ok(!out.endsWith('.json'), 'output dir must not retain a .json suffix');
});

test('deriveOutputDir swaps the prompts segment for images, leaving siblings intact', () => {
  const out = deriveOutputDir('data/prompts/g7-uz/sub/ch01-intro.json');
  const parts = out.split(path.sep);
  assert.ok(parts.includes('images'), 'images segment must be present');
  assert.ok(!parts.includes('prompts'), 'prompts segment must be replaced, not kept');
  // Sibling segments after the swap point are preserved verbatim.
  assert.ok(parts.includes('g7-uz'));
  assert.ok(parts.includes('sub'));
});

test('deriveOutputDir only replaces the FIRST prompts segment (lookalikes survive)', () => {
  // A nested dir literally named "prompts-archive" must NOT be swapped; only the
  // exact "prompts" path segment is the mapping anchor.
  const out = deriveOutputDir('data/prompts/prompts-archive/ch02.json');
  assert.equal(out, path.resolve('data/images/prompts-archive/ch02'));
});

test('deriveOutputDir handles a case-insensitive .JSON extension', () => {
  const out = deriveOutputDir('data/prompts/g7-uz/ch01.JSON');
  assert.equal(path.basename(out), 'ch01');
});

test('deriveOutputDir throws when the path has no prompts segment', () => {
  assert.throws(() => deriveOutputDir('data/refined/g7-uz/ch01.json'), /prompts/);
});

// ── consistency with the parallel prompts→videos mapping ────────────────────
// deriveOutputDir (prompts→images) must mirror the STRUCTURE of deriveVideosDir
// (prompts→videos): same anchor segment, same .json strip, same sibling layout.
// They differ only in the swapped segment (images vs videos) and in path form
// (deriveOutputDir resolves to absolute + OS sep; deriveVideosDir is a relative
// forward-slash string op), so we compare on normalized basenames + segments.
test('deriveOutputDir mirrors deriveVideosDir structure (images vs videos)', () => {
  const input = 'data/prompts/g7-uz/sub/ch01-intro.json';

  const imagesDir = deriveOutputDir(input);
  const videosDir = deriveVideosDir(input);

  // Same basename (both strip .json identically).
  assert.equal(path.basename(imagesDir), path.basename(videosDir));
  assert.equal(path.basename(imagesDir), 'ch01-intro');

  // Same trailing layout after the swapped media segment.
  const imgTail = imagesDir.split(path.sep).slice(-3);   // [g7-uz, sub, ch01-intro]
  const vidTail = videosDir.split('/').slice(-3);
  assert.deepEqual(imgTail, vidTail);

  // The anchor segment is the only structural difference.
  assert.ok(imagesDir.split(path.sep).includes('images'));
  assert.ok(videosDir.split('/').includes('videos'));
});

test('deriveOutputDir and deriveVideosDir both reject a missing prompts segment', () => {
  const bad = 'data/refined/g7-uz/ch01.json';
  assert.throws(() => deriveOutputDir(bad), /prompts/);
  assert.throws(() => deriveVideosDir(bad), /prompts/);
});

// ── checkArtifacts (temp dir + fixture PNGs) ────────────────────────────────
// Pattern mirrors video_stage.test.cjs: a fresh temp dir, byte-padded fixture
// files, and a finally{} cleanup with fs.rmSync(recursive, force).
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'check-images-'));
}

function writePng(dir, name, bytes) {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0));
}

// Build the expected file name the same way the checker does.
function expectedName(idx, slug) {
  return `${String(idx).padStart(3, '0')}-${slug}.png`;
}

test('checkArtifacts classifies present / missing / small correctly', () => {
  const dir = makeTempDir();
  try {
    const prompts = [
      { idx: 1, slug: 'alpha' },   // present (>= min)
      { idx: 2, slug: 'bravo' },   // present (exactly min)
      { idx: 3, slug: 'charlie' }, // undersized
      { idx: 4, slug: 'delta' },   // missing (no file written)
    ];

    writePng(dir, expectedName(1, 'alpha'), MIN_VALID_BYTES + 100);
    writePng(dir, expectedName(2, 'bravo'), MIN_VALID_BYTES);       // boundary → present
    writePng(dir, expectedName(3, 'charlie'), MIN_VALID_BYTES - 1); // boundary → small
    // delta intentionally not written

    const { present, missing, small, extras } = checkArtifacts(prompts, dir);

    assert.equal(present.length, 2);
    assert.deepEqual(present.map(p => p.idx).sort(), [1, 2]);

    assert.equal(missing.length, 1);
    assert.equal(missing[0].idx, 4);
    assert.equal(missing[0].slug, 'delta');
    assert.equal(missing[0].expected, expectedName(4, 'delta'));

    assert.equal(small.length, 1);
    assert.equal(small[0].idx, 3);
    assert.equal(small[0].size, MIN_VALID_BYTES - 1);

    assert.equal(extras.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkArtifacts reports unexpected .png files as extras (case-insensitive ext)', () => {
  const dir = makeTempDir();
  try {
    const prompts = [{ idx: 1, slug: 'alpha' }];
    writePng(dir, expectedName(1, 'alpha'), MIN_VALID_BYTES + 1);
    writePng(dir, 'stray-file.png', MIN_VALID_BYTES + 1);   // not expected → extra
    writePng(dir, 'UPPER.PNG', MIN_VALID_BYTES + 1);        // .PNG still counts as png
    writePng(dir, 'notes.txt', MIN_VALID_BYTES + 1);        // non-png → ignored

    const { present, extras } = checkArtifacts(prompts, dir);

    assert.equal(present.length, 1);
    assert.deepEqual(extras.sort(), ['UPPER.PNG', 'stray-file.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkArtifacts honors a custom minBytes threshold', () => {
  const dir = makeTempDir();
  try {
    const prompts = [
      { idx: 1, slug: 'alpha' },
      { idx: 2, slug: 'bravo' },
    ];
    writePng(dir, expectedName(1, 'alpha'), 100);
    writePng(dir, expectedName(2, 'bravo'), 200);

    const { present, small } = checkArtifacts(prompts, dir, 150);

    assert.deepEqual(present.map(p => p.idx), [2]);
    assert.deepEqual(small.map(s => s.idx), [1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkArtifacts treats a missing output dir as all-missing, no extras', () => {
  const dir = path.join(os.tmpdir(), `check-images-absent-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(dir), false);

  const prompts = [
    { idx: 1, slug: 'alpha' },
    { idx: 2, slug: 'bravo' },
  ];

  const { present, missing, small, extras } = checkArtifacts(prompts, dir);

  assert.equal(present.length, 0);
  assert.equal(small.length, 0);
  assert.equal(extras.length, 0);
  assert.deepEqual(missing.map(m => m.idx), [1, 2]);
});

test('checkArtifacts pads idx to 3 digits in the expected file name', () => {
  const dir = makeTempDir();
  try {
    const prompts = [{ idx: 42, slug: 'answer' }];
    // Written with the padded name → must be detected as present.
    writePng(dir, '042-answer.png', MIN_VALID_BYTES + 1);
    const { present, missing } = checkArtifacts(prompts, dir);
    assert.equal(missing.length, 0);
    assert.equal(present[0].expected, '042-answer.png');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkArtifacts on an empty prompt list yields all-empty buckets', () => {
  const dir = makeTempDir();
  try {
    writePng(dir, 'orphan.png', MIN_VALID_BYTES + 1);  // becomes an extra
    const { present, missing, small, extras } = checkArtifacts([], dir);
    assert.equal(present.length, 0);
    assert.equal(missing.length, 0);
    assert.equal(small.length, 0);
    assert.deepEqual(extras, ['orphan.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
