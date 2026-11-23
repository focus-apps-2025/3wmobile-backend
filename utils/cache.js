import NodeCache from 'node-cache';

// Initialize cache with standard TTL of 5 minutes (300 seconds)
// and check period of 600 seconds
export const appCache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

/**
 * Express middleware to cache responses.
 * Note: Only for GET requests where caching is acceptable.
 * @param {number} duration - Cache duration in seconds
 */
export const cacheMiddleware = (duration = 300) => {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const shouldBypass = req.query.forceNetwork === 'true' || req.query.bypassCache === 'true' || req.headers['cache-control'] === 'no-cache';

    // Generate unique key based on URL and user/tenant
    // We must isolate cache per tenant/user if applicable
    const userId = req.user ? (req.user._id || req.user.id) : 'guest';
    const tenantId = req.tenantFilter ? JSON.stringify(req.tenantFilter) : 'global';
    
    // Key format: url|userId|tenantId
    const key = `__express__${req.originalUrl || req.url}|${userId}|${tenantId}`;
    
    const cachedBody = appCache.get(key);
    
    if (!shouldBypass && cachedBody) {
      // Send cached response
      res.setHeader('X-Cache', 'HIT');
      return res.json(JSON.parse(cachedBody));
    } else {
      res.setHeader('X-Cache', 'MISS');
      // Override res.json to cache the response before sending
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Cache the stringified body
        appCache.set(key, JSON.stringify(body), duration);
        originalJson(body);
      };
      next();
    }
  };
};

export const clearFormCache = () => {
  try {
    const keys = appCache.keys();
    keys.forEach(key => {
      if (key.includes('form') || key.includes('__express__') || key.includes('analytics') || key.includes('response')) {
        appCache.del(key);
      }
    });
  } catch (err) {
    console.warn('Error clearing form cache:', err);
  }
};

export default appCache;
