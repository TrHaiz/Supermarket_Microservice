const Order = require('../models/Order');
const Counter = require('../models/Counter');
const { getProductById } = require('../clients/productClient');
const { decreaseInventory } = require('../clients/inventoryClient');
const { publishOrder } = require('../workers/orderEventsWorker');

/**
 * Generate orderCode: ORD-YYYYMMDD-NNNN
 * Uses atomic MongoDB counter ($inc + upsert) per day.
 */
const generateOrderCode = async () => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

  const seq = await Counter.getNextSeq(`order-${dateStr}`);

  return `ORD-${dateStr}-${String(seq).padStart(4, '0')}`;
};

// POST /api/orders — Create a new order
const createOrderSync = async (req, res, next) => {
  try {
    const { items } = req.body;

    const validItems = [];
    const failedItems = [];

    // Process each item independently
    for (const item of items) {
      const productId = item.productId.trim();
      const quantity = item.quantity;

      // 1. Verify product exists & get price from Product Service
      const productResult = await getProductById(productId);
      if (!productResult.success) {
        const status = productResult.status;
        const code = status === 404
          ? 'PRODUCT_NOT_FOUND'
          : (status === 504 ? 'PRODUCT_SERVICE_TIMEOUT' : 'PRODUCT_SERVICE_UNAVAILABLE');

        failedItems.push({
          productId,
          quantity,
          error: {
            code,
            message: productResult.data?.message || `Failed to verify product ${productId}`
          }
        });
        continue;
      }

      // 2. Atomic decrease stock from Inventory Service
      const decreaseResult = await decreaseInventory(productId, quantity);
      if (!decreaseResult.success) {
        const status = decreaseResult.status;
        let code = 'INVENTORY_SERVICE_ERROR';
        if (status === 404) code = 'INVENTORY_NOT_FOUND';
        else if (status === 400) code = 'INSUFFICIENT_STOCK';
        else if (status === 504) code = 'INVENTORY_SERVICE_TIMEOUT';
        else if (status === 503) code = 'INVENTORY_SERVICE_UNAVAILABLE';

        failedItems.push({
          productId,
          quantity,
          error: {
            code,
            message: decreaseResult.data?.error?.message || decreaseResult.data?.message || `Failed to decrease stock for product ${productId}`
          }
        });
        continue;
      }

      // 3. Item succeeded
      const product = productResult.data.data;
      validItems.push({
        productId,
        quantity,
        price: product.price,
        subtotal: quantity * product.price
      });
    }

    // CASE 2: No valid items -> Do not create order
    if (validItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ALL_ITEMS_FAILED',
          message: 'All items failed to process',
          failedItems
        }
      });
    }

    // CASE 1: At least 1 valid item -> Create order (COMPLETED or PARTIAL)
    const total = validItems.reduce((sum, item) => sum + item.subtotal, 0);
    const status = failedItems.length > 0 ? 'PARTIAL' : 'COMPLETED';
    const orderCode = await generateOrderCode();

    const order = await Order.create({
      orderCode,
      items: validItems,
      failedItems,
      total,
      status
    });

    res.status(201).json({
      success: true,
      data: order
    });
  } catch (error) {
    // Handle unique index violation on orderCode (race condition fallback)
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_ORDER_CODE',
          message: 'Order code conflict, please retry'
        }
      });
    }
    next(error);
  }
};

async function createOrder(req, res, next) {
  if (process.env.ENABLE_ASYNC_ORDER !== 'true') return createOrderSync(req, res, next);
  try {
    const items = req.body.items.map(({ productId, quantity }) => ({
      productId: productId.trim(), quantity, price: 0, subtotal: 0
    }));
    const order = await Order.create({
      orderCode: await generateOrderCode(),
      items, total: 0, status: 'PENDING',
      asyncOrder: {
        published: false,
        // The gateway verifies JWT and overwrites this header.
        userId: req.get('x-user-id') || '',
        requestedItems: items,
        results: items.map(() => null)
      }
    });
    try {
      // Persist first, publish second, then acknowledge acceptance to the client.
      await publishOrder(order);
    } catch (error) {
      console.error('[order publish] Pending outbox will retry:', error.message);
      return res.status(503).json({
        success: false,
        error: { code: 'ORDER_PUBLISH_PENDING', message: 'Order saved; event publication will be retried' },
        data: { orderId: order._id, status: 'PENDING' }
      });
    }
    return res.status(202).json({ success: true, data: {
      ...order.toJSON(), orderId: order._id, status: 'PENDING'
    } });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: {
        code: 'DUPLICATE_ORDER_CODE', message: 'Order code conflict, please retry'
      } });
    }
    next(error);
  }
}

module.exports = { createOrder, createOrderSync };
