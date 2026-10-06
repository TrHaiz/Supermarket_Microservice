const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { validateOrder } = require('../validators/orderValidator');
const Counter = require('../models/Counter');
const { getProductById } = require('../clients/productClient');
const { decreaseInventory } = require('../clients/inventoryClient');

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
router.post('/', validateOrder, async (req, res, next) => {
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
});

// GET /api/orders — Get all orders
router.get('/', async (req, res, next) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      count: orders.length,
      data: orders
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/:id — Get order by ID
router.get('/:id', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Order not found'
        }
      });
    }

    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    // Handle invalid ObjectId format
    if (error.name === 'CastError') {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Order not found'
        }
      });
    }
    next(error);
  }
});

module.exports = router;
