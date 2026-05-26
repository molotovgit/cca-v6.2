// Canonical selectors / classifiers for the Google Flow video UI
// (labs.google/fx/tools/flow). PURE module: no I/O, no puppeteer.
//
// Live tokens below come from REAL observed Flow strings. Anything not yet
// confirmed against a live DOM is left as `null` with a TODO(live) marker —
// NEVER invent a selector we have not seen.
//
// Observed (KNOWN LIVE STRINGS):
//   mode dropdown button:  "🍌 Nano Banana 2crop_16_9x2"  (default = image)
//   output panel:          "image Image", "play_circle Video", "crop_free Frames"
//   aspect:                "crop_16_9 16:9"
//   count:                 "1x x2 x3 x4"
//   duration:              "4s 6s 8s 10s"
//   model:                 "Omni Flash"
//   credits readout:       "Generating will use 15 credits" (video) / "... 0 credits" (image)
//   configured create row: "Agent Video · 4s crop_16_9 1x arrow_forward Create"
//   frames upload zones:   "Start swap_horiz Swap first and last frames End" (leftmost = Start)
//   left-nav tabs:         "dashboardAll Media", "imageView images Images",
//                          "videocam View videos Videos"
//   failed card:           "warning Failed undo Reuse Prompt delete_forever Delete image 99%"
//   completed video tile:  visible <video src="https://labs.google/fx/api/trpc/
//                          media.getMediaUrlRedirect?name=<UUID>"> (no download
//                          button — fetch the authenticated src, follow 302s)
'use strict';

const MODE_DROPDOWN_RE = /nano banana|crop_16_9|omni flash|video\s*[·.]/i;

const OUTPUT_TYPE_TOKENS = {
  image: /\bimage\b/i,
  video: /play_circle\s*video|\bvideo\b/i,
  frames: /crop_free\s*frames|\bframes\b/i,
};

const ASPECT_TOKENS = {
  '16:9': /crop_16_9|16:9/i,
  '4:3': /crop_landscape|4:3/i,
  '1:1': /crop_square|1:1/i,
  '3:4': /crop_portrait|3:4/i,
  '9:16': /crop_9_16|9:16/i,
};

const DURATION_TOKENS = {
  '4s': /^4s$/i,
  '6s': /^6s$/i,
  '8s': /^8s$/i,
  '10s': /^10s$/i,
};

const COUNT_TOKENS = {
  '1x': /^1x$/i,
  'x2': /^x?2x?$/i,
  'x3': /^x?3x?$/i,
  'x4': /^x?4x?$/i,
};

const CREDITS_RE = /generating will use (\d+) credits/i;

const CREATE_ROW_VIDEO_RE = /video\s*[·.]\s*4s/i;

const START_SLOT = { textRe: /start|frame|drop|media|upload/i, minW: 100, minH: 100, pick: 'leftmost' };

const MEDIA_TABS = {
  allMedia: /all media/i,
  images: /view images images|^images$/i,
  videos: /view videos videos|videocam/i,
};

// NON-TERMINAL — advisory only. A failed card means a single tile broke, not
// that the whole batch/session is dead. Callers should surface, not abort.
const FAILED_CARD_RE = /\bfailed\b.{0,120}\b(reuse prompt|delete image|99%)\b/i;

// Fixed: the old trailing `\b` after `%` is unsatisfiable (`%` is non-word and
// the following char — space/end — is also non-word), so it NEVER matched real
// "7%" / "99%" strings. Match an optional gap before the percent sign instead.
const PROGRESS_RE = /(\d{1,3})\s*%/;
const ACTIVITY_RE = /\b(generating|rendering|creating)\b/i;

// LIVE (flow_probe): a completed Flow video tile in the Videos/All Media view
// exposes a visible <video> whose src is an authenticated redirect endpoint,
// e.g. https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<UUID>
// (two real examples captured). A tile is "complete" when such a <video> is
// visible. There is NO per-tile download button on the completed tile.
const COMPLETED_TILE_SELECTOR = Object.freeze({
  videoSrcRe: /media\.getMediaUrlRedirect\?name=/i,
});

// LIVE (flow_probe): downloads are NOT via a button — fetch the completed
// <video> src directly over authenticated HTTP. The getMediaUrlRedirect
// endpoint 302s to the real media, so the transport must follow redirects.
const DOWNLOAD_AFFORDANCE = Object.freeze({
  kind: 'video-src',
  transport: 'http',
  followRedirects: true,
});

/**
 * Extracts the credit count from a "Generating will use N credits" readout.
 * @param {string} text - visible text that may contain the credits readout
 * @returns {number|null} the integer credit count, or null if not present
 */
function parseCredits(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(CREDITS_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when the create row is configured for video output AND credits > 0.
 * Image mode shows "0 credits", so a positive credit count is the tell that
 * video generation is actually armed.
 * @param {string} text - visible text spanning the create row + credits readout
 * @returns {boolean}
 */
function isVideoModeConfirmed(text) {
  if (typeof text !== 'string') return false;
  if (!CREATE_ROW_VIDEO_RE.test(text)) return false;
  const credits = parseCredits(text);
  return credits != null && credits > 0;
}

/**
 * True when text matches a Flow "failed" tile card. NON-TERMINAL / advisory.
 * @param {string} text - visible text of a media tile / card
 * @returns {boolean}
 */
function isFailedCard(text) {
  if (typeof text !== 'string') return false;
  return FAILED_CARD_RE.test(text);
}

module.exports = Object.freeze({
  MODE_DROPDOWN_RE,
  OUTPUT_TYPE_TOKENS,
  ASPECT_TOKENS,
  DURATION_TOKENS,
  COUNT_TOKENS,
  CREDITS_RE,
  CREATE_ROW_VIDEO_RE,
  START_SLOT,
  MEDIA_TABS,
  FAILED_CARD_RE,
  PROGRESS_RE,
  ACTIVITY_RE,
  COMPLETED_TILE_SELECTOR,
  DOWNLOAD_AFFORDANCE,
  parseCredits,
  isVideoModeConfirmed,
  isFailedCard,
});
