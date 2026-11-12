const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

// Load a fresh CommonJS module with explicit infrastructure doubles.
function load(file, dependencies) {
  const filename = path.resolve(__dirname, '../src', file);
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : originalRequire(name);
  module._compile(fs.readFileSync(filename, 'utf8'), filename);
  return module.exports;
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

function controller(t, enabled, overrides = {}) {
  const previous = process.env.ENABLE_ASYNC_ORDER;
  if (enabled === undefined) delete process.env.ENABLE_ASYNC_ORDER;
  else process.env.ENABLE_ASYNC_ORDER = String(enabled);
  t.after(() => {
    if (previous === undefined) delete process.env.ENABLE_ASYNC_ORDER;
    else process.env.ENABLE_ASYNC_ORDER = previous;
  });
  const calls = [];
  const dependencies = {
    '../models/Order': { create: async (data) => {
      calls.push('save');
      return { ...data, _id: 'order-1', toJSON() { const { asyncOrder, toJSON, ...publicOrder } = this; return publicOrder; } };
    } },
    '../models/Counter': { getNextSeq: async () => 1 },
    '../clients/productClient': { getProductById: async () => {
      calls.push('product'); return { success: true, data: { data: { price: 10 } } };
    } },
    '../clients/inventoryClient': { decreaseInventory: async () => {
      calls.push('inventory'); return { success: true };
    } },
    '../workers/orderEventsWorker': { publishOrder: async () => { calls.push('publish'); } },
    ...overrides
  };
  return { ...load('controllers/orderController.js', dependencies), calls };
}

const request = { body: { items: [{ productId: ' sku-1 ', quantity: 2 }] }, get: () => 'user-1' };
const unexpected = (error) => { throw error; };

test('async persists before publishing, returns 202 and never calls inventory/product HTTP', async (t) => {
  const { createOrder, calls } = controller(t, true);
  const res = response();
  await createOrder(request, res, unexpected);
  assert.deepEqual(calls, ['save', 'publish']);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.data.orderId, 'order-1');
  assert.equal(res.body.data.status, 'PENDING');
  assert.equal(res.body.data.items[0].productId, 'sku-1');
  assert.equal(res.body.data.asyncOrder, undefined);
});

test('failed XADD returns 503 and saved orderId without falling back to HTTP', async (t) => {
  const { createOrder, calls } = controller(t, true, {
    '../workers/orderEventsWorker': { publishOrder: async () => { throw new Error('Redis unavailable'); } }
  });
  const res = response();
  await createOrder(request, res, unexpected);
  assert.deepEqual(calls, ['save']);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'ORDER_PUBLISH_PENDING');
  assert.equal(res.body.data.orderId, 'order-1');
});

for (const flag of [false, undefined]) {
  test(`flag ${flag}: original synchronous response is 201 COMPLETED`, async (t) => {
    const { createOrder, calls } = controller(t, flag);
    const res = response();
    await createOrder(request, res, unexpected);
    assert.deepEqual(calls, ['product', 'inventory', 'save']);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.status, 'COMPLETED');
    assert.equal(res.body.data.total, 20);
  });
}

test('fallback keeps ALL_ITEMS_FAILED and does not save when every stock decrease fails', async (t) => {
  const { createOrder, calls } = controller(t, false, {
    '../clients/inventoryClient': { decreaseInventory: async () => ({ success: false, status: 400 }) }
  });
  const res = response();
  await createOrder(request, res, unexpected);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'ALL_ITEMS_FAILED');
  assert.deepEqual(calls, ['product']);
});

test('publisher uses stable per-line IDs (including repeated SKUs) and marks outbox only after Redis', async () => {
  const calls = [];
  const { publishOrder } = load('workers/orderEventsWorker.js', {
    '../models/Order': { updateOne: async () => calls.push('mark') },
    '../config/streams': { getRedis: () => ({ eval: async (...args) => calls.push(args) }) }
  });
  await publishOrder({ _id: 'o', asyncOrder: { userId: 'u', requestedItems: [
    { productId: 'sku', quantity: 1 }, { productId: 'sku', quantity: 2 }
  ] } });
  assert.equal(calls[0][2], 'orders_stream');
  assert.deepEqual(JSON.parse(calls[0][4]).map((event) => event.eventId), ['o:0', 'o:1']);
  assert.equal(JSON.parse(calls[0][4])[1].quantity, '2');
  assert.equal(calls[1], 'mark');
});

