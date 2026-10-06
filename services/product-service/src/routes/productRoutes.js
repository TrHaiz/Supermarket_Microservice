const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const { validateProduct } = require('../validators/productValidator');
const { getCache, setCache, delCache } = require('../config/redis');

// GET /api/products/test-db
router.get('/test-db', async (req, res) => {
  const state = mongoose.connection.readyState;
  const stateMap = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };

  res.json({
    success: state === 1,
    database: stateMap[state] || 'unknown'
  });
});

// POST /api/products/bulk — Get multiple products by IDs (Internal REST API)
router.post('/bulk', async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'ids must be an array'
        }
      });
    }

    if (ids.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Filter valid ObjectIds to prevent CastError
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));

    const products = validIds.length > 0
      ? await Product.find({ _id: { $in: validIds } })
      : [];

    res.json({
      success: true,
      data: products
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/products — Create product
router.post('/', validateProduct, async (req, res, next) => {
  try {
    const { name, price, quantity } = req.body;
    const product = await Product.create({ name, price, quantity });

    res.status(201).json({
      success: true,
      data: product
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/products — Get all products
router.get('/', async (req, res, next) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      count: products.length,
      data: products
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/products/:id — Get product by ID (Cache Aside)
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const cacheKey = `product:${id}`;

    // 1. Check Redis cache
    const cachedProduct = await getCache(cacheKey);
    if (cachedProduct) {
      console.log(`[CACHE HIT] ${cacheKey}`);
      return res.json({
        success: true,
        data: cachedProduct
      });
    }

    console.log(`[CACHE MISS] ${cacheKey}`);

    // 2. Query MongoDB
    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Product not found'
        }
      });
    }

    // 3. Save to Redis
    await setCache(cacheKey, product);

    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    // Handle invalid ObjectId
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid product ID format'
        }
      });
    }
    next(error);
  }
});

// DELETE /api/products/:id — Delete product & Invalidate Cache
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const product = await Product.findByIdAndDelete(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Product not found'
        }
      });
    }

    // Invalidate cache sau khi MongoDB xóa thành công
    await delCache(`product:${id}`);

    res.json({
      success: true,
      message: 'Product deleted',
      data: product
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid product ID format'
        }
      });
    }
    next(error);
  }
});

module.exports = router;
