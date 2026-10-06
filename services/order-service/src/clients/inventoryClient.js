const { requestWithLoadBalancer } = require('./loadBalancer');

const INVENTORY_SERVICE_PORT = process.env.INVENTORY_SERVICE_PORT || 3003;

/**
 * Get inventory by productId from Inventory Service via Internal Load Balancer.
 * @param {string} productId
 * @returns {Promise<object>} { success, status, data }
 */
const getInventoryByProductId = async (productId) => {
  return requestWithLoadBalancer(
    'order-service',
    'inventory-service',
    INVENTORY_SERVICE_PORT,
    `/api/inventory/${productId}`,
    { method: 'GET' }
  );
};

/**
 * Decrease inventory for a productId in Inventory Service via Internal Load Balancer.
 * Method is PATCH (mutation): Load Balancer executes exactly once without blind retries
 * to preserve atomic $gte and $inc inventory guarantees.
 * @param {string} productId
 * @param {number} quantity
 * @returns {Promise<object>} { success, status, data }
 */
const decreaseInventory = async (productId, quantity) => {
  return requestWithLoadBalancer(
    'order-service',
    'inventory-service',
    INVENTORY_SERVICE_PORT,
    `/api/inventory/${productId}/decrease`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ quantity })
    }
  );
};

module.exports = { getInventoryByProductId, decreaseInventory };
