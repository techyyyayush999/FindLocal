import { apiFetch } from './http'

export function getVerifiedShops() {
  return apiFetch('/api/v1/shops')
}

export function getShopById(id) {
  return apiFetch(`/api/v1/shops/${encodeURIComponent(id)}`)
}

export function getNearbyShops({ lat, lng, radius }) {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
  })
  if (radius !== undefined && radius !== '') {
    params.set('radius', String(radius))
  }
  return apiFetch(`/api/v1/shops/nearby?${params.toString()}`)
}
