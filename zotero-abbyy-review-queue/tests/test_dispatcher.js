const assert = require('node:assert/strict');
const test = require('node:test');
const { AutoDispatcher } = require('../addon/auto-dispatcher.js');

function harness({ cfg = {}, saved = { version: 1, tasks: {} }, items = {}, stats = {}, execute, delayMs = 100 } = {}) {
  let clock = 0;
  let sequence = 0;
  const timers = new Map();
  const state = { saved, configs: [], logs: [], notices: [], executes: [], busy: false };
  const config = { autoEnabled: true, autoPublish: true, autoEnabledAt: new Date(0).toISOString(), ...cfg };
  const deps = {
    delayMs,
    maxWaits: 3,
    now: () => clock,
    identity: () => 'profile:personal',
    config: async () => config,
    busy: () => state.busy,
    setBusy: value => { state.busy = value; },
    item: async id => typeof items[id] === 'function' ? items[id]() : items[id] || null,
    stat: async path => typeof stats[path] === 'function' ? stats[path]() : stats[path] || null,
    load: async () => state.saved,
    save: async value => { state.saved = value; },
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimer: id => timers.delete(id),
    execute: async (cfgArg, req) => {
      state.executes.push({ cfg: cfgArg, req });
      return execute ? execute(cfgArg, req) : { state: 'published', jobId: 'abc123' };
    },
    notify: (title, text) => state.notices.push({ title, text }),
    log: async entry => state.logs.push(entry)
  };
  const dispatcher = new AutoDispatcher(deps);
  async function flush() {
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  }
  async function advance(ms) {
    clock += ms;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock);
      if (!due.length) break;
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      await flush();
    }
    await flush();
  }
  return { dispatcher, state, config, timers, advance, flush, now: () => clock };
}

function pdfItem(id = 1, extra = {}) {
  return { id, key: `ATT${id}`, parentKey: 'PARENTAA', personal: true,
    attachment: true, contentType: 'application/pdf', filePath: `/tmp/${id}.pdf`,
    title: 'source', dateAdded: 0, ...extra };
}

async function runToExecute(h, id = 1) {
  await h.dispatcher.observe('add', [id]);
  await h.advance(100);
  await h.advance(100);
}

test('new PDF executes once after file becomes stable', async () => {
  const h = harness({ items: { 1: pdfItem() }, stats: { '/tmp/1.pdf': { size: 10, mtime: 1 } } });
  await h.dispatcher.start();
  await runToExecute(h);
  assert.equal(h.state.executes.length, 1);
  assert.equal(h.state.executes[0].req.action, 'auto');
  assert.equal(h.state.executes[0].req.automatic, true);
  assert.equal(h.state.executes[0].req.approved, true);
});

test('generated ABBYY title is excluded', async () => {
  const h = harness({ items: { 1: pdfItem(1, { title: 'ABBYY OCR [abc123]' }) } });
  await h.dispatcher.start();
  await h.dispatcher.observe('add', [1]);
  assert.deepEqual(h.state.saved.tasks, {});
});

test('historical modify and add before cutoff are excluded', async () => {
  const h = harness({
    items: { 1: pdfItem(1, { dateAdded: -5000 }), 2: pdfItem(2, { dateAdded: -5000 }) }
  });
  await h.dispatcher.start();
  await h.dispatcher.observe('modify', [1]);
  await h.dispatcher.observe('add', [2]);
  assert.deepEqual(h.state.saved.tasks, {});
});

test('missing file or parent waits, then executes after metadata arrives', async () => {
  let item = pdfItem(1, { parentKey: null, filePath: null });
  const h = harness({ items: { 1: () => item }, stats: { '/tmp/1.pdf': { size: 10, mtime: 1 } } });
  await h.dispatcher.start();
  await h.dispatcher.observe('add', [1]);
  await h.advance(100);
  assert.equal(h.state.executes.length, 0);
  item = pdfItem();
  await h.advance(100);
  await h.advance(100);
  assert.equal(h.state.executes.length, 1);
});

test('stat change postpones execution until two identical observations', async () => {
  let stat = { size: 10, mtime: 1 };
  const h = harness({ items: { 1: pdfItem() }, stats: { '/tmp/1.pdf': () => stat } });
  await h.dispatcher.start();
  await h.dispatcher.observe('add', [1]);
  await h.advance(100);
  stat = { size: 11, mtime: 2 };
  await h.advance(100);
  assert.equal(h.state.executes.length, 0);
  await h.advance(100);
  assert.equal(h.state.executes.length, 1);
});

