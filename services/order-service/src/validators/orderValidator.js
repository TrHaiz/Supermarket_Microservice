const validateOrder = (req, res, next) => {
  const { items } = req.body;
  const errors = [];

  // items: required, non-empty array
  if (!items) {
    errors.push('items is required');
  } else if (!Array.isArray(items)) {
    errors.push('items must be an array');
  } else if (items.length === 0) {
    errors.push('items must have at least one item');
  } else {
    items.forEach((item, index) => {
      // productId: required, non-empty string
      if (!item.productId || typeof item.productId !== 'string' || item.productId.trim().length === 0) {
        errors.push(`items[${index}].productId is required and must be a non-empty string`);
      }

      // quantity: required, integer > 0
      if (item.quantity === undefined || item.quantity === null) {
        errors.push(`items[${index}].quantity is required`);
      } else if (typeof item.quantity !== 'number' || isNaN(item.quantity)) {
        errors.push(`items[${index}].quantity must be a number`);
      } else if (!Number.isInteger(item.quantity)) {
        errors.push(`items[${index}].quantity must be an integer`);
      } else if (item.quantity <= 0) {
        errors.push(`items[${index}].quantity must be greater than 0`);
      }

      // price: no longer validated here — fetched from Product Service
    });
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid order data',
        details: errors
      }
    });
  }

  next();
};

module.exports = { validateOrder };

