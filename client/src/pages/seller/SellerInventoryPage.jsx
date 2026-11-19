import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fieldErrorMap } from '../../api/http'
import { createInventory, listInventory } from '../../api/inventory'
import { listMyProducts } from '../../api/products'
import { getMyShop, isNoShopError } from '../../api/sellerShop'
import { Button } from '../../components/Button'
import { CheckboxField } from '../../components/CheckboxField'
import { DashboardNav } from '../../components/DashboardNav'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { Pager } from '../../components/Pager'
import { SelectField } from '../../components/SelectField'
import { TextField } from '../../components/TextField'
import { InventoryRow } from './InventoryRow'
import { SELLER_NAV } from './sellerNav'

const PAGE_SIZE = 20
const PRICE_MIN_PAISE = 1
const PRICE_MAX_PAISE = 100000000
const QUANTITY_MAX = 1000000

const EMPTY_FORM = { product: '', priceRupees: '', quantity: '0', isActive: true }

export function SellerInventoryPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [entries, setEntries] = useState([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)

  const [shop, setShop] = useState(null)
  const [hasShop, setHasShop] = useState(true)
  const [activeProducts, setActiveProducts] = useState([])

  const [notice, setNotice] = useState('')

  const [form, setForm] = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)
  const [createFieldErrors, setCreateFieldErrors] = useState({})

  const applyInventory = useCallback((body, fallbackPage) => {
    setEntries(body?.data?.inventory ?? [])
    setPage(body?.page ?? fallbackPage)
    setPages(body?.pages ?? 1)
    setTotal(body?.total ?? 0)
    setError(null)
  }, [])

  const loadInventory = useCallback(
    async (targetPage) => {
      try {
        const body = await listInventory({ page: targetPage, limit: PAGE_SIZE })
        applyInventory(body, targetPage)
      } catch (err) {
        // No shop yet is an onboarding state, not a load failure.
        if (isNoShopError(err)) setHasShop(false)
        else setError(err)
      } finally {
        setLoading(false)
      }
    },
    [applyInventory]
  )

  const goToPage = useCallback(
    (targetPage) => {
      setLoading(true)
      loadInventory(targetPage)
    },
    [loadInventory]
  )

  // Initial load. All state updates happen in deferred promise callbacks.
  useEffect(() => {
    let cancelled = false

    listInventory({ page: 1, limit: PAGE_SIZE })
      .then((body) => {
        if (!cancelled) applyInventory(body, 1)
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

    getMyShop()
      .then((body) => {
        if (cancelled) return
        setShop(body?.data?.shop ?? null)
        setHasShop(true)
      })
      .catch((err) => {
        if (cancelled) return
        if (isNoShopError(err)) {
          setShop(null)
          setHasShop(false)
        } else {
          setError(err)
        }
      })

    listMyProducts({ status: 'ACTIVE', limit: 50 })
      .then((body) => {
        if (!cancelled) setActiveProducts(body?.data?.products ?? [])
      })
      .catch(() => {
        // Non-fatal: the create form simply offers nothing until products load.
        if (!cancelled) setActiveProducts([])
      })

    return () => {
      cancelled = true
    }
  }, [applyInventory])

  const verified = shop?.isVerified === true

  function handleUpdated(updated, message) {
    if (updated) {
      const id = updated._id || updated.id
      setEntries((prev) => prev.map((entry) => ((entry._id || entry.id) === id ? updated : entry)))
    }
    setNotice(message || 'Inventory updated.')
  }

  async function handleCreate(event) {
    event.preventDefault()
    setCreateError(null)
    setCreateFieldErrors({})
    setNotice('')

    const errors = {}
    if (!form.product) errors.product = 'Choose a product to list.'
    const rupees = Number(form.priceRupees)
    if (form.priceRupees.trim() === '' || Number.isNaN(rupees) || rupees <= 0) {
      errors.priceRupees = 'Enter a price greater than zero.'
    }
    const quantity = Number(form.quantity)
    if (
      form.quantity.trim() !== '' &&
      (!Number.isInteger(quantity) || quantity < 0 || quantity > QUANTITY_MAX)
    ) {
      errors.quantity = 'Quantity must be a whole number between 0 and 1,000,000.'
    }
    if (Object.keys(errors).length > 0) {
      setCreateFieldErrors(errors)
      return
    }

    const pricePaise = Math.round(rupees * 100)
    if (pricePaise < PRICE_MIN_PAISE || pricePaise > PRICE_MAX_PAISE) {
      setCreateFieldErrors({ priceRupees: 'Price must be between ₹0.01 and ₹1,000,000.' })
      return
    }

    const payload = { product: form.product, pricePaise, isActive: form.isActive }
    if (form.quantity.trim() !== '') payload.quantity = quantity

    setCreating(true)
    try {
      await createInventory(payload)
      setForm(EMPTY_FORM)
      setNotice('Product listed in inventory.')
      await loadInventory(1)
    } catch (err) {
      setCreateError(err)
      setCreateFieldErrors(fieldErrorMap(err))
    } finally {
      setCreating(false)
    }
  }

  const canEditPriceStock = verified

  return (
    <div className="page">
      <PageHeader eyebrow="Seller workspace" title="Inventory">
        <p>List approved products, track held stock and keep prices current.</p>
      </PageHeader>

      <DashboardNav items={SELLER_NAV} />

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading your inventory…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load your inventory" /> : null}

      {!hasShop && !loading && !error ? (
        <EmptyState title="You have not created a shop yet">
          <>
            Inventory belongs to a shop.{' '}
            <Link to="/seller/shop">Create your shop profile</Link> to list products.
          </>
        </EmptyState>
      ) : null}

      {hasShop && shop && !verified && !loading ? (
        <div className="banner banner--info" role="status">
          <p className="banner__title">Shop not verified</p>
          <p className="banner__body">
            An admin must verify your shop before you can add products to inventory, change
            prices or update stock. You can still deactivate listings that already exist.
          </p>
        </div>
      ) : null}

      {hasShop && verified && activeProducts.length === 0 && !loading ? (
        <div className="banner banner--info" role="status">
          <p className="banner__title">No approved products yet</p>
          <p className="banner__body">
            Add products to inventory only after an admin approves them.{' '}
            <Link to="/seller/products">Submit a product</Link> and wait for approval.
          </p>
        </div>
      ) : null}

      {hasShop && verified && activeProducts.length > 0 ? (
        <section className="panel panel--muted">
          <h2 className="panel__title">Add a product to inventory</h2>
          {createError ? (
            <ErrorBanner error={createError} title="Could not add that product" />
          ) : null}
          <form onSubmit={handleCreate}>
            <div className="stack">
              <fieldset className="form-grid" disabled={creating}>
                <SelectField
                  id="inv-product"
                  label="Approved product"
                  value={form.product}
                  onChange={(event) => setForm((prev) => ({ ...prev, product: event.target.value }))}
                  options={activeProducts.map((product) => ({
                    value: product._id,
                    label: `${product.name} — ${product.brand}`,
                  }))}
                  placeholder="Select a product"
                  required
                  error={createFieldErrors.product}
                />
                <TextField
                  id="inv-price"
                  label="Price (₹)"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.priceRupees}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, priceRupees: event.target.value }))
                  }
                  required
                  error={createFieldErrors.priceRupees}
                />
                <TextField
                  id="inv-quantity"
                  label="Opening stock"
                  type="number"
                  step="1"
                  min="0"
                  value={form.quantity}
                  onChange={(event) => setForm((prev) => ({ ...prev, quantity: event.target.value }))}
                  hint="Optional. Whole units available to reserve."
                  error={createFieldErrors.quantity}
                />
              </fieldset>

              <CheckboxField
                id="inv-active"
                label="List as active"
                checked={form.isActive}
                onChange={(checked) => setForm((prev) => ({ ...prev, isActive: checked }))}
                hint="Inactive listings stay hidden from customers until you activate them."
              />

              <div className="actions">
                <Button type="submit" disabled={creating}>
                  {creating ? 'Adding…' : 'Add to inventory'}
                </Button>
              </div>
            </div>
          </form>
        </section>
      ) : null}

      {notice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__body">{notice}</p>
        </div>
      ) : null}

      {!loading && !error && hasShop ? (
        entries.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">Your inventory</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Price</th>
                    <th scope="col">Stock</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Available</th>
                    <th scope="col">Listing</th>
                    <th scope="col">Manage</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <InventoryRow
                      key={`${entry._id || entry.id}:${entry.updatedAt ?? ''}`}
                      entry={entry}
                      canEditPriceStock={canEditPriceStock}
                      onUpdated={handleUpdated}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} total={total} onChange={goToPage} busy={loading} />
          </>
        ) : (
          <EmptyState title="No inventory yet">
            {verified
              ? 'Add an approved product above to start selling.'
              : 'Once your shop is verified you can add approved products here.'}
          </EmptyState>
        )
      ) : null}
    </div>
  )
}
