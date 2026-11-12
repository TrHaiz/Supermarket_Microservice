const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: String,
      required: true
    },
    quantity: {
      type: Number,
      required: true
    },
    price: {
      type: Number,
      required: true
    },
    subtotal: {
      type: Number,
      required: true
    }
  },
  { _id: false }
);

const failedItemSchema = new mongoose.Schema(
  {
    productId: {
      type: String,
      required: true
    },
    quantity: {
      type: Number,
      required: true
    },
    error: {
      code: {
        type: String,
        required: true
      },
      message: {
        type: String,
        required: true
      }
    }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderCode: {
      type: String,
      required: true,
      unique: true
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: function (v) {
          return Array.isArray(v) && (v.length > 0 || this.status === 'FAILED');
        },
        message: 'Order must have at least one item'
      }
    },
    failedItems: {
      type: [failedItemSchema],
      default: []
    },
    total: {
      type: Number,
      required: true
    },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'COMPLETED', 'PARTIAL', 'FAILED'],
      default: 'PENDING'
    },
    asyncOrder: {
      type: new mongoose.Schema({
        published: { type: Boolean, default: false },
        userId: { type: String, default: '' },
        requestedItems: [orderItemSchema],
        results: [mongoose.Schema.Types.Mixed]
      }, { _id: false }),
      default: undefined,
      select: false
    }
  },
  {
    timestamps: true,
    toJSON: { transform(doc, ret) { delete ret.asyncOrder; return ret; } }
  }
);

orderSchema.index({ 'asyncOrder.published': 1 }, {
  partialFilterExpression: { 'asyncOrder.published': false }
});
orderSchema.index({ status: 1 });
orderSchema.index({ _id: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
