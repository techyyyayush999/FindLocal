import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cancelMyReservation, listMyReservations } from '../api/reservations'
import { Button } from '../components/Button'
import { ConfirmButton } from '../components/ConfirmButton'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'
import { Pager } from '../components/Pager'
import { StatusChip } from '../components/StatusChip'
import { formatDateTime, formatPaise, orDash, shortId } from '../utils/format'

const PAGE_SIZE = 20

// A reservation is "open" (and therefore cancellable) while it is PENDING or
// ACTIVE. Terminal states (CANCELLED, EXPIRED, FULFILLED, REJECTED) offer no
// customer action.
const OPEN_STATUSES = ['PENDING', 'ACTIVE']

export function MyReservationsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reservations, setReservations] = useState([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)

  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')

  const applyReservations = useCallback((body, fallbackPage) => {
    setReservations(Array.isArray(body?.data?.reservations) ? body.data.reservations : [])
    setPage(body?.page ?? fallbackPage)
    setPages(body?.pages ?? 1)
    setTotal(body?.total ?? 0)
    setError(null)
  }, [])

  const load = useCallback(
    async (targetPage) => {
      try {
        const body = await listMyReservations({ page: targetPage, limit: PAGE_SIZE })
        applyReservations(body, targetPage)
      } catch (err) {
        setError(err)
      } finally {
        setLoading(false)
      }
    },
    [applyReservations]
  )

  const goToPage = useCallback(
    (targetPage) => {
      setLoading(true)
      load(targetPage)
    },
    [load]
  )

  // Initial load. State is applied in deferred callbacks, not synchronously.
  useEffect(() => {
    let cancelled = false
    listMyReservations({ page: 1, limit: PAGE_SIZE })
      .then((body) => {
        if (!cancelled) applyReservations(body, 1)
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyReservations])

  function retry() {
    setLoading(true)
    load(page)
  }

  async function handleCancel(id) {
    setBusyId(id)
    setActionError(null)
    setNotice('')
    try {
      await cancelMyReservation(id)
      setNotice('Reservation cancelled.')
      // Refresh the current page so the status reflects the cancellation.
      await load(page)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Your pickup holds" title="My reservations">
        <p>Reservations you have placed on shop stock, newest first.</p>
      </PageHeader>

      {notice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__body">{notice}</p>
        </div>
      ) : null}

      {actionError ? (
        <ErrorBanner error={actionError} title="Could not cancel that reservation" />
      ) : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading your reservations…
        </p>
      ) : null}

      {error ? (
        <div className="stack">
          <ErrorBanner error={error} title="Could not load your reservations" />
          <div className="actions">
            <Button variant="secondary" onClick={retry} disabled={loading}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {!loading && !error ? (
        reservations.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">Your reservations</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Shop</th>
                    <th scope="col">Reference</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reservations.map((reservation) => {
                    const id = reservation._id || reservation.id
                    const product =
                      reservation.product && typeof reservation.product === 'object'
                        ? reservation.product
                        : null
                    const shop =
                      reservation.shop && typeof reservation.shop === 'object'
                        ? reservation.shop
                        : null
                    const isOpen = OPEN_STATUSES.includes(reservation.status)
                    const busy = busyId === id

                    return (
                      <tr key={id}>
                        <td>
                          <strong>{product?.name || 'Product'}</strong>
                          {product?.brand ? <div className="subtle">{product.brand}</div> : null}
                          <div className="subtle">{formatPaise(reservation.pricePaise)} each</div>
                        </td>
                        <td>{shop?.name || '—'}</td>
                        <td>
                          <span title={id}>{shortId(id)}</span>
                        </td>
                        <td>{orDash(reservation.quantity)}</td>
                        <td>
                          <StatusChip status={reservation.status} />
                        </td>
                        <td>{formatDateTime(reservation.createdAt)}</td>
                        <td>{formatDateTime(reservation.expiresAt)}</td>
                        <td>
                          <div className="data-table__actions">
                            {isOpen ? (
                              <ConfirmButton
                                onConfirm={() => handleCancel(id)}
                                busy={busy}
                                busyLabel="Working…"
                                confirmLabel="Yes, cancel"
                                disabled={busy}
                              >
                                Cancel
                              </ConfirmButton>
                            ) : (
                              <span className="subtle">No action needed</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} total={total} onChange={goToPage} busy={loading} />
          </>
        ) : (
          <EmptyState title="No reservations yet">
            <>
              Browse products on the <Link to="/search">search page</Link> and reserve one for
              pickup. Your holds will appear here.
            </>
          </EmptyState>
        )
      ) : null}
    </div>
  )
}
