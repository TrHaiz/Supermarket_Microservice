const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEFAULT_TTL = parseInt(process.env.REDIS_PRODUCT_TTL, 10) || 60;

// Khởi tạo Redis client
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false, // Tránh treo request khi Redis down
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  }
});

redis.on('connect', () => {
  console.log('Redis connected successfully');
});

redis.on('error', (err) => {
  console.error('[REDIS ERROR]:', err.message);
});

/**
 * Lấy dữ liệu từ cache
 * @param {string} key
 * @returns {Promise<object|null>}
 */
const getCache = async (key) => {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error(`[REDIS ERROR] getCache(${key}):`, err.message);
    return null;
  }
};

/**
 * Lưu dữ liệu vào cache kèm TTL
 * @param {string} key
 * @param {object} value
 * @param {number} ttlSeconds
 */
const setCache = async (key, value, ttlSeconds = DEFAULT_TTL) => {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    console.log(`[CACHE SET] key: ${key}, TTL: ${ttlSeconds}s`);
  } catch (err) {
    console.error(`[REDIS ERROR] setCache(${key}):`, err.message);
  }
};

/**
 * Xóa cache key
 * @param {string} key
 */
const delCache = async (key) => {
  try {
    await redis.del(key);
    console.log(`[CACHE DELETE] key: ${key}`);
  } catch (err) {
    console.error(`[REDIS ERROR] delCache(${key}):`, err.message);
  }
};

module.exports = {
  redis,
  getCache,
  setCache,
  delCache
};
