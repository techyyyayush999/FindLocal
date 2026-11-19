import { apiFetch } from './http'

// Mirrors server/src/constants/productConstants.js — the backend validates
// against this exact list, so the client select offers the same values.
export const PRODUCT_CATEGORIES = [
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
]

export const PRODUCT_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED']

function buildQuery({ page, limit, status, category } = {}) {
  const params = new URLSearchParams()
  if (page) params.set('page', String(page))
  if (limit) params.set('limit', String(limit))
  if (status) params.set('status', status)
  if (category) params.set('category', category)
  const query = params.toString()
  return query ? `?${query}` : ''
}

// GET /api/v1/products/mine — the seller's own submitted products.
export function listMyProducts({ page, limit, status } = {}) {
  return apiFetch(`/api/v1/products/mine${buildQuery({ page, limit, status })}`)
}

// POST /api/v1/products — create a product (seller submissions start as PENDING).
export function createProduct({ name, brand, category, description, images, gtin }) {
  const payload = { name, brand, category }
  if (description !== undefined && description !== '') payload.description = description
  if (images !== undefined && images.length > 0) payload.images = images
  if (gtin !== undefined && gtin !== '') payload.gtin = gtin
  return apiFetch('/api/v1/products', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// PATCH /api/v1/products/:id — seller may edit own PENDING or REJECTED products.
export function updateProduct(id, payload) {
  return apiFetch(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

// GET /api/v1/products/admin — admin moderation listing (defaults to PENDING).
export function listAdminProducts({ page, limit, status, category } = {}) {
  return apiFetch(`/api/v1/products/admin${buildQuery({ page, limit, status, category })}`)
}

// PATCH /api/v1/products/:id/status — admin status transition.
// rejectionReason is required by the backend when status is REJECTED.
export function updateProductStatus(id, { status, rejectionReason }) {
  const payload = { status }
  if (rejectionReason !== undefined && rejectionReason !== '') {
    payload.rejectionReason = rejectionReason
  }
  return apiFetch(`/api/v1/products/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

// GET /api/v1/products/search — location-based search over ACTIVE products
// from verified shops. Contract mirrors product.validators.js#productSearchRules:
//   q (2–100, required), lat (−90..90, required), lng (−180..180, required),
//   radius (100–50000 m), sort ('distance' | 'price'),
//   brand, category, minPrice, maxPrice (paise), inStock ('true'/'false'),
//   openNow ('true'/'false'), page, limit (1–50).
// Only defined values are sent so the backend applies its own defaults.
export function searchProducts(params = {}) {
  const query = new URLSearchParams()
  const entries = [
    ['q', params.q],
    ['lat', params.lat],
    ['lng', params.lng],
    ['radius', params.radius],
    ['sort', params.sort],
    ['brand', params.brand],
    ['category', params.category],
    ['minPrice', params.minPrice],
    ['maxPrice', params.maxPrice],
    ['inStock', params.inStock],
    ['openNow', params.openNow],
    ['page', params.page],
    ['limit', params.limit],
  ]
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value))
    }
  }
  return apiFetch(`/api/v1/products/search?${query.toString()}`)
}
