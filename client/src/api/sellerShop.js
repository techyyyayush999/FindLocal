import { apiFetch, isApiError } from './http'

// GET /api/v1/seller/shops/me — the authenticated seller's own shop.
// Resolves to 404 when the seller has not created a shop yet.
export function getMyShop() {
  return apiFetch('/api/v1/seller/shops/me')
}

// Both GET /seller/shops/me and the shop-scoped seller routes reply with
// HTTP 404 and a "do not have a shop" message when the seller has not created
// a shop yet. That is an onboarding state, not a failure — this predicate lets
// callers tell it apart from unrelated 404s (e.g. a missing resource), which
// must still surface as errors.
const NO_SHOP_MESSAGE = /do not have a shop/i

export function isNoShopError(error) {
  return (
    isApiError(error) && error.status === 404 && NO_SHOP_MESSAGE.test(error.message || '')
  )
}

// POST /api/v1/seller/shops — create the seller's shop (one per seller).
// longitude/latitude are flat numbers; the server builds the GeoJSON Point.
export function createShop({ name, description, address, phone, longitude, latitude, isOpen }) {
  return apiFetch('/api/v1/seller/shops', {
    method: 'POST',
    body: JSON.stringify({ name, description, address, phone, longitude, latitude, isOpen }),
  })
}

// PUT /api/v1/seller/shops/me — partial update of safe shop fields.
// longitude and latitude must be supplied together (or neither).
export function updateMyShop(payload) {
  return apiFetch('/api/v1/seller/shops/me', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}
