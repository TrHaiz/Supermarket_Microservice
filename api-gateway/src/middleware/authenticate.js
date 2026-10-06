const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'supermarket-secret-key-change-in-production';

/**
 * JWT Authentication Middleware for API Gateway.
 *
 * Verifies the Bearer token from the Authorization header.
 * On success: attaches decoded payload to req.user and sets
 *   X-User-Id and X-User-Role headers for downstream services.
 * On failure: returns 401 Unauthorized.
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'NO_TOKEN',
        message: 'Access token is required'
      }
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // Forward user info to downstream services via headers
    req.headers['x-user-id'] = decoded.id;
    req.headers['x-user-role'] = decoded.role;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'TOKEN_EXPIRED',
          message: 'Token has expired'
        }
      });
    }

    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or malformed token'
      }
    });
  }
};

module.exports = authenticate;