test('duplicate add and modify do not duplicate a task or execute', async () => {
  const h = harness({ items: { 1: pdfItem() }, stats: { '/tmp/1.pdf': { size: 10, mtime: 1 } } });
  await h.dispatcher.start();
  await Promise.all([h.dispatcher.observe('add', [1]), h.dispatcher.observe('add', [1])]);
  await h.dispatcher.observe('modify', [1]);
  await runToExecute(h);
  await h.dispatcher.observe('modify', [1]);
  await h.advance(200);
  assert.equal(Object.keys(h.dispatcher.tasks).length, 1);
  assert.equal(h.state.executes.length, 1);
});

test('disabled configuration prevents observation and tick execution', async () => {
  const h = harness({ cfg: { autoEnabled: false }, items: { 1: pdfItem() } });
  await h.dispatcher.start();
  await h.dispatcher.observe('add', [1]);
  assert.deepEqual(h.dispatcher.tasks, {});
  h.dispatcher.tasks['1'] = { itemID: 1, state: 'waiting', dueAt: 0, capturedAt: 0, identity: 'profile:personal' };
  await h.dispatcher.tick();
  assert.equal(h.state.executes.length, 0);
});

test('running task is recovered as waiting on startup', async () => {
  const h = harness({ saved: { version: 1, tasks: { '1': { itemID: 1, state: 'running', attempts: 9 } } } });
  await h.dispatcher.start();
  assert.equal(h.dispatcher.tasks['1'].state, 'waiting');
  assert.equal(h.dispatcher.tasks['1'].recovered, true);
  assert.equal(h.dispatcher.tasks['1'].attempts, 0);
});

test('worker error is terminal and is not blindly retried', async () => {
  let calls = 0;
  const h = harness({ items: { 1: pdfItem() }, stats: { '/tmp/1.pdf': { size: 10, mtime: 1 } },
    execute: async () => { calls++; throw new Error('worker failed'); } });
  await h.dispatcher.start();
  await runToExecute(h);
  assert.equal(calls, 1);
  assert.equal(h.dispatcher.tasks['1'].state, 'error');
  await h.advance(500);
  assert.equal(calls, 1);
});

test('stop cancels pending timer', async () => {
  const h = harness({ items: { 1: pdfItem() } });
  await h.dispatcher.start();
  await h.dispatcher.observe('add', [1]);
  assert.equal(h.timers.size, 1);
  h.dispatcher.stop();
  assert.equal(h.timers.size, 0);
  await h.advance(1000);
  assert.equal(h.state.executes.length, 0);
});

test('waiting-file is rechecked at low frequency without modify, and stop cancels it', async () => {
  let stat = null;
  const h = harness({ items: { 1: pdfItem() }, stats: { '/tmp/1.pdf': () => stat } });
  await h.dispatcher.start();
  await h.dispatcher.observe('add', [1]);

  // maxWaits=3: the third missing-file check enters waiting-file.
  await h.advance(100);
  await h.advance(100);
  await h.advance(100);
  assert.equal(h.dispatcher.tasks['1'].state, 'waiting-file');
  assert.equal(h.timers.size, 1, 'waiting-file must retain a low-frequency retry timer');

  stat = { size: 10, mtime: 1 };
  await h.advance(60000);
  assert.equal(h.state.executes.length, 0, 'first recheck records the stable-file baseline');
  await h.advance(100);
  await h.advance(100);
  assert.equal(h.state.executes.length, 1);

  // A second waiting-file task must be cancellable during shutdown.
  const h2 = harness({ items: { 2: pdfItem(2) }, stats: { '/tmp/2.pdf': () => null } });
  await h2.dispatcher.start();
  await h2.dispatcher.observe('add', [2]);
  await h2.advance(100);
  await h2.advance(100);
  await h2.advance(100);
  assert.equal(h2.dispatcher.tasks['2'].state, 'waiting-file');
  assert.equal(h2.timers.size, 1);
  h2.dispatcher.stop();
  assert.equal(h2.timers.size, 0);
});
