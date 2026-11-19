// Display helpers shared by the seller and admin dashboards.

// Money is stored as an integer number of paise (1 rupee = 100 paise).
export function formatPaise(paise) {
  if (typeof paise !== 'number' || Number.isNaN(paise)) return '—'
  return `₹${(paise / 100).toFixed(2)}`
}

export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

// Short, human-scannable tail of a MongoDB ObjectId for dense tables.
export function shortId(value) {
  if (!value || typeof value !== 'string') return '—'
  return value.slice(-6)
}

// Renders a backend value only when it is actually present.
export function orDash(value) {
  if (value === null || value === undefined || value === '') return '—'
  return value
}
