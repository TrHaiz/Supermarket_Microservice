const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema(
  {
    productId: {
      type: String,
      required: true,
      unique: true
    },
    quantity: {
      type: Number,
      required: true,
      default: 0
    },
    orderReservations: {
      type: [{
        _id: false,
        eventId: { type: String, required: true },
        price: { type: Number, required: true },
        type: { type: String, enum: ['inventory_reserved', 'inventory_failed'], required: true },
        code: String,
        message: String
      }],
      select: false,
      default: undefined
    }
  },
  {
    timestamps: true
  }
);

inventorySchema.index({ 'orderReservations.eventId': 1 });

module.exports = mongoose.model('Inventory', inventorySchema);
