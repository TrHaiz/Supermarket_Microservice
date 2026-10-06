const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const os = require('os');
const authenticate = require('./middleware/authenticate');
const authorizeRoles = require('./middleware/authorize');
const { generalLimiter } = require('./middleware/rateLimiter');
const { getNextInstanceUrl } = require('./utils/loadBalancer');

const app = express();
const PORT = process.env.PORT || 3000;

// Service URLs
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3001';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3002';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3003';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3004';

// Trust proxy (Docker / reverse proxy)
app.set('trust proxy', 1);

// Debug header: identify gateway instance container
app.use((req, res, next) => {
  res.setHeader('X-Gateway-Instance', os.hostname());
  next();
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

// Gateway Health Check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'api-gateway',
    instance: os.hostname(),
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// General Rate Limiter - Apply to all subsequent routes
app.use(generalLimiter);

// Authorization: DELETE /api/products requires ADMIN role
// All other product methods allowed for any authenticated user (ADMIN + STAFF)
const authorizeProductAccess = (req, res, next) => {
  if (req.method === 'DELETE') {
    return authorizeRoles('ADMIN')(req, res, next);
  }
  next();
};

// Proxy: /api/products/* → Product Service (Load Balanced)
// All methods require authentication, DELETE requires ADMIN
app.use('/api/products', authenticate, authorizeProductAccess, createProxyMiddleware({
  target: PRODUCT_SERVICE_URL,
  router: async () => getNextInstanceUrl('product-service', 3001),
  changeOrigin: true,
  pathRewrite: (path) => `/api/products${path}`,
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Product Service is not available'
        }
      });
    }
  }
}));

// Authorization: PATCH /api/inventory requires ADMIN role
// GET and POST allowed for any authenticated user (ADMIN + STAFF)
const authorizeInventoryAccess = (req, res, next) => {
  if (req.method === 'PATCH') {
    return authorizeRoles('ADMIN')(req, res, next);
  }
  next();
};

// Proxy: /api/inventory/* → Inventory Service (Load Balanced)
// All methods require authentication, PATCH requires ADMIN
app.use('/api/inventory', authenticate, authorizeInventoryAccess, createProxyMiddleware({
  target: INVENTORY_SERVICE_URL,
  router: async () => getNextInstanceUrl('inventory-service', 3003),
  changeOrigin: true,
  pathRewrite: (path) => `/api/inventory${path}`,
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Inventory Service is not available'
        }
      });
    }
  }
}));

// Proxy: /api/orders/* → Order Service (Load Balanced)
// All methods require authentication + ADMIN or STAFF role
app.use('/api/orders', authenticate, authorizeRoles('ADMIN', 'STAFF'), createProxyMiddleware({
  target: ORDER_SERVICE_URL,
  router: async () => getNextInstanceUrl('order-service', 3004),
  changeOrigin: true,
  pathRewrite: (path) => `/api/orders${path}`,
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Order Service is not available'
        }
      });
    }
  }
}));

// Proxy: /api/auth/* → Auth Service
app.use('/api/auth', createProxyMiddleware({
  target: AUTH_SERVICE_URL,
  router: async () => getNextInstanceUrl('auth-service', 3002),
  changeOrigin: true,
  pathRewrite: (path) => `/api/auth${path}`,
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Auth Service is not available'
        }
      });
    }
  }
}));

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`
    }
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong'
    }
  });
});

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
  console.log(`Product Service URL: ${PRODUCT_SERVICE_URL}`);
  console.log(`Auth Service URL: ${AUTH_SERVICE_URL}`);
  console.log(`Inventory Service URL: ${INVENTORY_SERVICE_URL}`);
  console.log(`Order Service URL: ${ORDER_SERVICE_URL}`);
});

module.exports = app;
