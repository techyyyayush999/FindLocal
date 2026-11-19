import { apiFetch } from './http'

export function registerCustomer({ name, email, password }) {
  return apiFetch('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password, role: 'customer' }),
  })
}

export function login({ email, password }) {
  return apiFetch('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function logout() {
  return apiFetch('/api/v1/auth/logout', { method: 'POST' })
}

export function getMe() {
  return apiFetch('/api/v1/auth/me')
}
