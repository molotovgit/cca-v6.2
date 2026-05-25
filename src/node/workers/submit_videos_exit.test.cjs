'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { determineExitCode, EXIT } = require('./submit_videos.cjs');

test('submit_videos exit codes are stable', () => {
  assert.equal(determineExitCode({ errors: 0, missingSourceErrors: 0, preflightError: false }), EXIT.ok);
  assert.equal(determineExitCode({ errors: 2, missingSourceErrors: 2, preflightError: false }), EXIT.missingSource);
  assert.equal(determineExitCode({ errors: 3, missingSourceErrors: 1, preflightError: false }), EXIT.generic);
  assert.equal(determineExitCode({ errors: 1, missingSourceErrors: 0, preflightError: true }), EXIT.preflight);
});
