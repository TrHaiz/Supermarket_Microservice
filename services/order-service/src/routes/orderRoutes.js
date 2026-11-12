const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { validateOrder } = require('../validators/orderValidator');
const { createOrder } = require('../controllers/orderController');

router.post('/', validateOrder, createOrder);

// GET /api/orders — Get orders with limit/pagination (default: 20)
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const orders = await Order.find().sort({ createdAt: -1 }).skip(skip).limit(limit);

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
