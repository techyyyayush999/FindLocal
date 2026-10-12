// ─── Product Categories ───────────────────────────────────────────────────────
const PRODUCT_CATEGORIES = [
  'electronics',
  'mobiles-accessories',
  'computers',
  'stationery',
  'books',
  'groceries',
  'home-kitchen',
  'personal-care',
  'health',
  'tools-hardware',
  'toys-games',
  'other',
];

// ─── Product Statuses ─────────────────────────────────────────────────────────
const PRODUCT_STATUSES = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  REJECTED: 'REJECTED',
};

// ─── Valid GTIN lengths ───────────────────────────────────────────────────────
const VALID_GTIN_LENGTHS = [8, 12, 13, 14];

// ─── Allowed Status Transitions (admin only) ─────────────────────────────────
const ALLOWED_STATUS_TRANSITIONS = {
  [PRODUCT_STATUSES.PENDING]:  [PRODUCT_STATUSES.ACTIVE, PRODUCT_STATUSES.REJECTED],
  [PRODUCT_STATUSES.ACTIVE]:   [PRODUCT_STATUSES.INACTIVE],
  [PRODUCT_STATUSES.INACTIVE]: [PRODUCT_STATUSES.ACTIVE],
  [PRODUCT_STATUSES.REJECTED]: [PRODUCT_STATUSES.ACTIVE],
};

// ─── Fields the client is allowed to edit ─────────────────────────────────────
const PRODUCT_EDITABLE_FIELDS = ['name', 'brand', 'category', 'description', 'images', 'gtin'];

// ─── System-generated fields the client must never supply ─────────────────────
const PRODUCT_SYSTEM_FIELDS = [
  'slug', 'normalizedName', 'normalizedBrand', 'dedupeKey',
  'status', 'createdBy', 'reviewedBy', 'reviewedAt', 'rejectionReason',
];

// ─── Dedupe key separator ─────────────────────────────────────────────────────
const DEDUPE_SEPARATOR = '::';

// ─── Pagination defaults ─────────────────────────────────────────────────────
const PAGINATION_DEFAULTS = {
  PAGE: 1,
  LIMIT: 20,
  MAX_LIMIT: 50,
};

module.exports = {
  PRODUCT_CATEGORIES,
  PRODUCT_STATUSES,
  VALID_GTIN_LENGTHS,
  ALLOWED_STATUS_TRANSITIONS,
  PRODUCT_EDITABLE_FIELDS,
  PRODUCT_SYSTEM_FIELDS,
  DEDUPE_SEPARATOR,
  PAGINATION_DEFAULTS,
};
