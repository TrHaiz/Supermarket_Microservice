const express = require('express');
const router = express.Router();
const Inventory = require('../models/Inventory');
const { validateInventory, validateQuantityUpdate, validateDecreaseQuantity } = require('../validators/inventoryValidator');
const { getProductById, getProductsBulk } = require('../clients/productClient');

// POST /api/inventory — Create inventory for a product
router.post('/', validateInventory, async (req, res, next) => {
  try {
    const { productId, quantity } = req.body;

    // Step 1: Verify product exists via Product Service
    const productResult = await getProductById(productId);

    if (!productResult.success) {
      return res.status(productResult.status).json({
        success: false,
        error: {
          code: productResult.status === 404 ? 'PRODUCT_NOT_FOUND' : 'SERVICE_ERROR',
          message: productResult.data?.message || 'Failed to verify product'
        }
      });
    }

    // Step 2: Check duplicate
    const existing = await Inventory.findOne({ productId });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_INVENTORY',
          message: 'Inventory already exists for this product'
        }
      });
    }

    const inventory = await Inventory.create({ productId, quantity });

    res.status(201).json({
      success: true,
      data: inventory
    });
  } catch (error) {
    // Handle unique index violation (race condition fallback)
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_INVENTORY',
          message: 'Inventory already exists for this product'
        }
      });
    }
    next(error);
  }
});

// GET /api/inventory — Get all inventories with aggregated product details
router.get('/', async (req, res, next) => {
  try {
    const inventories = await Inventory.find().sort({ createdAt: -1 });

    if (inventories.length === 0) {
      return res.json({
        success: true,
        count: 0,
        data: []
      });
    }

    // 1. Trích xuất danh sách productId (loại bỏ trùng lặp)
    const productIds = [...new Set(inventories.map((inv) => inv.productId))];

    // 2. Bulk fetch product info từ Product Service
    const productResult = await getProductsBulk(productIds);

    if (!productResult.success) {
      return res.status(productResult.status || 503).json({
        success: false,
        error: {
          code: 'PRODUCT_SERVICE_UNAVAILABLE',
          message: productResult.data?.message || 'Unable to retrieve product information'
        }
      });
    }

    // 3. Map products by ID để lookup O(1)
    const productList = productResult.data?.data || [];
    const productMap = new Map();
    productList.forEach((prod) => {
      productMap.set(prod._id.toString(), prod);
    });

    // 4. Merge inventory + product
    const aggregatedData = inventories.map((inv) => {
      const product = productMap.get(inv.productId.toString());

      if (!product) {
        return {
          product: null,
          inventory: {
            productId: inv.productId,
            quantity: inv.quantity
          },
          error: {
            code: 'PRODUCT_NOT_FOUND',
            message: `Product ${inv.productId} not found`
          }
        };
      }

      return {
        product: {
          _id: product._id,
          name: product.name,
          price: product.price
        },
        inventory: {
          productId: inv.productId,
          quantity: inv.quantity
        },
      };
    });

    res.json({
      success: true,
      count: aggregatedData.length,
      data: aggregatedData
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/inventory/:productId — Get inventory by productId
router.get('/:productId', async (req, res, next) => {
  try {
    const inventory = await Inventory.findOne({
      productId: req.params.productId
    });

    if (!inventory) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Inventory not found for this product'
        }
      });
    }

    const productResult = await getProductsBulk([req.params.productId]);

    if (!productResult.success) {
      return res.status(productResult.status).json({
        success: false,
        error: {
          code: 'PRODUCT_SERVICE_ERROR',
          message: 'Unable to get product information'
        }
      });
    }

    const product = productResult.data.data[0];

    if (!product) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found'
        }
      });
    }

    res.json({
      success: true,
      product: {
        _id: product._id,
        name: product.name,
        price: product.price
      },
      inventory: {
        productId: inventory.productId,
        quantity: inventory.quantity
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/inventory/:productId/decrease — Atomic decrease inventory
router.patch('/:productId/decrease', validateDecreaseQuantity, async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { quantity } = req.body;

    const inventory = await Inventory.findOneAndUpdate(
      {
        productId,
        quantity: { $gte: quantity }
      },
      { $inc: { quantity: -quantity } },
      { new: true }
    );

    if (!inventory) {
      const existing = await Inventory.findOne({ productId });
      if (!existing) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Inventory not found'
          }
        });
      }

      return res.status(400).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_STOCK',
          message: 'Insufficient stock'
        }
      });
    }

    res.json({
      success: true,
      data: inventory
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/inventory/:productId — Update quantity 
router.patch('/:productId', validateQuantityUpdate, async (req, res, next) => {
  try {
    const inventory = await Inventory.findOneAndUpdate(
      { productId: req.params.productId },
      { $set: { quantity: req.body.quantity } },
      { new: true, runValidators: true }
    );

    if (!inventory) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Inventory not found for this product'
        }
      });
    }

    res.json({
      success: true,
      data: inventory
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
