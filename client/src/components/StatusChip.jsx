import { Chip } from './Chip'

// Maps the backend's status enums onto the design system's chip tones so the
// same state reads identically across every dashboard.
const TONES = {
  PENDING: { tone: 'pending', label: 'Pending' },
  ACTIVE: { tone: 'active', label: 'Active' },
  INACTIVE: { tone: 'inactive', label: 'Inactive' },
  REJECTED: { tone: 'rejected', label: 'Rejected' },
  CANCELLED: { tone: 'inactive', label: 'Cancelled' },
  EXPIRED: { tone: 'inactive', label: 'Expired' },
  FULFILLED: { tone: 'active', label: 'Fulfilled' },
  VERIFIED: { tone: 'active', label: 'Verified' },
  UNVERIFIED: { tone: 'pending', label: 'Unverified' },
  OPEN: { tone: 'active', label: 'Open' },
  CLOSED: { tone: 'inactive', label: 'Closed' },
}

export function StatusChip({ status, label }) {
  const key = String(status || '').toUpperCase()
  const entry = TONES[key] || { tone: 'neutral', label: status || 'Unknown' }
  return <Chip tone={entry.tone}>{label || entry.label}</Chip>
}
