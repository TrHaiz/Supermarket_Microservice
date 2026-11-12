const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

test('consumer creates group at 0, recovers pending, reads new events on a dedicated connection and stops', async () => {
  const instances = [];
  const calls = [];
  let resolveProcessed;
  const processed = new Promise((resolve) => { resolveProcessed = resolve; });
  class FakeRedis extends EventEmitter {
    constructor() { super(); instances.push(this); this.claims = 0; this.reads = 0; }
    duplicate() { return new FakeRedis(); }
    async connect() {}
    async xgroup(...args) { calls.push(args); }
    async xautoclaim(...args) {
      calls.push(args);
      this.claims += 1;
      return this.claims === 1 ? ['2-0', [['1-0', ['type', 'order_created']]]] : ['0-0', []];
    }
    async xreadgroup(...args) {
      calls.push(args);
      this.reads += 1;
      if (this.reads === 1) return [['stream', [['3-0', ['type', 'order_created']]]]];
      await new Promise((resolve) => setTimeout(resolve, 10));
      return null;
    }
    disconnect() { this.disconnected = true; }
  }
  const filename = path.resolve(__dirname, '../src/config/streams.js');
  const module = new Module(filename);
  const originalRequire = module.require.bind(module);
  module.require = (name) => name === 'ioredis' ? FakeRedis : originalRequire(name);
  module._compile(fs.readFileSync(filename, 'utf8'), filename);
  assert.equal(instances.length, 0, 'importing module when flag is off must not connect');
  const seen = [];
  const stop = await module.exports.consumeStream('stream', 'group', async (event, id, commands) => {
    assert.equal(commands, instances[0]);
    seen.push([event.type, id]);
    if (seen.length === 2) resolveProcessed();
  });
  await processed;
  await stop();
  assert.equal(instances.length, 2);
  assert.equal(instances[1].disconnected, true);
  assert.deepEqual(calls[0], ['CREATE', 'stream', 'group', '0', 'MKSTREAM']);
  assert.deepEqual(seen, [['order_created', '1-0'], ['order_created', '3-0']]);
  assert.ok(calls.some((args) => args.includes(60000)), 'stale pending messages are reclaimed');
  assert.ok(calls.some((args) => args.includes('BLOCK') && args.at(-1) === '>'));
});
