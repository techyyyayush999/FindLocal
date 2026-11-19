import { useCallback, useEffect, useState } from 'react'
import { listAdminProducts, updateProductStatus } from '../../api/products'
import { Button } from '../../components/Button'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DashboardNav } from '../../components/DashboardNav'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { Pager } from '../../components/Pager'
import { SelectField } from '../../components/SelectField'
import { StatusChip } from '../../components/StatusChip'
import { TextAreaField } from '../../components/TextAreaField'
import { formatDateTime } from '../../utils/format'
import { ADMIN_NAV } from './adminNav'

const PAGE_SIZE = 20

const STATUS_FILTERS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'REJECTED', label: 'Rejected' },
]

function categoryLabel(value) {
  if (!value) return '—'
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function AdminProductsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [products, setProducts] = useState([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState('PENDING')

  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')

  const [rejectingId, setRejectingId] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [rejectError, setRejectError] = useState('')

  const applyProducts = useCallback((body, fallbackPage) => {
    setProducts(body?.data?.products ?? [])
    setPage(body?.page ?? fallbackPage)
    setPages(body?.pages ?? 1)
    setTotal(body?.total ?? 0)
    setError(null)
  }, [])

  const load = useCallback(
    async (targetPage, status) => {
      try {
        const body = await listAdminProducts({ page: targetPage, limit: PAGE_SIZE, status })
        applyProducts(body, targetPage)
      } catch (err) {
        setError(err)
      } finally {
        setLoading(false)
      }
    },
    [applyProducts]
  )

  const goToPage = useCallback(
    (targetPage) => {
      setLoading(true)
      load(targetPage, statusFilter)
    },
    [load, statusFilter]
  )

  // Initial load defaults to PENDING. State is applied in deferred callbacks.
  useEffect(() => {
    let cancelled = false
    listAdminProducts({ page: 1, limit: PAGE_SIZE, status: 'PENDING' })
      .then((body) => {
        if (!cancelled) applyProducts(body, 1)
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
  }, [applyProducts])

  function changeStatusFilter(event) {
    const next = event.target.value
    setStatusFilter(next)
    setLoading(true)
    load(1, next)
  }

  async function changeStatus(product, status, successMessage) {
    const id = product._id || product.id
    setBusyId(id)
    setActionError(null)
    setNotice('')
    try {
      await updateProductStatus(id, { status })
      setNotice(successMessage)
      await load(page, statusFilter)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusyId('')
    }
  }

  function startReject(product) {
    setRejectingId(product._id || product.id)
    setRejectReason('')
    setRejectError('')
    setActionError(null)
    setNotice('')
  }

  function cancelReject() {
    setRejectingId('')
    setRejectReason('')
    setRejectError('')
  }

  async function submitReject(product) {
    const reason = rejectReason.trim()
    if (!reason) {
      setRejectError('A reason is required when rejecting a product.')
      return
    }
    const id = product._id || product.id
    setBusyId(id)
    setActionError(null)
    try {
      await updateProductStatus(id, { status: 'REJECTED', rejectionReason: reason })
      setNotice('Product rejected. The seller can edit and resubmit it.')
      cancelReject()
      await load(page, statusFilter)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Admin console" title="Product moderation">
        <p>Approve submissions so sellers can list them in inventory, or send them back with a reason.</p>
      </PageHeader>

      <DashboardNav items={ADMIN_NAV} />

      <div className="page-actions">
        <h2 className="panel__title">Submissions</h2>
        <SelectField
          id="admin-product-status"
          label="Filter by status"
          value={statusFilter}
          onChange={changeStatusFilter}
          options={STATUS_FILTERS}
        />
      </div>

      {notice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__body">{notice}</p>
        </div>
      ) : null}

      {actionError ? (
        <ErrorBanner error={actionError} title="Could not update that product" />
      ) : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading products…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load products" /> : null}

      {!loading && !error ? (
        products.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">Product submissions awaiting moderation</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Category</th>
                    <th scope="col">Seller</th>
                    <th scope="col">Status</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => {
                    const id = product._id || product.id
                    const seller =
                      product.createdBy && typeof product.createdBy === 'object'
                        ? product.createdBy
                        : null
                    const busy = busyId === id
                    const canApprove = product.status !== 'ACTIVE'
                    const canReject = product.status === 'PENDING'
                    const canDeactivate = product.status === 'ACTIVE'

                    return (
                      <tr key={id}>
                        <td>
                          <strong>{product.name}</strong>
                          {product.brand ? <div className="subtle">{product.brand}</div> : null}
                          {product.status === 'REJECTED' && product.rejectionReason ? (
                            <p className="subtle" role="note">
                              Reason: {product.rejectionReason}
                            </p>
                          ) : null}
                        </td>
                        <td>{categoryLabel(product.category)}</td>
                        <td>
                          {seller?.name || '—'}
                          {seller?.email ? <div className="subtle">{seller.email}</div> : null}
                        </td>
                        <td>
                          <StatusChip status={product.status} />
                        </td>
                        <td>{formatDateTime(product.createdAt)}</td>
                        <td>
                          {rejectingId === id ? (
                            <div className="stack--tight">
                              <TextAreaField
                                id={`reject-reason-${id}`}
                                label="Rejection reason"
                                value={rejectReason}
                                onChange={(event) => setRejectReason(event.target.value)}
                                error={rejectError}
                                rows={2}
                                maxLength={300}
                              />
                              <div className="data-table__actions">
                                <Button onClick={() => submitReject(product)} disabled={busy}>
                                  {busy ? 'Rejecting…' : 'Confirm rejection'}
                                </Button>
                                <Button variant="secondary" onClick={cancelReject} disabled={busy}>
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="data-table__actions">
                              {canApprove ? (
                                <ConfirmButton
                                  variant="primary"
                                  onConfirm={() =>
                                    changeStatus(product, 'ACTIVE', 'Product approved.')
                                  }
                                  busy={busy}
                                  busyLabel="Working…"
                                  confirmLabel="Yes, approve"
                                >
                                  Approve
                                </ConfirmButton>
                              ) : null}
                              {canReject ? (
                                <Button variant="secondary" onClick={() => startReject(product)} disabled={busy}>
                                  Reject
                                </Button>
                              ) : null}
                              {canDeactivate ? (
                                <ConfirmButton
                                  onConfirm={() =>
                                    changeStatus(product, 'INACTIVE', 'Product deactivated.')
                                  }
                                  busy={busy}
                                  busyLabel="Working…"
                                  confirmLabel="Yes, deactivate"
                                >
                                  Deactivate
                                </ConfirmButton>
                              ) : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} total={total} busy={loading} onChange={goToPage} />
          </>
        ) : (
          <EmptyState title="Nothing to review here">
            No products currently match this status.
          </EmptyState>
        )
      ) : null}
    </div>
  )
}
