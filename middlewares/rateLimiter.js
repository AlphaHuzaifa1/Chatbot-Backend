/**
 * Rate Limiting Middleware
 * Simple in-memory rate limiter for chat endpoints
 * For production, consider using Redis-based rate limiting
 */

const rateLimitStore = new Map();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (data.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Rate limiter middleware
 * @param {Object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds (default: 1 minute)
 * @param {number} options.maxRequests - Maximum requests per window (default: 10)
 */
export const rateLimiter = (options = {}) => {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute
  const maxRequests = options.maxRequests || 10;

  return (req, res, next) => {
    // Get identifier (IP address or session ID)
    const identifier = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    
    const now = Date.now();
    const key = `ratelimit:${identifier}`;
    
    let rateLimitData = rateLimitStore.get(key);
    
    // Initialize or reset if window expired
    if (!rateLimitData || rateLimitData.resetTime < now) {
      rateLimitData = {
        count: 0,
        resetTime: now + windowMs
      };
      rateLimitStore.set(key, rateLimitData);
    }
    
    // Increment count
    rateLimitData.count++;
    
    // Check if limit exceeded
    if (rateLimitData.count > maxRequests) {
      const retryAfter = Math.ceil((rateLimitData.resetTime - now) / 1000);
      
      return res.status(429).json({
        success: false,
        error: 'Too many requests',
        message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
        retryAfter
      });
    }
    
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - rateLimitData.count));
    res.setHeader('X-RateLimit-Reset', new Date(rateLimitData.resetTime).toISOString());
    
    next();
  };
};

/**
 * Socket rate limiter
 * Rate limits socket messages per session
 */
export const socketRateLimiter = (windowMs = 60 * 1000, maxMessages = 20) => {
  const socketLimits = new Map();
  
  // Cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of socketLimits.entries()) {
      if (data.resetTime < now) {
        socketLimits.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  
  return (socket, next) => {
    const sessionId = socket.sessionId || socket.handshake.auth.sessionId;
    if (!sessionId) {
      return next();
    }
    
    const now = Date.now();
    const key = `socket:${sessionId}`;
    
    let limitData = socketLimits.get(key);
    
    if (!limitData || limitData.resetTime < now) {
      limitData = {
        count: 0,
        resetTime: now + windowMs
      };
      socketLimits.set(key, limitData);
    }
    
    limitData.count++;
    
    if (limitData.count > maxMessages) {
      socket.emit('error', {
        message: 'Rate limit exceeded. Please slow down.',
        code: 'RATE_LIMIT'
      });
      return;
    }
    
    // Store limit data on socket for access in handlers
    socket.rateLimitData = limitData;
    
    next();
  };
};

export default {
  rateLimiter,
  socketRateLimiter
};

