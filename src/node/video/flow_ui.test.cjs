'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODE_DROPDOWN_RE,
  OUTPUT_TYPE_TOKENS,
  ASPECT_TOKENS,
  DURATION_TOKENS,
  COUNT_TOKENS,
  CREATE_ROW_VIDEO_RE,
  MEDIA_TABS,
  PROGRESS_RE,
  ACTIVITY_RE,
  COMPLETED_TILE_SELECTOR,
  DOWNLOAD_AFFORDANCE,
  parseCredits,
  isVideoModeConfirmed,
  isFailedCard,
} = require('./flow_ui.cjs');

test('parseCredits reads 0 credits (image mode)', () => {
  assert.equal(parseCredits('Generating will use 0 credits'), 0);
});

test('parseCredits reads 15 credits (video mode)', () => {
  assert.equal(parseCredits('Generating will use 15 credits'), 15);
});

test('parseCredits returns null when no readout present', () => {
  assert.equal(parseCredits('Agent Video · 4s crop_16_9 1x arrow_forward Create'), null);
  assert.equal(parseCredits(null), null);
});

test('isVideoModeConfirmed true for configured video row with credits', () => {
  assert.equal(
    isVideoModeConfirmed('Agent Video · 4s crop_16_9 1x arrow_forward Create Generating will use 15 credits'),
    true
  );
});

test('isVideoModeConfirmed false for image mode text with 0 credits', () => {
  assert.equal(
    isVideoModeConfirmed('🍌 Nano Banana 2crop_16_9x2 Generating will use 0 credits'),
    false
  );
});

test('isVideoModeConfirmed false when create row matches but no credits readout', () => {
  assert.equal(isVideoModeConfirmed('Agent Video · 4s crop_16_9 1x arrow_forward Create'), false);
});

test('isFailedCard true for Flow failed tile card', () => {
  assert.equal(
    isFailedCard('warning Failed undo Reuse Prompt delete_forever Delete image 99%'),
    true
  );
});

test('isFailedCard false for in-progress / clean text', () => {
  assert.equal(isFailedCard('play_circle Video Generating 42%'), false);
});

test('MODE_DROPDOWN_RE matches observed default mode button label', () => {
  assert.match('🍌 Nano Banana 2crop_16_9x2', MODE_DROPDOWN_RE);
  assert.match('Omni Flash', MODE_DROPDOWN_RE);
  assert.match('Agent Video · 4s', MODE_DROPDOWN_RE);
});

test('OUTPUT_TYPE_TOKENS classify the output panel labels', () => {
  assert.match('image Image', OUTPUT_TYPE_TOKENS.image);
  assert.match('play_circle Video', OUTPUT_TYPE_TOKENS.video);
  assert.match('crop_free Frames', OUTPUT_TYPE_TOKENS.frames);
});

test('ASPECT_TOKENS match the observed aspect chip', () => {
  assert.match('crop_16_9 16:9', ASPECT_TOKENS['16:9']);
  assert.doesNotMatch('crop_16_9 16:9', ASPECT_TOKENS['9:16']);
});

test('DURATION_TOKENS match exact duration chips', () => {
  assert.match('4s', DURATION_TOKENS['4s']);
  assert.match('10s', DURATION_TOKENS['10s']);
  assert.doesNotMatch('4s 6s 8s', DURATION_TOKENS['4s']);
});

test('COUNT_TOKENS match the observed count chips', () => {
  assert.match('1x', COUNT_TOKENS['1x']);
  assert.match('x2', COUNT_TOKENS.x2);
  assert.match('x3', COUNT_TOKENS.x3);
  assert.match('x4', COUNT_TOKENS.x4);
});

test('CREATE_ROW_VIDEO_RE matches the configured create row', () => {
  assert.match('Agent Video · 4s crop_16_9 1x arrow_forward Create', CREATE_ROW_VIDEO_RE);
});

test('MEDIA_TABS match the observed left-nav tab labels', () => {
  assert.match('dashboardAll Media', MEDIA_TABS.allMedia);
  assert.match('imageView images Images', MEDIA_TABS.images);
  assert.match('videocam View videos Videos', MEDIA_TABS.videos);
});

test('ACTIVITY_RE detects in-progress activity verbs', () => {
  assert.match('Generating your video', ACTIVITY_RE);
  assert.match('Rendering frame', ACTIVITY_RE);
  assert.match('Creating clip', ACTIVITY_RE);
  assert.doesNotMatch('Download video', ACTIVITY_RE);
});

// PROGRESS_RE is the frozen selectors contract. Its trailing `\b` after `%`
// means it does NOT match real "99%" strings (`%` followed by space/end is not
// a word boundary). Documented here so the limitation is captured; flow_probe
// uses its own local percent matcher for the in-progress heuristic. See note
// to reviewer — the contract regex likely needs correcting upstream.
test('PROGRESS_RE is the frozen contract (does not match bare percentages)', () => {
  assert.doesNotMatch('play_circle Video 99%', PROGRESS_RE);
  assert.doesNotMatch('play_circle 0%', PROGRESS_RE);
});

test('unknown live selectors remain null TODO(live) placeholders', () => {
  assert.equal(COMPLETED_TILE_SELECTOR, null);
  assert.equal(DOWNLOAD_AFFORDANCE, null);
});
