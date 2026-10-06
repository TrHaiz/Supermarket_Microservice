const { rateLimit } = require('express-rate-limit');

/**
 * General Rate Limiter for API Gateway
 *
 * Limits request rate based on client IP.
 * Values configurable via environment variables with safe defaults.
 * Uses standard RateLimit-* headers and adheres to API Gateway error format.
 */
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000, // Default: 1 minute
  limit: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100, // Default: 100 requests per minute
  standardHeaders: 'draft-7', // Returns RateLimit-* headers (draft-7 standard)
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests'
      }
    });
  }
});

module.exports = {
  generalLimiter
};
