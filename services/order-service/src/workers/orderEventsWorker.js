const Order = require('../models/Order');
const { getRedis, consumeStream } = require('../config/streams');

// Retransmitting an embedded outbox must not create duplicate logical events.
const PUBLISH = `
  local events = cjson.decode(ARGV[1])
  for _, event in ipairs(events) do
    if redis.call('HEXISTS', KEYS[2], event.eventId) == 0 then
      local id = redis.call('XADD', KEYS[1], '*',
        'type', 'order_created', 'eventId', event.eventId,
        'orderId', event.orderId, 'itemIndex', tostring(event.itemIndex),
        'productId', event.productId, 'quantity', tostring(event.quantity),
        'userId', event.userId)
      redis.call('HSET', KEYS[2], event.eventId, id)
    end
  end
  return 1
`;

async function publishOrder(order) {
  const orderId = String(order._id);
  const events = order.asyncOrder.requestedItems.map((item, itemIndex) => ({
    eventId: `${orderId}:${itemIndex}`,
    orderId, itemIndex: String(itemIndex), productId: item.productId, quantity: String(item.quantity),
    userId: order.asyncOrder.userId
  }));
  await getRedis().eval(PUBLISH, 2, 'orders_stream', `orders:published:${orderId}`, JSON.stringify(events));
  await Order.updateOne({ _id: order._id }, { $set: { 'asyncOrder.published': true } });
}

async function handleInventoryResult(event, id, redis) {
  if (!['inventory_reserved', 'inventory_failed'].includes(event.type)) {
    throw new Error(`Unsupported inventory event: ${event.type}`);
  }
  const index = Number(event.itemIndex);
  const order = await Order.findById(event.orderId).select('+asyncOrder');
  if (!order || !order.asyncOrder) throw new Error(`Async order not found: ${event.orderId}`);
  const item = order.asyncOrder.requestedItems[index];
  if (!Number.isSafeInteger(index) || index < 0 || !item ||
    event.eventId !== `${order._id}:${index}` || item.productId !== event.productId ||
    item.quantity !== Number(event.quantity)) {
    throw new Error('Invalid inventory result correlation');
  }
  if (order.status === 'PENDING') {
    const result = event.type === 'inventory_reserved'
      ? {
        productId: item.productId, quantity: item.quantity, price: Number(event.price),
        subtotal: item.quantity * Number(event.price)
      }
      : {
        productId: item.productId, quantity: item.quantity,
        error: { code: event.code || 'INSUFFICIENT_STOCK', message: event.message || 'Insufficient stock' }
      };
    if (!result.error && (!Number.isFinite(result.price) || result.price < 0 || !Number.isFinite(result.subtotal))) {
      throw new Error('Invalid inventory result price');
    }
    // A slot is written once, so a replay cannot count the same line twice.
    await Order.updateOne({ _id: order._id, status: 'PENDING', [`asyncOrder.results.${index}`]: null },
      { $set: { [`asyncOrder.results.${index}`]: result } });
    const current = await Order.findById(order._id).select('+asyncOrder');
    const results = current.asyncOrder.results;
    if (results.length === current.asyncOrder.requestedItems.length && results.every(Boolean)) {
      const items = results.filter((entry) => !entry.error);
      const failedItems = results.filter((entry) => entry.error);
      await Order.updateOne({ _id: order._id, status: 'PENDING' }, {
        $set: {
          items, failedItems,
          total: items.reduce((sum, entry) => sum + entry.subtotal, 0),
          status: !items.length ? 'FAILED' : (failedItems.length ? 'PARTIAL' : 'COMPLETED')
        }
      });
    }
  }
  // Only acknowledge after the local database update (including finalization).
  await redis.xack('inventory_results_stream', 'order_group', id);
}

async function handleInventoryResultBatch(items, redis) {
  if (!items || items.length === 0) return;
  await Promise.all(items.map(({ id, event }) => handleInventoryResult(event, id, redis)));
}

async function startOrderEventsWorker() {
  const redis = getRedis();
  await redis.connect();
  const stopConsumer = await consumeStream('inventory_results_stream', 'order_group', handleInventoryResultBatch);
  let stopping = false;
  let wake;

  const dispatcher = (async () => {
    const batchLimit = Number(process.env.OUTBOX_BATCH_LIMIT) || 200;
    const pollInterval = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 200;
    while (!stopping) {
      try {
        const orders = await Order.find({ 'asyncOrder.published': false })
          .select('+asyncOrder').limit(batchLimit);
        if (orders.length > 0) {
          await Promise.all(orders.map((order) => publishOrder(order)));
        }
      } catch (error) {
        console.error('[order outbox]', error.message);
      }
      if (!stopping) await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollInterval);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  })();
  return async () => {
    stopping = true;
    if (wake) wake();
    await Promise.all([dispatcher, stopConsumer()]);
    redis.disconnect();
  };
}

module.exports = { publishOrder, handleInventoryResult, handleInventoryResultBatch, startOrderEventsWorker };
