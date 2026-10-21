// ─── Inventory Numeric Bounds ─────────────────────────────────────────────────
const INVENTORY_BOUNDS = {
  PRICE_MIN: 1,
  PRICE_MAX: 100_000_000,
  QUANTITY_MIN: 0,
  QUANTITY_MAX: 1_000_000,
};

// ─── Fields the client is allowed to supply on create ─────────────────────────
const INVENTORY_CREATE_FIELDS = ['product', 'pricePaise', 'quantity', 'isActive'];

// ─── Fields the client is allowed to update via PATCH /:id ────────────────────
const INVENTORY_UPDATE_FIELDS = ['pricePaise', 'isActive'];

// ─── Fields the client is allowed to supply on stock update ───────────────────
const INVENTORY_STOCK_FIELDS = ['quantity', 'adjust'];

// ─── System-generated fields the client must never supply ─────────────────────
const INVENTORY_SYSTEM_FIELDS = [
  'shop', 'reservedQuantity', 'availableQuantity',
  'createdAt', 'updatedAt', '_id', '__v',
];

// ─── Pagination defaults (consistent with product catalog) ────────────────────
const PAGINATION_DEFAULTS = {
  PAGE: 1,
  LIMIT: 20,
  MAX_LIMIT: 50,
};

// ─── Product population fields for inventory responses ────────────────────────
const PRODUCT_POPULATE_SELECT = 'name brand slug category';

module.exports = {
  INVENTORY_BOUNDS,
  INVENTORY_CREATE_FIELDS,
  INVENTORY_UPDATE_FIELDS,
  INVENTORY_STOCK_FIELDS,
  INVENTORY_SYSTEM_FIELDS,
  PAGINATION_DEFAULTS,
  PRODUCT_POPULATE_SELECT,
};
