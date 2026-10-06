const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema(
  {
    // ─── Ownership ───────────────────────────────────────────────────────────────
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Shop must have an owner'],
      unique: true, // One shop per seller — enforced at DB level
    },

    // ─── Basic Info ──────────────────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, 'Shop name is required'],
      trim: true,
      maxlength: [100, 'Shop name cannot exceed 100 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },

    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true,
      maxlength: [300, 'Address cannot exceed 300 characters'],
    },

    phone: {
      type: String,
      trim: true,
    },

    // ─── GeoJSON Location ────────────────────────────────────────────────────────
    // Stored as a GeoJSON Point: { type: "Point", coordinates: [lng, lat] }
    // The 2dsphere index below enables MongoDB $geoNear / $near queries.
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: [true, 'Location type is required'],
      },
      coordinates: {
        type: [Number],
        required: [true, 'Location coordinates are required'],
        validate: {
          validator: function (v) {
            return Array.isArray(v) && v.length === 2 &&
              v[0] >= -180 && v[0] <= 180 &&
              v[1] >= -90 && v[1] <= 90;
          },
          message: 'Coordinates must be [longitude, latitude] within valid ranges',
        },
      },
    },

    // ─── Status Flags ────────────────────────────────────────────────────────────
    isOpen: {
      type: Boolean,
      default: false,
    },

    // ─── Verification (set by admin only) ────────────────────────────────────────
    isVerified: {
      type: Boolean,
      default: false,
    },

    verifiedAt: {
      type: Date,
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// ─── 2dsphere Index ───────────────────────────────────────────────────────────
// Required for MongoDB geospatial queries ($geoNear, $near, $geoWithin).
shopSchema.index({ location: '2dsphere' });

const Shop = mongoose.model('Shop', shopSchema);

module.exports = Shop;
