const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: {
    type: String,
    required: true
  },
  seq: {
    type: Number,
    default: 0
  }
});

/**
 * Atomically increment and return the next sequence value.
 * @param {string} name - Counter identifier (e.g. 'order-20260925')
 * @returns {Promise<number>} Next sequence number
 */
counterSchema.statics.getNextSeq = async function (name) {
  const counter = await this.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
