const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGO_URI_INVENTORY;

  if (!uri) {
    throw new Error('MONGO_URI_INVENTORY is not defined in environment variables');
  }

  try {
    const conn = await mongoose.connect(uri);
    console.log(`MongoDB connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
