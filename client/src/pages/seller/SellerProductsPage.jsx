import { useCallback, useEffect, useState } from 'react'
import { fieldErrorMap } from '../../api/http'
import { PRODUCT_CATEGORIES, createProduct, listMyProducts, updateProduct } from '../../api/products'
import { Button } from '../../components/Button'
import { DashboardNav } from '../../components/DashboardNav'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { Pager } from '../../components/Pager'
import { SelectField } from '../../components/SelectField'
import { StatusChip } from '../../components/StatusChip'
import { TextAreaField } from '../../components/TextAreaField'
import { TextField } from '../../components/TextField'
import { formatDateTime } from '../../utils/format'
import { SELLER_NAV } from './sellerNav'

const PAGE_SIZE = 20
const MAX_IMAGES = 5

function categoryLabel(value) {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const CATEGORY_OPTIONS = PRODUCT_CATEGORIES.map((value) => ({
  value,
  label: categoryLabel(value),
}))

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'REJECTED', label: 'Rejected' },
]

const EMPTY_FORM = { name: '', brand: '', category: '', description: '', images: '', gtin: '' }

function productToForm(product) {
  return {
    name: product.name ?? '',
    brand: product.brand ?? '',
    category: product.category ?? '',
    description: product.description ?? '',
    images: Array.isArray(product.images) ? product.images.join('\n') : '',
    gtin: product.gtin ?? '',
  }
}

