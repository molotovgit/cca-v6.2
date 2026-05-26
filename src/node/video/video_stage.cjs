'use strict';

// =============================================================================
//  VIDEO STAGE — pure, testable helpers for the opt-in pipeline video stage
// =============================================================================
//  This module holds the TESTABLE logic for the OPT-IN video stage that
//  run_pipeline.cjs runs (gated by CCA_ENABLE_VIDEO=1) AFTER the IMAGES stage.
//
//  It is intentionally browser-free and side-effect-free apart from the small
//  fs read in countSavedVideos. run_pipeline.cjs stays a thin caller that wires
//  these helpers to its spawn + Promise plumbing.
//
//  Mirrors submit_flow_videos.cjs::deriveFlowDirs for the prompts→videos path
//  mapping, but is REIMPLEMENTED locally as a pure string op so the pipeline
//  never load-couples to the browser worker.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Map a prompts path to its videos dir by replacing the FIRST `prompts` path
// segment with `videos` and stripping a trailing `.json` from the basename.
//   data/prompts/g7-uz/sub/ch01.json  →  data/videos/g7-uz/sub/ch01
// Pure string op: preserves the input's separator style and relative/absolute
// form. Splits on BOTH separators so forward-slash inputs work on Windows too.
function deriveVideosDir(promptsPath) {
  if (!promptsPath) throw new Error('deriveVideosDir: promptsPath required');
  const parts = String(promptsPath).split(/[\\/]/);
  const promptsIdx = parts.indexOf('prompts');
  if (promptsIdx < 0) throw new Error(`deriveVideosDir: path missing 'prompts' segment: ${promptsPath}`);
  parts[promptsIdx] = 'videos';
  const last = parts.length - 1;
  parts[last] = parts[last].replace(/\.json$/i, '');
  return parts.join('/');
}

// Count `.mp4` files >= minBytes in videosDir. Returns 0 if the dir is missing.
function countSavedVideos(videosDir, minBytes = 50 * 1024) {
  if (!videosDir || !fs.existsSync(videosDir)) return 0;
  let count = 0;
  for (const f of fs.readdirSync(videosDir)) {
    if (!f.toLowerCase().endsWith('.mp4')) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(videosDir, f)).size;
    } catch (_) {
      continue;
    }
    if (size >= minBytes) count += 1;
  }
  return count;
}

// Status snapshot: how many saved videos vs. the expected total, and whether
// the stage is already done (enough saved to skip the run entirely).
function videoStageStatus({ videosDir, total, minBytes } = {}) {
  const have = countSavedVideos(videosDir, minBytes);
  const expected = Number.isFinite(total) ? total : 0;
  return { have, total: expected, done: have >= expected };
}

// Build the spawn cmd/args for the video orchestrator, using the SAME
// Windows-safe `cmd /c node ...` wrapper the IMAGES stage uses so the
// depth-4 Node-to-Node spawn assertion never triggers on Windows.
function buildVideoSpawnArgs(promptsJson, platform = process.platform) {
  if (platform === 'win32') {
    return {
      cmd: 'cmd',
      args: ['/c', 'node', 'src\\node\\orchestrators\\run_videos_autonomous.cjs', promptsJson],
    };
  }
  return {
    cmd: 'node',
    args: ['src/node/orchestrators/run_videos_autonomous.cjs', promptsJson],
  };
}

module.exports = {
  deriveVideosDir,
  countSavedVideos,
  videoStageStatus,
  buildVideoSpawnArgs,
};
