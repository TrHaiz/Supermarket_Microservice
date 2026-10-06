/**
 * Role Authorization Middleware for API Gateway.
 *
 * Factory function that returns middleware checking if the
 * authenticated user's role is in the allowed list.
 *
 * Must run AFTER authenticate middleware (requires req.user).
 *
 * @param  {...string} allowedRoles - Roles permitted (e.g. 'ADMIN', 'STAFF')
 * @returns {Function} Express middleware
 */
const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'NO_TOKEN',
          message: 'Authentication required'
        }
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action'
        }
      });
    }

    next();
  };
};

module.exports = authorizeRoles;
