import { Button } from './Button'

// Compact pager for the paginated seller/admin listings.
export function Pager({ page, pages, total, onChange, busy = false }) {
  if (!pages || pages <= 1) return null

  return (
    <nav className="pager" aria-label="Pagination">
      <Button
        variant="secondary"
        disabled={busy || page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </Button>
      <p className="pager__status">
        Page {page} of {pages} · {total} total
      </p>
      <Button
        variant="secondary"
        disabled={busy || page >= pages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </Button>
    </nav>
  )
}
