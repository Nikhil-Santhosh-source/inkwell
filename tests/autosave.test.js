import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaver } from '../app/src/autosave.js';

test('rapid edits are coalesced into one save of the latest value', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [];
  const saver = createAutosaver(async (v) => { saved.push(v); }, { delay: 400 });
  saver.schedule(1);
  saver.schedule(2);
  saver.schedule(3);
  t.mock.timers.tick(399);
  assert.deepEqual(saved, []);
  t.mock.timers.tick(1);
  await saver.flush();
  assert.deepEqual(saved, [3]);
});

test('flush saves immediately without waiting for the delay', async () => {
  const saved = [];
  const saver = createAutosaver(async (v) => { saved.push(v); }, { delay: 60_000 });
  saver.schedule('a');
  await saver.flush();
  assert.deepEqual(saved, ['a']);
  assert.equal(saver.hasPending, false);
});

test('saves run in order, one at a time', async () => {
  const log = [];
  let release;
  const saver = createAutosaver((v) => {
    log.push(`start ${v}`);
    return new Promise((resolve) => {
      release = () => { log.push(`end ${v}`); resolve(); };
    });
  });
  saver.schedule(1);
  const first = saver.flush();
  saver.schedule(2);
  const second = saver.flush();
  await Promise.resolve();
  release();
  await first;
  await new Promise((r) => setImmediate(r));
  release();
  await second;
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('a failed save is kept and retried on the next flush', async () => {
  const saved = [];
  const statuses = [];
  const errors = [];
  let fail = true;
  const saver = createAutosaver(async (v) => {
    if (fail) throw new Error('disk full');
    saved.push(v);
  }, { onStatus: (s) => statuses.push(s), onError: (e) => errors.push(e.message) });

  saver.schedule('page');
  await saver.flush();
  assert.equal(saver.hasPending, true);
  assert.deepEqual(errors, ['disk full']);
  assert.equal(statuses.at(-1), 'error');

  fail = false;
  await saver.flush();
  assert.deepEqual(saved, ['page']);
  assert.equal(statuses.at(-1), 'saved');
});

test('a newer edit made during a failing save wins over the failed value', async () => {
  const saved = [];
  let fail = true;
  let saver;
  saver = createAutosaver(async (v) => {
    if (fail) {
      saver.schedule('newer');
      throw new Error('fail');
    }
    saved.push(v);
  }, { delay: 60_000 });
  saver.schedule('older');
  await saver.flush();
  fail = false;
  await saver.flush();
  assert.deepEqual(saved, ['newer']);
});
