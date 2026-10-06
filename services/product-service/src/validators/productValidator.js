const validateProduct = (req, res, next) => {
  const { name, price, quantity } = req.body;
  const errors = [];

  // name: required, non-empty string
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    errors.push('name is required and must be a non-empty string');
  }

  // price: required, number > 0
  if (price === undefined || price === null) {
    errors.push('price is required');
  } else if (typeof price !== 'number' || isNaN(price)) {
    errors.push('price must be a number');
  } else if (price <= 0) {
    errors.push('price must be greater than 0');
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
        message: 'Invalid product data',
        details: errors
      }
    });
  }

  // Sanitize: trim name
  req.body.name = name.trim();
  next();
};

module.exports = { validateProduct };
