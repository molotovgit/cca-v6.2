// Structured diagnostic events for unattended runs (ROADMAP Phase 3, Lane B).
//
// PURELY ADDITIVE observability: normalizes account-rotation / login / blocker
// events into a stable JSONL shape so an unattended run can be diagnosed after
// the fact. Nothing here changes control flow — callers wrap these in try/catch
// (and appendEvent itself never throws), so a logging failure can never break
// the rotation or save pipeline.
//
// Pure + injectable: I/O deps (fs) are passed in so the module is testable
// without touching the real filesystem.

'use strict';
const realFs = require('fs');
const path   = require('path');

// Known event types. Kept permissive (any string passes) but documented so the
// emitted JSONL has a predictable vocabulary:
//   'rotate'            — after `accounts rotate` returns
//   'login'             — after `auto_login` returns
//   'rotation_complete' — after a rotation fully succeeds + state reset
//   'blocker'           — when save_images records a 1095/quota blocker
const EVENT_FIELDS = [
  'provider',
  'accountLabel',
  'accountIndex',
  'accountEmail',
  'exitCode',
  'reason',
  'stderrExcerpt',
  'resumedImageIndex',
  'idx',
  'slug',
  'blockerType',
];

const STDERR_EXCERPT_MAX = 500;

// Build a normalized event object. Always stamps an ISO `timestamp`. Only
// carries the recognized optional fields that were actually supplied (so the
// JSONL stays compact and predictable), but trims stderr to a sane excerpt.
function formatEvent(fields = {}) {
  const { type } = fields;
  const event = {
    type: typeof type === 'string' ? type : 'unknown',
    timestamp: new Date().toISOString(),
  };
  for (const key of EVENT_FIELDS) {
    if (fields[key] === undefined || fields[key] === null) continue;
    if (key === 'stderrExcerpt' && typeof fields[key] === 'string') {
      event[key] = fields[key].slice(0, STDERR_EXCERPT_MAX);
    } else {
      event[key] = fields[key];
    }
  }
  return event;
}

// Best-effort JSONL append. mkdir -p the parent dir, then append one line.
// NEVER throws: any failure (permission, ENOSPC, bad input) is swallowed and
// reported via a `false` return so a diagnostics failure can never break the
// caller's control flow. Returns true on success.
//
// deps lets tests inject a fake fs ({ mkdirSync, appendFileSync }).
function appendEvent(filePath, event, deps = {}) {
  const fs = deps.fs || realFs;
  try {
    if (!filePath) return false;
    const line = JSON.stringify(event) + '\n';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line);
    return true;
  } catch (_) {
    return false;
  }
}

// Snapshot of rotation state, written to rotation_state.json after a successful
// rotation so an operator can see "where are we now". Stamps an ISO timestamp.
function rotationStateSnapshot(fields = {}) {
  const snapshot = {
    timestamp: new Date().toISOString(),
    provider: fields.provider !== undefined ? fields.provider : null,
    accountLabel: fields.accountLabel !== undefined ? fields.accountLabel : null,
    accountIndex: fields.accountIndex !== undefined ? fields.accountIndex : null,
    accountEmail: fields.accountEmail !== undefined ? fields.accountEmail : null,
    rotationCount: fields.rotationCount !== undefined ? fields.rotationCount : null,
    resumedImageIndex: fields.resumedImageIndex !== undefined ? fields.resumedImageIndex : null,
    total: fields.total !== undefined ? fields.total : null,
    reason: fields.reason !== undefined ? fields.reason : null,
  };
  return snapshot;
}

module.exports = { formatEvent, appendEvent, rotationStateSnapshot };
