const { requestWithLoadBalancer } = require('./loadBalancer');

const PRODUCT_SERVICE_PORT = process.env.PRODUCT_SERVICE_PORT || 3001;

/**
 * Get product by ID from Product Service via Internal Load Balancer.
 * @param {string} productId - MongoDB ObjectId of the product
 * @returns {Promise<object>} { success, status, data }
 */
const getProductById = async (productId) => {
  return requestWithLoadBalancer(
    'order-service',
    'product-service',
    PRODUCT_SERVICE_PORT,
    `/api/products/${productId}`,
    { method: 'GET' }
  );
};

module.exports = { getProductById };
