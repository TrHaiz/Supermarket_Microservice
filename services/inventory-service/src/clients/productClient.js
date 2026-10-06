const { requestWithLoadBalancer } = require('./loadBalancer');

const PRODUCT_SERVICE_PORT = process.env.PRODUCT_SERVICE_PORT || 3001;

/**
 * Get product by ID from Product Service via Internal Load Balancer.
 * @param {string} productId - MongoDB ObjectId of the product
 * @returns {Promise<object>} { success, data, status }
 */
const getProductById = async (productId) => {
  return requestWithLoadBalancer(
    'inventory-service',
    'product-service',
    PRODUCT_SERVICE_PORT,
    `/api/products/${productId}`,
    { method: 'GET' }
  );
};

/**
 * Get multiple products by IDs from Product Service via Internal Load Balancer.
 * @param {string[]} productIds - Array of product ObjectIds
 * @returns {Promise<object>} { success, status, data }
 */
const getProductsBulk = async (productIds) => {
  return requestWithLoadBalancer(
    'inventory-service',
    'product-service',
    PRODUCT_SERVICE_PORT,
    '/api/products/bulk',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ids: productIds })
    }
  );
};

module.exports = { getProductById, getProductsBulk };
