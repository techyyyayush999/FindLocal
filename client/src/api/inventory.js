import { apiFetch } from './http'

function paginationQuery({ page, limit } = {}) {
  const params = new URLSearchParams()
  if (page) params.set('page', String(page))
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  return query ? `?${query}` : ''
}

// GET /api/v1/inventory — seller's own inventory, paginated.
export function listInventory({ page, limit } = {}) {
  return apiFetch(`/api/v1/inventory${paginationQuery({ page, limit })}`)
}

// GET /api/v1/inventory/:id — one of the seller's own inventory entries.
export function getInventoryEntry(id) {
  return apiFetch(`/api/v1/inventory/${encodeURIComponent(id)}`)
}

// POST /api/v1/inventory — list a product in the seller's shop.
// Requires a verified shop and an ACTIVE product.
export function createInventory({ product, pricePaise, quantity, isActive }) {
  const payload = { product, pricePaise }
  if (quantity !== undefined) payload.quantity = quantity
  if (isActive !== undefined) payload.isActive = isActive
  return apiFetch('/api/v1/inventory', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// PATCH /api/v1/inventory/:id — update price and/or active status.
// A price change requires a verified shop; deactivation does not.
export function updateInventory(id, { pricePaise, isActive }) {
  const payload = {}
  if (pricePaise !== undefined) payload.pricePaise = pricePaise
  if (isActive !== undefined) payload.isActive = isActive
  return apiFetch(`/api/v1/inventory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

// PATCH /api/v1/inventory/:id/stock — atomic stock update.
// Supply exactly one of { quantity } (absolute) or { adjust } (relative).
export function updateInventoryStock(id, { quantity, adjust }) {
  const payload = {}
  if (quantity !== undefined) payload.quantity = quantity
  if (adjust !== undefined) payload.adjust = adjust
  return apiFetch(`/api/v1/inventory/${encodeURIComponent(id)}/stock`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}
