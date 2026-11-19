import { apiFetch } from './http'

function paginationQuery({ page, limit } = {}) {
  const params = new URLSearchParams()
  if (page) params.set('page', String(page))
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  return query ? `?${query}` : ''
}

// GET /api/v1/reservations/shop — reservations for the seller's own shop.
export function listShopReservations({ page, limit } = {}) {
  return apiFetch(`/api/v1/reservations/shop${paginationQuery({ page, limit })}`)
}

// PATCH /api/v1/reservations/shop/:id/cancel — seller cancels their own
// shop's reservation. No request body is required.
export function cancelShopReservation(id) {
  return apiFetch(`/api/v1/reservations/shop/${encodeURIComponent(id)}/cancel`, {
    method: 'PATCH',
  })
}

// PATCH /api/v1/reservations/shop/:id/pickup — seller fulfils an ACTIVE,
// unexpired reservation. No request body is required.
export function pickupShopReservation(id) {
  return apiFetch(`/api/v1/reservations/shop/${encodeURIComponent(id)}/pickup`, {
    method: 'PATCH',
  })
}

// POST /api/v1/reservations/shop/expire — explicit expiry sweep for the
// seller's own shop. Releases overdue holds and moves them to EXPIRED.
// Idempotent; only run on explicit user action.
export function expireShopReservations() {
  return apiFetch('/api/v1/reservations/shop/expire', { method: 'POST' })
}

// ─── Customer reservations ───────────────────────────────────────────────────

// POST /api/v1/reservations — reserve stock from an inventory entry.
// The customer is derived server-side from the session, so the body contains
// exactly `{ inventory, quantity }`; `inventory` is the real Inventory
// document _id exposed as `result.inventory._id` by product search.
export function createReservation({ inventory, quantity }) {
  return apiFetch('/api/v1/reservations', {
    method: 'POST',
    body: JSON.stringify({ inventory, quantity }),
  })
}

// GET /api/v1/reservations/mine — the authenticated customer's own
// reservations, newest first, with pagination.
export function listMyReservations({ page, limit } = {}) {
  return apiFetch(`/api/v1/reservations/mine${paginationQuery({ page, limit })}`)
}

// GET /api/v1/reservations/mine/:id — a single reservation owned by the
// authenticated customer.
export function getMyReservation(id) {
  return apiFetch(`/api/v1/reservations/mine/${encodeURIComponent(id)}`)
}

// PATCH /api/v1/reservations/mine/:id/cancel — customer cancels their own
// reservation. No request body is required.
export function cancelMyReservation(id) {
  return apiFetch(`/api/v1/reservations/mine/${encodeURIComponent(id)}/cancel`, {
    method: 'PATCH',
  })
}
