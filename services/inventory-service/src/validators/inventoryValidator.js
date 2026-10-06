const validateInventory = (req, res, next) => {
  const { productId, quantity } = req.body;
  const errors = [];

  // productId: required, non-empty string
  if (!productId || typeof productId !== 'string' || productId.trim().length === 0) {
    errors.push('productId is required and must be a non-empty string');
  }

  // quantity: required, integer >= 0
  if (quantity === undefined || quantity === null) {
    errors.push('quantity is required');
  } else if (typeof quantity !== 'number' || isNaN(quantity)) {
    errors.push('quantity must be a number');
  } else if (!Number.isInteger(quantity)) {
    errors.push('quantity must be an integer');
  } else if (quantity < 0) {
    errors.push('quantity must be >= 0');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid inventory data',
        details: errors
      }
    });
  }

  req.body.productId = productId.trim();
  next();
};

const validateQuantityUpdate = (req, res, next) => {
  const { quantity } = req.body;
  const errors = [];

  if (quantity === undefined || quantity === null) {
    errors.push('quantity is required');
  } else if (typeof quantity !== 'number' || isNaN(quantity)) {
    errors.push('quantity must be a number');
  } else if (!Number.isInteger(quantity)) {
    errors.push('quantity must be an integer');
  } else if (quantity < 0) {
    errors.push('quantity must be >= 0');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid inventory data',
        details: errors
      }
    });
  }

  next();
};

const validateDecreaseQuantity = (req, res, next) => {
  const { quantity } = req.body;
  const errors = [];

  if (quantity === undefined || quantity === null) {
    errors.push('quantity is required');
  } else if (typeof quantity !== 'number' || isNaN(quantity)) {
    errors.push('quantity must be a number');
  } else if (!Number.isInteger(quantity)) {
    errors.push('quantity must be an integer');
  } else if (quantity <= 0) {
    errors.push('quantity must be > 0');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid decrease quantity',
        details: errors
      }
    });
  }

  next();
};

module.exports = { validateInventory, validateQuantityUpdate, validateDecreaseQuantity };