function resultsWorker({ failFinalization = false } = {}) {
  const order = { _id: 'o', status: 'PENDING', asyncOrder: {
    requestedItems: [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }],
    results: [null, null]
  } };
  let acks = 0;
  const Order = {
    findById: () => ({ select: async () => structuredClone(order) }),
    updateOne: async (filter, update) => {
      if (order.status !== filter.status) return;
      if (update.$set.status && failFinalization) { failFinalization = false; throw new Error('DB failed'); }
      for (const [key, value] of Object.entries(update.$set)) {
        if (key.startsWith('asyncOrder.results.')) {
          const index = Number(key.split('.').at(-1));
          if (order.asyncOrder.results[index] === null) order.asyncOrder.results[index] = value;
        } else order[key] = value;
      }
    }
  };
  return { ...load('workers/orderEventsWorker.js', { '../models/Order': Order, '../config/streams': {} }),
    order, redis: { xack: async () => { acks += 1; } }, acks: () => acks };
}

const success = { type: 'inventory_reserved', orderId: 'o', itemIndex: '0',
  eventId: 'o:0', productId: 'a', quantity: '2', price: '10' };
const failure = { type: 'inventory_failed', orderId: 'o', itemIndex: '1',
  eventId: 'o:1', productId: 'b', quantity: '1', code: 'INSUFFICIENT_STOCK', message: 'Insufficient stock' };

test('duplicate and out-of-order results finish PARTIAL with no double counting', async () => {
  const worker = resultsWorker();
  await worker.handleInventoryResult(failure, '1', worker.redis);
  await worker.handleInventoryResult(failure, '2', worker.redis);
  assert.equal(worker.order.status, 'PENDING');
  await worker.handleInventoryResult(success, '3', worker.redis);
  await worker.handleInventoryResult(success, '4', worker.redis);
  assert.equal(worker.order.status, 'PARTIAL');
  assert.equal(worker.order.total, 20);
  assert.equal(worker.order.items.length, 1);
  assert.equal(worker.order.failedItems.length, 1);
  assert.equal(worker.acks(), 4);
});

test('all failed lines finish FAILED with zero total', async () => {
  const worker = resultsWorker();
  await worker.handleInventoryResult({ ...success, type: 'inventory_failed' }, '1', worker.redis);
  await worker.handleInventoryResult(failure, '2', worker.redis);
  assert.equal(worker.order.status, 'FAILED');
  assert.equal(worker.order.total, 0);
  assert.deepEqual(worker.order.items, []);
});

test('crash between last result slot and finalization leaves message pending and replay finalizes', async () => {
  const worker = resultsWorker({ failFinalization: true });
  await worker.handleInventoryResult(success, '1', worker.redis);
  await assert.rejects(worker.handleInventoryResult(failure, '2', worker.redis), /DB failed/);
  assert.equal(worker.acks(), 1);
  assert.equal(worker.order.status, 'PENDING');
  await worker.handleInventoryResult(failure, '2', worker.redis);
  assert.equal(worker.order.status, 'PARTIAL');
  assert.equal(worker.acks(), 2);
});

test('mismatched result is not acknowledged or applied', async () => {
  const worker = resultsWorker();
  await assert.rejects(worker.handleInventoryResult({ ...success, quantity: '100' }, '1', worker.redis), /correlation/);
  assert.equal(worker.acks(), 0);
  assert.deepEqual(worker.order.asyncOrder.results, [null, null]);
});

test('validation rejects null items and unsafe quantities instead of throwing', () => {
  const { validateOrder } = load('validators/orderValidator.js', {});
  for (const items of [[null], [{ productId: 'a', quantity: Number.MAX_SAFE_INTEGER + 1 }]]) {
    const res = response();
    validateOrder({ body: { items } }, res, () => assert.fail('validation should fail'));
    assert.equal(res.statusCode, 400);
  }
});
