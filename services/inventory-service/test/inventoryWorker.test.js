const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

function worker(stock = 5, options = {}) {
  const state = { quantity: stock, receipts: [], writes: 0, productReads: 0, publications: 0 };
  const Inventory = {
    findOne: (filter) => ({ select: async () => state.receipts.some((r) => r.eventId === filter['orderReservations.eventId'])
      ? { orderReservations: structuredClone(state.receipts) } : null }),
    findOneAndUpdate: async (filter, update) => {
      if (options.dbError) throw new Error('MongoDB unavailable');
      if (state.receipts.some((r) => r.eventId === filter['orderReservations.eventId'].$ne)) return null;
      if (filter.quantity.$gte !== undefined && state.quantity < filter.quantity.$gte) return null;
      if (filter.quantity.$lt !== undefined && state.quantity >= filter.quantity.$lt) return null;
      if (options.missingInventory) return null;
      if (update.$inc) state.quantity += update.$inc.quantity;
      state.receipts.push(update.$push.orderReservations);
      state.writes += 1;
      return { quantity: state.quantity };
    },
    exists: async () => !options.missingInventory
  };
  const filename = path.resolve(__dirname, '../src/workers/inventoryWorker.js');
  const module = new Module(filename);
  const dependencies = {
    '../models/Inventory': Inventory,
    '../clients/productClient': { getProductById: async () => {
      state.productReads += 1;
      return options.product || { success: true, data: { data: { price: 10 } } };
    } },
    '../config/streams': {}
  };
  module.require = (name) => { assert.ok(Object.hasOwn(dependencies, name)); return dependencies[name]; };
  module._compile(fs.readFileSync(filename, 'utf8'), filename);
  const redis = {
    hget: async () => null,
    eval: async () => {
      if (options.redisError) throw new Error('Redis unavailable');
      state.publications += 1;
    }
  };
  return { ...module.exports, state, redis };
}

function event(index = 0, quantity = 1) {
  return { type: 'order_created', orderId: `order-${index}`, itemIndex: '0',
    eventId: `order-${index}:0`, productId: 'sku', quantity: String(quantity), userId: 'u' };
}

test('atomic stock filter prevents overselling with concurrent distinct orders', async () => {
  const { reserveInventory, state } = worker(5);
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveInventory(event(i))));
  assert.equal(outcomes.filter((r) => r.type === 'inventory_reserved').length, 5);
  assert.equal(outcomes.filter((r) => r.type === 'inventory_failed').length, 15);
  assert.equal(state.quantity, 0);
});

test('concurrent duplicate delivery decrements exactly once', async () => {
  const { reserveInventory, state } = worker(5);
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => reserveInventory(event(0, 2))));
  assert.ok(outcomes.every((r) => r.type === 'inventory_reserved'));
  assert.equal(state.quantity, 3);
  assert.equal(state.writes, 1);
});

test('receipt survives publish failure; retry never subtracts again or requotes price', async () => {
  const options = { redisError: true };
  const instance = worker(5, options);
  await assert.rejects(instance.handleOrderCreated(event(0, 2), '1-0', instance.redis), /Redis unavailable/);
  assert.equal(instance.state.quantity, 3);
  options.redisError = false;
  await instance.handleOrderCreated(event(0, 2), '1-0', instance.redis);
  assert.equal(instance.state.quantity, 3);
  assert.equal(instance.state.writes, 1);
  assert.equal(instance.state.productReads, 1);
  assert.equal(instance.state.publications, 1);
});

test('out-of-stock receipt preserves failure after restock', async () => {
  const instance = worker(0);
  assert.equal((await instance.reserveInventory(event())).type, 'inventory_failed');
  instance.state.quantity = 10;
  assert.equal((await instance.reserveInventory(event())).type, 'inventory_failed');
  assert.equal(instance.state.quantity, 10);
});

test('MongoDB failures leave message pending without emitting a business failure', async () => {
  const instance = worker(5, { dbError: true });
  await assert.rejects(instance.handleOrderCreated(event(), '1-0', instance.redis), /MongoDB unavailable/);
  assert.equal(instance.state.publications, 0);
  assert.equal(instance.state.quantity, 5);
});

test('transient product outage retries without touching stock', async () => {
  const instance = worker(5, { product: { success: false, status: 503 } });
  await assert.rejects(instance.handleOrderCreated(event(), '1-0', instance.redis), /retry later/);
  assert.equal(instance.state.writes, 0);
  assert.equal(instance.state.publications, 0);
});

test('missing inventory and nonexistent product produce business failure outcomes', async () => {
  const missing = worker(5, { missingInventory: true });
  assert.equal((await missing.reserveInventory(event())).code, 'INVENTORY_NOT_FOUND');
  const product = worker(5, { product: { success: false, status: 404 } });
  assert.equal((await product.reserveInventory(event())).code, 'PRODUCT_NOT_FOUND');
  assert.equal(product.state.writes, 0);
});

test('malformed quantity is rejected before product lookup or mutation', async () => {
  const instance = worker();
  for (const quantity of ['-1', '0', '1.5', 'NaN', '9007199254740992']) {
    await assert.rejects(instance.reserveInventory({ ...event(), quantity }), /Invalid/);
  }
  assert.equal(instance.state.productReads, 0);
  assert.equal(instance.state.writes, 0);
});
