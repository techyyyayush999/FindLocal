import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBanner } from '../../components/ErrorBanner'
import {
  cancelShopReservation,
  expireShopReservations,
  listShopReservations,
  pickupShopReservation,
} from '../../api/reservations'
import { isNoShopError } from '../../api/sellerShop'
import { Button } from '../../components/Button'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DashboardNav } from '../../components/DashboardNav'
import { EmptyState } from '../../components/EmptyState'
import { PageHeader } from '../../components/PageHeader'
import { Pager } from '../../components/Pager'
import { StatusChip } from '../../components/StatusChip'
import { formatDateTime, formatPaise, orDash } from '../../utils/format'
import { SELLER_NAV } from './sellerNav'

const PAGE_SIZE = 20

export function SellerReservationsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reservations, setReservations] = useState([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasShop, setHasShop] = useState(true)

  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')
  const [sweeping, setSweeping] = useState(false)

  const applyReservations = useCallback((body, fallbackPage) => {
    setReservations(body?.data?.reservations ?? [])
    setPage(body?.page ?? fallbackPage)
    setPages(body?.pages ?? 1)
    setTotal(body?.total ?? 0)
    setHasShop(true)
    setError(null)
  }, [])

  const load = useCallback(
    async (targetPage) => {
      try {
        const body = await listShopReservations({ page: targetPage, limit: PAGE_SIZE })
        applyReservations(body, targetPage)
      } catch (err) {
        // No shop yet is an onboarding state, not a load failure.
        if (isNoShopError(err)) setHasShop(false)
        else setError(err)
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
    listShopReservations({ page: 1, limit: PAGE_SIZE })
      .then((body) => {
        if (!cancelled) applyReservations(body, 1)
      })
      .catch((err) => {
        if (cancelled) return
        // No shop yet is an onboarding state, not a load failure.
        if (isNoShopError(err)) setHasShop(false)
        else setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyReservations])

  async function runAction(id, action, message) {
    setBusyId(id)
    setActionError(null)
    setNotice('')
    try {
      await action()
      setNotice(message)
      await load(page)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusyId('')
    }
  }

  async function handleExpire() {
    setSweeping(true)
    setActionError(null)
    setNotice('')
    try {
      const body = await expireShopReservations()
      setNotice(body?.message || 'Overdue holds released.')
      await load(page)
    } catch (err) {
      setActionError(err)
    } finally {
      setSweeping(false)
    }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Seller workspace" title="Reservations">
        <p>Review holds customers have placed on your stock and confirm pickups.</p>
      </PageHeader>

      <DashboardNav items={SELLER_NAV} />

      <div className="page-actions">
        <h2 className="panel__title">Customer holds</h2>
        {hasShop ? (
          <ConfirmButton
            variant="secondary"
            onConfirm={handleExpire}
            busy={sweeping}
            busyLabel="Releasing…"
            confirmLabel="Yes, release overdue holds"
          >
            Release overdue holds
          </ConfirmButton>
        ) : null}
      </div>

      {notice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__body">{notice}</p>
        </div>
      ) : null}

      {actionError ? (
        <ErrorBanner error={actionError} title="Could not update that reservation" />
      ) : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading reservations…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load reservations" /> : null}

      {!hasShop && !loading && !error ? (
        <EmptyState title="You have not created a shop yet">
          <>
            Reservations belong to a shop.{' '}
            <Link to="/seller/shop">Create your shop profile</Link> to start receiving customer
            holds.
          </>
        </EmptyState>
      ) : null}

      {!loading && !error && hasShop ? (
        reservations.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">Reservations for your shop</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Unit price</th>
                    <th scope="col">Status</th>
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
                    const customer =
                      reservation.customer && typeof reservation.customer === 'object'
                        ? reservation.customer
                        : null
                    const isActive = reservation.status === 'ACTIVE'
                    const isPending = reservation.status === 'PENDING'
                    const busy = busyId === id

                    return (
                      <tr key={id}>
                        <td>
                          <strong>{product?.name || 'Product'}</strong>
                          {product?.brand ? <div className="subtle">{product.brand}</div> : null}
                        </td>
                        <td>
                          {customer?.name || '—'}
                          {customer?.email ? <div className="subtle">{customer.email}</div> : null}
                        </td>
                        <td>{orDash(reservation.quantity)}</td>
                        <td>{formatPaise(reservation.pricePaise)}</td>
                        <td>
                          <StatusChip status={reservation.status} />
                        </td>
                        <td>{formatDateTime(reservation.expiresAt)}</td>
                        <td>
                          <div className="data-table__actions">
                            {isActive ? (
                              <Button
                                onClick={() =>
                                  runAction(id, () => pickupShopReservation(id), 'Marked as picked up.')
                                }
                                disabled={busy}
                              >
                                {busy ? 'Working…' : 'Mark picked up'}
                              </Button>
                            ) : null}
                            {isActive || isPending ? (
                              <ConfirmButton
                                onConfirm={() =>
                                  runAction(id, () => cancelShopReservation(id), 'Reservation cancelled.')
                                }
                                busy={busy}
                                busyLabel="Working…"
                                confirmLabel="Yes, cancel"
                                disabled={busy}
                              >
                                Cancel
                              </ConfirmButton>
                            ) : null}
                            {!isActive && !isPending ? (
                              <span className="subtle">No action needed</span>
                            ) : null}
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
            When a customer reserves one of your listings it will appear here.
          </EmptyState>
        )
      ) : null}
    </div>
  )
}
