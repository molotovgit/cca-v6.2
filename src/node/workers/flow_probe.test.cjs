'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// NOTE: tests must NOT launch a browser — only the pure extractMediaReport is
// exercised here. puppeteer is required lazily inside runProbe, never at import.
const { extractMediaReport } = require('./flow_probe.cjs');

// Fixture snapshot: one completed tile (blob: video src + a download button)
// and one in-progress tile ("play_circle 0%", no usable media yet).
const FIXTURE = [
  {
    outerHTMLExcerpt: '<div role="listitem"><video src="blob:https://labs.google/abc-123"></video></div>',
    ariaLabels: ['Generated video'],
    videoSrcs: ['blob:https://labs.google/abc-123'],
    buttonLabels: ['Download', 'more_vert More options'],
  },
  {
    outerHTMLExcerpt: '<div role="listitem">play_circle 0%</div>',
    ariaLabels: ['Generating video'],
    videoSrcs: [],
    buttonLabels: [],
  },
];

test('extractMediaReport surfaces the completed tile video URL', () => {
  const report = extractMediaReport(FIXTURE);
  assert.deepEqual(report.videoUrls, ['blob:https://labs.google/abc-123']);
});

test('extractMediaReport produces a download candidate for the completed tile', () => {
  const report = extractMediaReport(FIXTURE);
  assert.equal(report.downloadCandidates.length, 1);
  const candidate = report.downloadCandidates[0];
  assert.equal(candidate.index, 0);
  assert.equal(candidate.likelyCompleted, true);
  assert.deepEqual(candidate.videoSrcs, ['blob:https://labs.google/abc-123']);
  assert.deepEqual(candidate.downloadButtons, ['Download']);
});

test('extractMediaReport flags the in-progress tile', () => {
  const report = extractMediaReport(FIXTURE);
  const inProgress = report.tiles.find(t => t.index === 1);
  assert.equal(inProgress.label, 'in_progress');
  assert.equal(inProgress.isActive, true);
  assert.equal(inProgress.progress, 0);
  assert.equal(inProgress.likelyCompleted, false);
});

test('extractMediaReport ranks the completed tile above the in-progress one', () => {
  const report = extractMediaReport(FIXTURE);
  assert.equal(report.tiles[0].index, 0);
  assert.equal(report.tiles[0].label, 'likely_completed');
});

test('extractMediaReport notes when no video URLs surface (still-unknown live DOM)', () => {
  const report = extractMediaReport([
    { outerHTMLExcerpt: 'play_circle 50%', ariaLabels: [], videoSrcs: [], buttonLabels: [] },
  ]);
  assert.deepEqual(report.videoUrls, []);
  assert.ok(report.notes.some(n => /no usable video URLs/i.test(n)));
});

test('extractMediaReport flags failed cards as non-terminal advisory', () => {
  const report = extractMediaReport([
    {
      outerHTMLExcerpt: 'warning Failed undo Reuse Prompt delete_forever Delete image 99%',
      ariaLabels: ['warning Failed undo Reuse Prompt delete_forever Delete image 99%'],
      videoSrcs: [],
      buttonLabels: ['Reuse Prompt', 'Delete image'],
    },
  ]);
  const tile = report.tiles[0];
  assert.equal(tile.failed, true);
  assert.equal(tile.label, 'failed');
  assert.ok(report.notes.some(n => /failed cards present/i.test(n)));
});

test('extractMediaReport is defensive against malformed input', () => {
  const report = extractMediaReport(null);
  assert.deepEqual(report.tiles, []);
  assert.deepEqual(report.videoUrls, []);
  assert.ok(report.notes.some(n => /not an array/i.test(n)));
});
