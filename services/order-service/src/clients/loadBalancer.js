const dns = require('dns').promises;

const DISCOVERY_TTL_MS = parseInt(process.env.DISCOVERY_TTL_MS, 10) || 5000;

// In-memory cache for discovered service instances: { [serviceName]: { ips: string[], timestamp: number } }
const discoveryCache = {};

// Temporary unhealthy instances: Map<"ip:port", expirationTimestamp>
const unhealthyInstances = new Map();

// Independent Round Robin counter per logical service name
const roundRobinCounters = {};

/**
 * Discover IP addresses for a logical service name via Docker DNS with in-memory caching.
 * @param {string} serviceName - Logical Docker service name (e.g., 'product-service')
 * @param {boolean} forceRefresh - If true, bypass TTL cache
 * @returns {Promise<string[]>} Array of discovered IP addresses
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
      discoveryCache[serviceName] = {
        ips,
        timestamp: now
      };
      return ips;
    }
  } catch (error) {
    // If DNS query fails, fall back to stale cache if available
    if (cached && cached.ips.length > 0) {
      console.warn(`[DISCOVERY] DNS lookup for ${serviceName} failed, using stale cache: ${error.message}`);
      return cached.ips;
    }
    console.error(`[DISCOVERY] Failed to resolve ${serviceName}: ${error.message}`);
    return [];
  }

  return cached ? cached.ips : [];
};

/**
 * Manually force refresh the discovery cache for a service.
 * @param {string} serviceName
 * @returns {Promise<string[]>}
 */
const refreshServiceInstances = async (serviceName) => {
  return getServiceInstances(serviceName, true);
};

/**
 * Select the next healthy instance for a logical service using Round Robin.
 * Independent counter per logical service ensures fair distribution.
 * @param {string} serviceName - Logical service name (e.g. 'product-service')
 * @param {number|string} port - Service port (e.g. 3001)
 * @returns {Promise<{ ip: string, port: number|string, url: string }>} Selected instance object
 */
const getNextInstance = async (serviceName, port) => {
  let instances = await getServiceInstances(serviceName);

  if (!instances || instances.length === 0) {
    // Fallback: use logical service name directly if DNS returned nothing
    return {
      ip: serviceName,
      port,
      url: `http://${serviceName}:${port}`
    };
  }

  const now = Date.now();

  // Filter out temporarily unhealthy instances
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

  // If all instances were marked unhealthy, fallback to all instances
  if (healthyInstances.length === 0) {
    healthyInstances = instances;
  }

  // Consistent sorting ensures deterministic round-robin across instances
  healthyInstances.sort();

  if (roundRobinCounters[serviceName] === undefined) {
    roundRobinCounters[serviceName] = 0;
  }

  const index = roundRobinCounters[serviceName] % healthyInstances.length;
  roundRobinCounters[serviceName] = (roundRobinCounters[serviceName] + 1) % 1000000;

  const selectedIp = healthyInstances[index];

  return {
    ip: selectedIp,
    port,
    url: `http://${selectedIp}:${port}`
  };
};

/**
 * Execute HTTP request to target service using Load Balancer.
 * @param {string} callerName - Name of calling service (e.g. 'order-service')
 * @param {string} serviceName - Logical target service name (e.g. 'product-service')
 * @param {number|string} port - Service port (e.g. 3001)
 * @param {string} path - URL path (e.g. '/api/products/123')
 * @param {object} options - Fetch options (method, headers, body)
 * @param {number} timeoutMs - Timeout in ms (default 3000)
 * @param {number} retryCount - Max retries for idempotent requests (default 1)
 * @returns {Promise<{ success: boolean, status: number, data: any }>}
 */
const requestWithLoadBalancer = async (
  callerName,
  serviceName,
  port,
  path,
  options = {},
  timeoutMs = 3000,
  retryCount = 1
) => {
  const method = (options.method || 'GET').toUpperCase();
  const isIdempotent = method === 'GET';

  let attempts = 0;
  const maxAttempts = isIdempotent ? 1 + retryCount : 1; // Strict: No retry for mutations

  while (attempts < maxAttempts) {
    attempts++;
    const instance = await getNextInstance(serviceName, port);
    const url = `${instance.url}${path}`;
    const startTime = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      const duration = Date.now() - startTime;
      console.log(`[LB] ${callerName} -> ${serviceName} -> ${instance.ip}:${port} [${method} ${path}] status=${response.status} duration=${duration}ms`);

      return {
        success: response.ok,
        status: response.status,
        data: body
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const isTimeout = error.name === 'AbortError';

      console.error(`[LB_FAIL] ${callerName} -> ${serviceName} -> ${instance.ip}:${port} [${method} ${path}] error=${error.message} duration=${duration}ms`);

      // Mark this specific instance temporarily unhealthy for 10s
      unhealthyInstances.set(`${instance.ip}:${port}`, Date.now() + 10000);

      // Force refresh discovery cache to detect topology changes
      refreshServiceInstances(serviceName).catch(() => {});

      if (attempts >= maxAttempts) {
        if (isTimeout) {
          return {
            success: false,
            status: 504,
            data: { message: `${serviceName} timeout` }
          };
        }
        return {
          success: false,
          status: 503,
          data: { message: `${serviceName} unavailable` }
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }
};

module.exports = {
  getServiceInstances,
  refreshServiceInstances,
  getNextInstance,
  requestWithLoadBalancer,
  unhealthyInstances,
  DISCOVERY_TTL_MS
};
