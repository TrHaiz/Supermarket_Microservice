const dns = require('dns').promises;

const DISCOVERY_TTL_MS = parseInt(process.env.DISCOVERY_TTL_MS, 10) || 5000;
const discoveryCache = {};
const roundRobinCounters = {};
const unhealthyInstances = new Map();

/**
 * Discover instances for a service via Docker DNS with in-memory caching.
 * @param {string} serviceName
 * @param {boolean} forceRefresh
 * @returns {Promise<string[]>}
 */
const getServiceInstances = async (serviceName, forceRefresh = false) => {
  const now = Date.now();
  const cached = discoveryCache[serviceName];

  if (!forceRefresh && cached && (now - cached.timestamp < DISCOVERY_TTL_MS)) {
    return cached.ips;
  }

  try {
    const ips = await dns.resolve4(serviceName);
    if (Array.isArray(ips) && ips.length > 0) {
      discoveryCache[serviceName] = { ips, timestamp: now };
      return ips;
    }
  } catch (error) {
    if (cached && cached.ips.length > 0) {
      return cached.ips;
    }
  }

  return cached ? cached.ips : [];
};

/**
 * Mark an instance temporarily unhealthy.
 * @param {string} ip
 * @param {number|string} port
 * @param {number} durationMs - Default: 10s
 */
const markInstanceUnhealthy = (ip, port, durationMs = 10000) => {
  unhealthyInstances.set(`${ip}:${port}`, Date.now() + durationMs);
};

/**
 * Get next healthy instance URL using Round Robin with independent counter per service.
 * @param {string} serviceName - Logical service name
 * @param {number|string} port - Service port
 * @returns {Promise<string>} Selected instance URL
 */
const getNextInstanceUrl = async (serviceName, port) => {
  const instances = await getServiceInstances(serviceName);

  if (!instances || instances.length === 0) {
    return `http://${serviceName}:${port}`;
  }

  const now = Date.now();
  let healthyInstances = instances.filter(ip => {
    const key = `${ip}:${port}`;
    const unavailUntil = unhealthyInstances.get(key);
    if (unavailUntil && now < unavailUntil) {
      return false;
    }
    if (unavailUntil && now >= unavailUntil) {
      unhealthyInstances.delete(key);
    }
    return true;
  });

  if (healthyInstances.length === 0) {
    healthyInstances = instances;
  }

  healthyInstances.sort();

  if (roundRobinCounters[serviceName] === undefined) {
    roundRobinCounters[serviceName] = 0;
  }

  const index = roundRobinCounters[serviceName] % healthyInstances.length;
  roundRobinCounters[serviceName] = (roundRobinCounters[serviceName] + 1) % 1000000;

  const selectedIp = healthyInstances[index];
  console.log(`[LB] api-gateway -> ${serviceName} -> ${selectedIp}:${port}`);
  return `http://${selectedIp}:${port}`;
};

module.exports = {
  getServiceInstances,
  getNextInstanceUrl,
  markInstanceUnhealthy,
  unhealthyInstances
};
