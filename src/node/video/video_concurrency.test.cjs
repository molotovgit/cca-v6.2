'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConcurrencyController,
  parseMaxInFlight,
} = require('./video_concurrency.cjs');

// --- parseMaxInFlight clamp table -------------------------------------------

test('parseMaxInFlight clamps to [floor, ceiling] with defaults', () => {
  assert.equal(parseMaxInFlight({}), 1); // unset
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '0' }), 1);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '1' }), 1);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '3' }), 3);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '4' }), 4);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '9' }), 4);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '-2' }), 1);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: 'abc' }), 1);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '' }), 1);
});

test('parseMaxInFlight honors a custom ceiling', () => {
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '9' }, { ceiling: 3 }), 3);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '2' }, { ceiling: 3 }), 2);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '3' }, { ceiling: 3 }), 3);
});

test('parseMaxInFlight honors a custom floor', () => {
  assert.equal(parseMaxInFlight({}, { floor: 2, ceiling: 4 }), 2);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '1' }, { floor: 2, ceiling: 4 }), 2);
  assert.equal(parseMaxInFlight({ CCA_VIDEO_MAX_IN_FLIGHT: '3' }, { floor: 2, ceiling: 4 }), 3);
});

// --- controller basics ------------------------------------------------------

test('currentLimit() starts at floor (1)', () => {
  const c = createConcurrencyController();
  assert.equal(c.currentLimit(), 1);
});

test('NO-INCREASE-AT-DEFAULT invariant: floor===ceiling===1 never moves', () => {
  const c = createConcurrencyController({ floor: 1, ceiling: 1 });
  for (let i = 0; i < 100; i += 1) {
    c.recordOutcome({ result: 'saved' });
  }
  assert.equal(c.currentLimit(), 1);
});

// --- additive ramp ----------------------------------------------------------

test('additive ramp: 2-saved windows step 1->2->3->4 then cap at 4', () => {
  const c = createConcurrencyController({
    floor: 1,
    ceiling: 4,
    windowSize: 2,
    increaseAfter: 2,
  });
  c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 1);
  c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 2);

  c.recordOutcome({ result: 'saved' });
  c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 3);

  c.recordOutcome({ result: 'saved' });
  c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 4);

  // Further saved outcomes stay at the ceiling.
  for (let i = 0; i < 10; i += 1) {
    c.recordOutcome({ result: 'saved' });
  }
  assert.equal(c.currentLimit(), 4);
});

// --- multiplicative step-down -----------------------------------------------

test('step-down: at limit 4 a failed_tile halves to 2, then to 1, stays at floor', () => {
  const c = createConcurrencyController({
    floor: 1,
    ceiling: 4,
    windowSize: 2,
    increaseAfter: 2,
  });
  // Ramp to 4.
  for (let i = 0; i < 6; i += 1) c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 4);

  // failed_tile at limit 4: rate (1/1) > 0 -> floor(4/2) = 2.
  c.recordOutcome({ result: 'failed_tile' });
  assert.equal(c.currentLimit(), 2);

  // failed_tile at limit 2: floor(2/2) = 1.
  c.recordOutcome({ result: 'failed_tile' });
  assert.equal(c.currentLimit(), 1);

  // failed_tile at floor stays at floor (limit > floor is false).
  c.recordOutcome({ result: 'failed_tile' });
  assert.equal(c.currentLimit(), 1);
});

test('step-down clears counters of levels above the new limit (clean re-probe)', () => {
  const c = createConcurrencyController({
    floor: 1,
    ceiling: 4,
    windowSize: 1,
    increaseAfter: 1,
  });
  // Ramp 1->2->3->4 (windowSize 1, increaseAfter 1).
  c.recordOutcome({ result: 'saved' }); // -> 2
  c.recordOutcome({ result: 'saved' }); // -> 3
  c.recordOutcome({ result: 'saved' }); // -> 4
  assert.equal(c.currentLimit(), 4);

  // failed_tile at 4 -> 2; levels 3 and 4 cleared.
  c.recordOutcome({ result: 'failed_tile' });
  assert.equal(c.currentLimit(), 2);
  const snap = c.snapshot();
  assert.equal(snap.levels['3'], undefined);
  assert.equal(snap.levels['4'], undefined);
  assert.ok(snap.levels['2']);
});

// --- window must be clean to increase ---------------------------------------

test('dirty window blocks increase: saved then failed_tile at limit 1 does not reach 2', () => {
  const c = createConcurrencyController({
    floor: 1,
    ceiling: 4,
    windowSize: 2,
    increaseAfter: 1,
  });
  c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 1);
  // failed_tile: rate is 1/2 > 0 but limit===floor so no step-down; window now
  // dirty so it never increases either.
  c.recordOutcome({ result: 'failed_tile' });
  assert.equal(c.currentLimit(), 1);
});

test('blocked dirties window and never triggers step-down', () => {
  const c = createConcurrencyController({
    floor: 1,
    ceiling: 4,
    windowSize: 1,
    increaseAfter: 1,
  });
  // Reach limit 2.
  c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 2);
  // blocked at limit 2: no step-down (only failed tiles count), window dirty.
  c.recordOutcome({ result: 'blocked' });
  assert.equal(c.currentLimit(), 2);
});

test('other dirties window and never triggers step-down', () => {
  const c = createConcurrencyController({
    floor: 1,
    ceiling: 4,
    windowSize: 1,
    increaseAfter: 1,
  });
  c.recordOutcome({ result: 'saved' });
  assert.equal(c.currentLimit(), 2);
  c.recordOutcome({ result: 'other' });
  assert.equal(c.currentLimit(), 2);
});

// --- snapshot ---------------------------------------------------------------

test('snapshot() reports per-level attempts/saved/failedTiles and rate', () => {
  const c = createConcurrencyController({
    floor: 1,
    ceiling: 4,
    windowSize: 10,
    increaseAfter: 10,
  });
  // Stay at level 1 (windowSize 10 won't complete), accumulate a mix.
  c.recordOutcome({ result: 'saved' });
  c.recordOutcome({ result: 'saved' });
  c.recordOutcome({ result: 'failed_tile' });
  c.recordOutcome({ result: 'blocked' });
  c.recordOutcome({ result: 'other' });

  const snap = c.snapshot();
  assert.equal(snap.limit, 1);
  const lvl = snap.levels['1'];
  assert.equal(lvl.attempts, 5);
  assert.equal(lvl.saved, 2);
  assert.equal(lvl.failedTiles, 1);
  assert.equal(lvl.blocked, 1);
  assert.equal(lvl.other, 1);
  assert.equal(lvl.rate, 1 / 5);
});

test('snapshot() rate is 0 when no attempts recorded', () => {
  const c = createConcurrencyController();
  const snap = c.snapshot();
  assert.equal(snap.limit, 1);
  assert.equal(snap.levels['1'].attempts, 0);
  assert.equal(snap.levels['1'].rate, 0);
});
