const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const orderRoutes = require('./routes/orderRoutes');

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'order-service',
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/orders', orderRoutes);

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

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.url} not found`
    }
  });
});

// Connect DB then start server
const start = async () => {
  await connectDB();
  let stopWorker;
  if (process.env.ENABLE_ASYNC_ORDER === 'true') {
    const { startOrderEventsWorker } = require('./workers/orderEventsWorker');
    stopWorker = await startOrderEventsWorker();
  }
  const server = app.listen(PORT, () => {
    console.log(`Order Service running on port ${PORT}`);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    try {
      await new Promise((resolve) => server.close(resolve));
      if (stopWorker) await stopWorker();
      await require('mongoose').disconnect();
      clearTimeout(deadline);
    } catch (error) {
      console.error('Shutdown failed:', error.message);
      process.exit(1);
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
};

start().catch((error) => { console.error('Startup failed:', error.message); process.exit(1); });

module.exports = app;
