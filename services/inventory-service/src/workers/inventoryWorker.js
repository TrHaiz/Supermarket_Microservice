const Inventory = require('../models/Inventory');
const { getProductById } = require('../clients/productClient');
const { getRedis, consumeStream } = require('../config/streams');

const PUBLISH_AND_ACK = `
  local payload = redis.call('HGET', KEYS[3], ARGV[1]) or ARGV[3]
  local event = cjson.decode(payload)
  local fields = {}
  for key, value in pairs(event) do
    table.insert(fields, key)
    table.insert(fields, tostring(value))
  end
  redis.call('XADD', KEYS[1], '*', unpack(fields))
  redis.call('HSET', KEYS[3], ARGV[1], payload)
  return redis.call('XACK', KEYS[2], 'inventory_group', ARGV[2])
`;

async function findReceipt(productId, eventId) {
  const inventory = await Inventory.findOne({ productId, 'orderReservations.eventId': eventId })
    .select('+orderReservations');
  return inventory?.orderReservations.find((receipt) => receipt.eventId === eventId);
}

async function reserveInventory(event) {
  const quantity = Number(event.quantity);
  const itemIndex = Number(event.itemIndex);
  if (event.type !== 'order_created' || !event.orderId || !event.productId ||
    !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(itemIndex) ||
    itemIndex < 0 || event.eventId !== `${event.orderId}:${itemIndex}`) {
    throw new Error('Invalid order_created event');
  }
  const result = (receipt) => ({
    ...event, type: receipt.type || 'inventory_reserved', price: String(receipt.price),
    ...(receipt.code ? { code: receipt.code, message: receipt.message } : {})
  });
  const previous = await findReceipt(event.productId, event.eventId);
  if (previous) return result(previous);

  const product = await getProductById(event.productId);
  if (!product.success) {
    if (product.status !== 404) throw new Error('Product service unavailable; retry later');
    return { ...event, type: 'inventory_failed', code: 'PRODUCT_NOT_FOUND', message: 'Product not found' };
  }
  const price = product.data?.data?.price;
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(price * quantity)) {
    throw new Error('Invalid product price');
  }

  // Each loop resolves a race with an inventory update or another consumer.
  for (; ;) {
    const reserved = await Inventory.findOneAndUpdate({
      productId: event.productId,
      quantity: { $gte: quantity },
      'orderReservations.eventId': { $ne: event.eventId }
    }, {
      $inc: { quantity: -quantity },
      $push: { orderReservations: { eventId: event.eventId, type: 'inventory_reserved', price } }
    }, { new: true });
    if (reserved) return result({ price });

    const receipt = await findReceipt(event.productId, event.eventId);
    if (receipt) return result(receipt);

    const failure = {
      eventId: event.eventId, type: 'inventory_failed', price: 0,
      code: 'INSUFFICIENT_STOCK', message: 'Insufficient stock'
    };
    const failed = await Inventory.findOneAndUpdate({
      productId: event.productId,
      quantity: { $lt: quantity },
      'orderReservations.eventId': { $ne: event.eventId }
    }, { $push: { orderReservations: failure } }, { new: true });
    if (failed) return result(failure);
    const exists = await Inventory.exists({ productId: event.productId });
    if (!exists) return {
      ...event, type: 'inventory_failed',
      code: 'INVENTORY_NOT_FOUND', message: 'Inventory not found'
    };
  }
}

async function handleOrderCreatedBatch(items, redis) {
  if (!items || items.length === 0) return;

  // 1. Process all inventory reservations in parallel
  const outcomes = await Promise.all(items.map(async ({ id, event }) => {
    const resultKey = `inventory:results:${event.orderId}`;
    const cached = await redis.hget(resultKey, event.eventId);
    const outcome = cached ? JSON.parse(cached) : await reserveInventory(event);
    return { id, event, outcome, resultKey };
  }));

  // 2. Publish results to inventory_results_stream and ACK in parallel
  await Promise.all(outcomes.map(({ id, event, outcome, resultKey }) =>
    redis.eval(PUBLISH_AND_ACK, 3, 'inventory_results_stream', 'orders_stream',
      resultKey, event.eventId, id, JSON.stringify(outcome))
  ));
}

async function handleOrderCreated(event, id, redis) {
  return handleOrderCreatedBatch([{ id, event }], redis);
}

async function startInventoryWorker() {
  const redis = getRedis();
  await redis.connect();
  const stopConsumer = await consumeStream('orders_stream', 'inventory_group', handleOrderCreatedBatch);
  return async () => {
    await stopConsumer();
    redis.disconnect();
  };
}

module.exports = { startInventoryWorker, handleOrderCreated, handleOrderCreatedBatch, reserveInventory };
