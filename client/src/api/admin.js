import { apiFetch } from './http'

// GET /api/v1/admin/users — all users (password excluded by the model).
export function listUsers() {
  return apiFetch('/api/v1/admin/users')
}

// PATCH /api/v1/admin/users/:id/status — activate/deactivate a user.
// The backend rejects an admin changing their own active status (HTTP 400).
export function updateUserStatus(id, isActive) {
  return apiFetch(`/api/v1/admin/users/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  })
}

// GET /api/v1/admin/shops — all shops (verified and unverified).
export function listAdminShops() {
  return apiFetch('/api/v1/admin/shops')
}

// PATCH /api/v1/admin/shops/:id/verify — mark a shop as verified.
// There is no un-verify endpoint; verification is one-way.
export function verifyShop(id) {
  return apiFetch(`/api/v1/admin/shops/${encodeURIComponent(id)}/verify`, {
    method: 'PATCH',
  })
}