function parseImages(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function SellerProductsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [products, setProducts] = useState([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')

  const [form, setForm] = useState(EMPTY_FORM)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState('')

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
        const body = await listMyProducts({
          page: targetPage,
          limit: PAGE_SIZE,
          status: status || undefined,
        })
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

  // Initial load. State is applied in deferred callbacks, not synchronously.
  useEffect(() => {
    let cancelled = false
    listMyProducts({ page: 1, limit: PAGE_SIZE })
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

  function update(field) {
    return (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  function startEdit(product) {
    setEditingId(product._id || product.id)
    setForm(productToForm(product))
    setSaveError(null)
    setFieldErrors({})
    setNotice('')
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setSaveError(null)
    setFieldErrors({})
  }

  function changeStatus(event) {
    const next = event.target.value
    setStatusFilter(next)
    setLoading(true)
    load(1, next)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaveError(null)
    setFieldErrors({})
    setNotice('')

    const errors = {}
    if (!form.name.trim()) errors.name = 'Product name is required.'
    if (!form.brand.trim()) errors.brand = 'Brand is required.'
    if (!form.category) errors.category = 'Choose a category.'

    const images = parseImages(form.images)
    if (images.length > MAX_IMAGES) {
      errors.images = `At most ${MAX_IMAGES} images are allowed.`
    } else if (images.some((url) => !/^https:\/\/.+/.test(url))) {
      errors.images = 'Each image must be a full HTTPS URL.'
    }

    const gtin = form.gtin.trim()
    if (gtin && (!/^\d+$/.test(gtin) || ![8, 12, 13, 14].includes(gtin.length))) {
      errors.gtin = 'GTIN must be 8, 12, 13 or 14 digits.'
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }

    const editing = Boolean(editingId)
    // PATCH treats an empty string / empty array as the documented way to clear
    // an optional field (product.controller.js maps gtin '' to undefined and
    // assigns description/images directly). Optional fields are therefore always
    // sent; createProduct() drops the empty values itself for POST.
    const payload = {
      name: form.name.trim(),
      brand: form.brand.trim(),
      category: form.category,
      description: form.description.trim(),
      images,
      gtin,
    }

    setSaving(true)
    try {
      if (editing) {
        await updateProduct(editingId, payload)
        setNotice('Product updated. It will be re-reviewed by an admin.')
        setEditingId(null)
        setForm(EMPTY_FORM)
        await load(page, statusFilter)
      } else {
        await createProduct(payload)
        setNotice('Product submitted. An admin must approve it before it reaches inventory.')
        setForm(EMPTY_FORM)
        await load(1, statusFilter)
      }
    } catch (err) {
      setSaveError(err)
      setFieldErrors(fieldErrorMap(err))
    } finally {
      setSaving(false)
    }
  }

  const editing = Boolean(editingId)

  return (
    <div className="page">
      <PageHeader eyebrow="Seller workspace" title="Products">
        <p>Submit new products for approval and fix up anything an admin sends back.</p>
      </PageHeader>

      <DashboardNav items={SELLER_NAV} />

      <div className="banner banner--info" role="status">
        <p className="banner__title">How approval works</p>
        <p className="banner__body">
          New products are submitted as <strong>Pending</strong>. Once an admin approves them they
          become <strong>Active</strong> and can be added to inventory. If a product is rejected,
          edit and resubmit it — saving a rejected product returns it to Pending.
        </p>
      </div>

      <section className="panel panel--muted">
        <h2 className="panel__title">{editing ? 'Edit product' : 'Submit a new product'}</h2>

        {notice ? (
          <div className="banner banner--success" role="status">
            <p className="banner__body">{notice}</p>
          </div>
        ) : null}
        {saveError ? <ErrorBanner error={saveError} title="Could not save this product" /> : null}

        <form onSubmit={handleSubmit}>
          <div className="stack">
            <fieldset className="form-grid" disabled={saving}>
              <TextField
                id="product-name"
                label="Product name"
                value={form.name}
                onChange={update('name')}
                required
                error={fieldErrors.name}
              />
              <TextField
                id="product-brand"
                label="Brand"
                value={form.brand}
                onChange={update('brand')}
                required
                error={fieldErrors.brand}
              />
              <SelectField
                id="product-category"
                label="Category"
                value={form.category}
                onChange={update('category')}
                options={CATEGORY_OPTIONS}
                placeholder="Select a category"
                required
                error={fieldErrors.category}
              />
              <TextField
                id="product-gtin"
                label="GTIN"
                value={form.gtin}
                onChange={update('gtin')}
                inputMode="numeric"
                error={fieldErrors.gtin}
                hint={
                  editing
                    ? 'Optional. 8, 12, 13 or 14 digits. Leave empty to remove it.'
                    : 'Optional. 8, 12, 13 or 14 digits.'
                }
              />
            </fieldset>

            <TextAreaField
              id="product-description"
              label="Description"
              value={form.description}
              onChange={update('description')}
              error={fieldErrors.description}
              rows={4}
              maxLength={2000}
              hint={
                editing
                  ? 'Optional. Up to 2000 characters. Leave empty to remove it.'
                  : 'Optional. Up to 2000 characters.'
              }
            />

            <TextAreaField
              id="product-images"
              label="Image URLs"
              value={form.images}
              onChange={update('images')}
              error={fieldErrors.images}
              rows={3}
              hint={
                editing
                  ? 'Optional. Up to 5 HTTPS URLs, one per line. Remove all lines to clear them.'
                  : 'Optional. Up to 5 HTTPS URLs, one per line.'
              }
            />

            <div className="actions">
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save and resubmit' : 'Submit product'}
              </Button>
              {editing ? (
                <Button type="button" variant="secondary" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        </form>
      </section>

      <div className="page-actions">
        <h2 className="panel__title">Your submissions</h2>
        <SelectField
          id="product-status-filter"
          label="Filter by status"
          value={statusFilter}
          onChange={changeStatus}
          options={STATUS_FILTERS}
        />
      </div>

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading your products…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load your products" /> : null}

      {!loading && !error ? (
        products.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">Products you have submitted</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Category</th>
                    <th scope="col">Status</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => {
                    const id = product._id || product.id
                    const editable = product.status === 'PENDING' || product.status === 'REJECTED'
                    return (
                      <tr key={id}>
                        <td>
                          <strong>{product.name}</strong>
                          {product.brand ? <div className="subtle">{product.brand}</div> : null}
                          {product.status === 'REJECTED' && product.rejectionReason ? (
                            <p className="subtle" role="note">
                              Rejected: {product.rejectionReason}
                            </p>
                          ) : null}
                        </td>
                        <td>{categoryLabel(product.category || '') || '—'}</td>
                        <td>
                          <StatusChip status={product.status} />
                        </td>
                        <td>{formatDateTime(product.createdAt)}</td>
                        <td>
                          {editable ? (
                            <Button variant="secondary" onClick={() => startEdit(product)}>
                              Edit
                            </Button>
                          ) : (
                            <span className="subtle">Locked after approval</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              page={page}
              pages={pages}
              total={total}
              busy={loading}
              onChange={goToPage}
            />
          </>
        ) : (
          <EmptyState title="No products here yet">
            {statusFilter
              ? 'No products match this status. Try another filter.'
              : 'Submit your first product using the form above.'}
          </EmptyState>
        )
      ) : null}
    </div>
  )
}
