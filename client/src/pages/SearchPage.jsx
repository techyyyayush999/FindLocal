import { useState } from 'react'
import { Link } from 'react-router-dom'
import { fieldErrorMap } from '../api/http'
import { PRODUCT_CATEGORIES, searchProducts } from '../api/products'
import { createReservation } from '../api/reservations'
import { Button } from '../components/Button'
import { CheckboxField } from '../components/CheckboxField'
import { Chip } from '../components/Chip'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'
import { Pager } from '../components/Pager'
import { SelectField } from '../components/SelectField'
import { StatusChip } from '../components/StatusChip'
import { TextField } from '../components/TextField'
import { useAuth } from '../context/useAuth'
import { formatDateTime, formatPaise, shortId } from '../utils/format'

const PAGE_SIZE = 20

// Mirrors server/src/validators/product.validators.js#productSearchRules and
// server/src/constants/inventoryConstants.js — validated client-side so an
// invalid search never leaves the browser.
const QUERY_MIN = 2
const QUERY_MAX = 100
const RADIUS_MIN_KM = 0.1
const RADIUS_MAX_KM = 50
const BRAND_MAX = 80
const PRICE_MIN_PAISE = 1
const PRICE_MAX_PAISE = 100000000

// Reservation quantity bounds — mirrors the backend reservation validator
// (1–10 units per reservation). The per-result cap is tightened further to the
// result's current availableQuantity.
const RESERVE_MIN_QTY = 1
const RESERVE_MAX_QTY = 10

const SORT_OPTIONS = [
  { value: 'distance', label: 'Nearest first' },
  { value: 'price', label: 'Lowest price first' },
]

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

const EMPTY_FORM = {
  q: '',
  lat: '',
  lng: '',
  radiusKm: '5',
  category: '',
  brand: '',
  minRupees: '',
  maxRupees: '',
  inStock: false,
  openNow: false,
  sort: 'distance',
}

// Validate the form and build the query params for the search endpoint.
// Returns { errors } when the input is invalid, otherwise { params }.
function buildRequest(form, page) {
  const errors = {}

  const q = form.q.trim()
  if (q.length < QUERY_MIN) {
    errors.q = `Enter at least ${QUERY_MIN} characters.`
  } else if (q.length > QUERY_MAX) {
    errors.q = `Search text cannot exceed ${QUERY_MAX} characters.`
  }

  const latRaw = form.lat.trim()
  const lat = Number(latRaw)
  if (latRaw === '') {
    errors.lat = 'Latitude is required.'
  } else if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.lat = 'Must be between -90 and 90.'
  }

  const lngRaw = form.lng.trim()
  const lng = Number(lngRaw)
  if (lngRaw === '') {
    errors.lng = 'Longitude is required.'
  } else if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    errors.lng = 'Must be between -180 and 180.'
  }

  const radiusRaw = form.radiusKm.trim()
  let radius
  if (radiusRaw !== '') {
    const km = Number(radiusRaw)
    if (!Number.isFinite(km) || km < RADIUS_MIN_KM || km > RADIUS_MAX_KM) {
      errors.radiusKm = 'Must be between 0.1 and 50 km.'
    } else {
      radius = Math.round(km * 1000)
    }
  }

  const brand = form.brand.trim()
  if (brand.length > BRAND_MAX) {
    errors.brand = `Cannot exceed ${BRAND_MAX} characters.`
  }

  function parseRupees(raw, key) {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    const rupees = Number(trimmed)
    if (!Number.isFinite(rupees)) {
      errors[key] = 'Enter a valid amount.'
      return undefined
    }
    const paise = Math.round(rupees * 100)
    if (paise < PRICE_MIN_PAISE || paise > PRICE_MAX_PAISE) {
      errors[key] = 'Must be between ₹0.01 and ₹10,00,000.'
      return undefined
    }
    return paise
  }

  const minPrice = parseRupees(form.minRupees, 'minRupees')
  const maxPrice = parseRupees(form.maxRupees, 'maxRupees')
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    errors.maxRupees = 'Maximum price cannot be less than the minimum.'
  }

  if (Object.keys(errors).length > 0) return { errors }

  return {
    params: {
      q,
      lat,
      lng,
      radius,
      sort: form.sort,
      category: form.category || undefined,
      brand: brand || undefined,
      minPrice,
      maxPrice,
      inStock: form.inStock ? 'true' : undefined,
      openNow: form.openNow ? 'true' : undefined,
      page,
      limit: PAGE_SIZE,
    },
  }
}

// The largest whole quantity that may be reserved from a single result:
// the backend cap (10), never above the result's current availableQuantity.
function reserveMaxQuantity(item) {
  const available = item?.availableQuantity
  if (typeof available !== 'number' || Number.isNaN(available)) return RESERVE_MAX_QTY
  return Math.max(RESERVE_MIN_QTY, Math.min(RESERVE_MAX_QTY, Math.floor(available)))
}

function SearchResultCard({ item, onReserve, children }) {
  const product = item?.product || {}
  const shop = item?.shop || {}
  const open = shop.isOpen === true

  const hasPrice = typeof item?.pricePaise === 'number'
  const hasQuantity = typeof item?.availableQuantity === 'number'
  const outOfStock = hasQuantity && item.availableQuantity <= 0
  const stockLabel =
    typeof item?.stockStatus === 'string'
      ? item.stockStatus
      : hasQuantity
        ? outOfStock
          ? 'Out of stock'
          : 'In stock'
        : null

  const distanceText =
    typeof item?.distanceKm === 'number'
      ? `${item.distanceKm.toFixed(1)} km`
      : typeof item?.distanceMeters === 'number'
        ? `${Math.round(item.distanceMeters)} m`
        : null

  // Reservation is only offered when the result carries the real Inventory
  // document id (never the product or shop id).
  const inventoryId = item?.inventory?._id
  const hasInventoryId = typeof inventoryId === 'string' && inventoryId.length > 0
  const reservable = hasInventoryId && !outOfStock

  return (
    <article className="shop-card">
      <div className="shop-card__top">
        <h2 className="shop-card__name">{product.name || 'Unnamed product'}</h2>
        <Chip tone={open ? 'open' : 'closed'}>{open ? 'Open' : 'Closed'}</Chip>
      </div>
      {product.brand ? <p className="shop-card__desc">{product.brand}</p> : null}
      {shop._id ? (
        <p className="shop-card__address">
          Sold by <Link to={`/shops/${shop._id}`}>{shop.name || 'this shop'}</Link>
        </p>
      ) : null}
      {shop.address ? <p className="shop-card__address">{shop.address}</p> : null}
      <div className="shop-card__meta">
        {hasPrice ? <span>{formatPaise(item.pricePaise)}</span> : null}
        {distanceText ? <span>{distanceText}</span> : null}
        {stockLabel ? (
          <Chip tone={outOfStock ? 'inactive' : 'active'}>{stockLabel}</Chip>
        ) : null}
        {hasQuantity && !outOfStock ? <span>{item.availableQuantity} available</span> : null}
        {product.category ? <span>{categoryLabel(product.category)}</span> : null}
      </div>
      {hasInventoryId && !children && onReserve ? (
        <div className="shop-card__actions">
          <Button
            variant="secondary"
            className="shop-card__reserve"
            onClick={() => onReserve?.(item)}
            disabled={!reservable}
          >
            {reservable ? 'Reserve' : 'Unavailable'}
          </Button>
        </div>
      ) : null}
      {children}
    </article>
  )
}

function ReservePanel({
  item,
  quantity,
  onQuantityChange,
  maxQuantity,
  quantityError,
  error,
  submitting,
  onCancel,
  onSubmit,
}) {
  const product = item?.product || {}
  const shop = item?.shop || {}
  const unitPrice = typeof item?.pricePaise === 'number' ? item.pricePaise : null
  const qtyNumber = Number(quantity)
  const totalPaise =
    unitPrice !== null && Number.isInteger(qtyNumber) ? unitPrice * qtyNumber : null

  return (
    <div className="reserve-panel" role="group" aria-label="Reserve this product for pickup">
      <p className="reserve-panel__title">Reserve for pickup</p>
      <dl className="facts reserve-panel__facts">
        <dt>Product</dt>
        <dd>{product.name || 'Unnamed product'}</dd>
        <dt>Shop</dt>
        <dd>{shop.name || 'This shop'}</dd>
        <dt>Unit price</dt>
        <dd>{unitPrice !== null ? formatPaise(unitPrice) : '—'}</dd>
      </dl>
      <TextField
        id={`reserve-qty-${item?.inventory?._id || 'item'}`}
        label="Quantity"
        type="number"
        value={quantity}
        onChange={(event) => onQuantityChange(event.target.value)}
        min={RESERVE_MIN_QTY}
        max={maxQuantity}
        step="1"
        inputMode="numeric"
        error={quantityError}
        hint={`Whole number from ${RESERVE_MIN_QTY} to ${maxQuantity}.`}
        autoComplete="off"
      />
      <p className="reserve-panel__total">
        Total: <strong>{totalPaise !== null ? formatPaise(totalPaise) : '—'}</strong>
      </p>
      {error ? <ErrorBanner error={error} title="Could not create the reservation" /> : null}
      <div className="actions">
        <Button onClick={onSubmit} disabled={submitting}>
          {submitting ? 'Reserving…' : 'Confirm reservation'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function LocationPinIcon() {
  return (
    <svg
      className="search-location__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  )
}

export function SearchPage() {
  const { user } = useAuth()
  const [form, setForm] = useState(EMPTY_FORM)
  const [results, setResults] = useState([])
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 })
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [geoLoading, setGeoLoading] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [geoNote, setGeoNote] = useState(null)
  const [lastParams, setLastParams] = useState(null)
  // Validation feedback stays hidden until the first submit so a fresh page
  // load never renders invalid borders or error messages.
  const [submitted, setSubmitted] = useState(false)

  // Reservation (customer) state — a single inline panel is open at a time,
  // keyed by the result's real inventory id.
  const [reserveTarget, setReserveTarget] = useState(null)
  const [reserveQty, setReserveQty] = useState('1')
  const [reserveQtyError, setReserveQtyError] = useState(null)
  const [reserveError, setReserveError] = useState(null)
  const [reserving, setReserving] = useState(false)
  const [reserveNotice, setReserveNotice] = useState(null)

  // Reserving is a customer-only capability: the backend restricts
  // POST /api/v1/reservations to the customer role, so sellers and admins must
  // not be offered the action (they would otherwise receive a 403).
  const canReserve = user?.role === 'customer'

  const hasFieldErrors = Object.keys(fieldErrors).length > 0

  function fieldError(key) {
    return submitted ? fieldErrors[key] : undefined
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
    // Clear a field's error as soon as the user edits it again.
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  async function runSearch(params) {
    setLoading(true)
    setError(null)
    setFieldErrors({})
    setSearched(true)
    setLastParams(params)
    // A new result set invalidates any open reserve panel (and its errors).
    setReserveTarget(null)
    setReserveQty('1')
    setReserveQtyError(null)
    setReserveError(null)
    try {
      const body = await searchProducts(params)
      setResults(Array.isArray(body?.data?.results) ? body.data.results : [])
      setMeta({
        page: body?.page ?? params.page ?? 1,
        pages: body?.pages ?? 1,
        total: body?.total ?? 0,
      })
    } catch (err) {
      setResults([])
      setError(err)
      setFieldErrors(fieldErrorMap(err))
    } finally {
      setLoading(false)
    }
  }

  function submit(nextForm, page) {
    setSubmitted(true)
    const { errors, params } = buildRequest(nextForm, page)
    if (errors) {
      setResults([])
      setSearched(true)
      setError(null)
      setFieldErrors(errors)
      return
    }
    runSearch(params)
  }

  function handleSubmit(event) {
    event.preventDefault()
    submit(form, 1)
  }

  function retry() {
    if (lastParams) runSearch(lastParams)
  }

  function goToPage(target) {
    if (lastParams) runSearch({ ...lastParams, page: target })
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setGeoNote('This browser does not provide location services. Enter coordinates instead.')
      return
    }
    setGeoLoading(true)
    setGeoNote(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextForm = {
          ...form,
          lat: String(position.coords.latitude),
          lng: String(position.coords.longitude),
        }
        setForm(nextForm)
        setGeoLoading(false)
        submit(nextForm, 1)
      },
      (geoError) => {
        setGeoLoading(false)
        const code = geoError && geoError.code
        if (code === 1) {
          setGeoNote(
            'Location access was denied. Allow location access in your browser, or enter the coordinates manually.'
          )
        } else if (code === 2) {
          setGeoNote('Your location could not be determined. Enter the coordinates manually.')
        } else if (code === 3) {
          setGeoNote(
            'Getting your location took too long. Try again or enter the coordinates manually.'
          )
        } else {
          setGeoNote('Your location is unavailable. Enter the coordinates manually.')
        }
      },
      { enableHighAccuracy: false, timeout: 10000 }
    )
  }

  function openReserve(item) {
    setReserveTarget(item)
    setReserveQty('1')
    setReserveQtyError(null)
    setReserveError(null)
  }

  function closeReserve() {
    setReserveTarget(null)
    setReserveQty('1')
    setReserveQtyError(null)
    setReserveError(null)
  }

  function updateReserveQty(value) {
    setReserveQty(value)
    setReserveQtyError(null)
  }

  async function submitReserve() {
    const item = reserveTarget
    const inventoryId = item?.inventory?._id
    if (typeof inventoryId !== 'string' || inventoryId === '') return

    const maxQuantity = reserveMaxQuantity(item)
    const quantity = Number(reserveQty)
    if (
      !Number.isInteger(quantity) ||
      quantity < RESERVE_MIN_QTY ||
      quantity > maxQuantity
    ) {
      setReserveQtyError(`Enter a whole number between ${RESERVE_MIN_QTY} and ${maxQuantity}.`)
      return
    }

    setReserving(true)
    setReserveError(null)
    setReserveQtyError(null)
    try {
      // Body is exactly { inventory, quantity }; the customer comes from the
      // HttpOnly-cookie session, and `inventory` is the real Inventory _id.
      const body = await createReservation({ inventory: inventoryId, quantity })
      setReserveNotice(body?.data?.reservation ?? null)
      setReserveTarget(null)
      setReserveQty('1')
      // Refresh with the existing search state so availability is up to date.
      if (lastParams) await runSearch(lastParams)
    } catch (err) {
      setReserveError(err)
    } finally {
      setReserving(false)
    }
  }

  if (!user) {
    return (
      <div className="page">
        <PageHeader eyebrow="Product search" title="Search products nearby">
          <p>
            Search runs against prices and stock from verified shops around a
            point. It uses your signed-in session, so a login is required.
          </p>
        </PageHeader>
        <div className="banner banner--info" role="status">
          <p className="banner__title">Log in to search</p>
          <p className="banner__body">
            Product search is available to signed-in customers.{' '}
            <Link to="/login">Log in</Link> and come back to search.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Product search" title="Find a product nearby">
        <p>
          Results come only from verified shops within the radius, using real
          prices and stock from the live search endpoint.
        </p>
      </PageHeader>

      <form className="panel stack search-form" onSubmit={handleSubmit} noValidate>
        <TextField
          id="search-q"
          label="Search products"
          value={form.q}
          onChange={(event) => updateField('q', event.target.value)}
          required
          error={fieldError('q')}
          hint="Matches the product name. At least 2 characters."
          autoComplete="off"
        />

        <div className="search-location" role="group" aria-label="Location">
          <div className="search-location__head">
            <p className="search-location__title">Location</p>
            <Button
              type="button"
              variant="secondary"
              className="search-location__btn"
              onClick={useMyLocation}
              disabled={geoLoading || loading}
            >
              <LocationPinIcon />
              {geoLoading ? 'Reading location…' : 'Use current location'}
            </Button>
          </div>
          <div className="form-grid form-grid--coords">
            <TextField
              id="search-lat"
              label="Latitude"
              value={form.lat}
              onChange={(event) => updateField('lat', event.target.value)}
              required
              inputMode="decimal"
              error={fieldError('lat')}
              autoComplete="off"
            />
            <TextField
              id="search-lng"
              label="Longitude"
              value={form.lng}
              onChange={(event) => updateField('lng', event.target.value)}
              required
              inputMode="decimal"
              error={fieldError('lng')}
              autoComplete="off"
            />
            <TextField
              id="search-radius"
              label="Radius (km)"
              value={form.radiusKm}
              onChange={(event) => updateField('radiusKm', event.target.value)}
              inputMode="decimal"
              min="0.1"
              max="50"
              step="0.1"
              error={fieldError('radiusKm')}
              hint="Optional. 0.1–50 km. Default is 5 km."
              autoComplete="off"
            />
          </div>
          {geoNote ? (
            <p className="note" role="status">
              {geoNote}
            </p>
          ) : null}
        </div>

        <div className="form-grid search-form__filters">
          <SelectField
            id="search-category"
            label="Category"
            value={form.category}
            onChange={(event) => updateField('category', event.target.value)}
            options={CATEGORY_OPTIONS}
            placeholder="All categories"
          />
          <TextField
            id="search-brand"
            label="Brand"
            value={form.brand}
            onChange={(event) => updateField('brand', event.target.value)}
            error={fieldError('brand')}
            hint="Optional. Case-insensitive match."
            autoComplete="off"
          />
          <TextField
            id="search-min"
            label="Min price (₹)"
            value={form.minRupees}
            onChange={(event) => updateField('minRupees', event.target.value)}
            inputMode="decimal"
            error={fieldError('minRupees')}
            hint="Optional."
            autoComplete="off"
          />
          <TextField
            id="search-max"
            label="Max price (₹)"
            value={form.maxRupees}
            onChange={(event) => updateField('maxRupees', event.target.value)}
            inputMode="decimal"
            error={fieldError('maxRupees')}
            hint="Optional."
            autoComplete="off"
          />
          <SelectField
            id="search-sort"
            label="Sort by"
            value={form.sort}
            onChange={(event) => updateField('sort', event.target.value)}
            options={SORT_OPTIONS}
          />
        </div>

        <div className="search-checks">
          <CheckboxField
            id="search-instock"
            label="In stock only"
            checked={form.inStock}
            onChange={(value) => updateField('inStock', value)}
          />
          <CheckboxField
            id="search-opennow"
            label="Open now only"
            checked={form.openNow}
            onChange={(value) => updateField('openNow', value)}
          />
        </div>

        <div className="actions">
          <Button type="submit" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </Button>
        </div>
      </form>

      {reserveNotice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__title">Reservation confirmed</p>
          <p className="banner__body">
            {reserveNotice.quantity} × {reserveNotice.product?.name || 'product'} reserved
            {reserveNotice.shop?.name ? ` from ${reserveNotice.shop.name}` : ''} for{' '}
            {formatPaise(reserveNotice.pricePaise)} each — total{' '}
            {formatPaise(reserveNotice.pricePaise * reserveNotice.quantity)}. Pick up by{' '}
            {formatDateTime(reserveNotice.expiresAt)}.
          </p>
          <p className="reserve-notice__meta">
            Reference {shortId(reserveNotice._id)} <StatusChip status={reserveNotice.status} />
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="stack">
          <ErrorBanner error={error} title="Product search failed" />
          {lastParams ? (
            <div className="actions">
              <Button variant="secondary" onClick={retry} disabled={loading}>
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Searching products…
        </p>
      ) : null}

      {!loading && !error && searched && !hasFieldErrors && results.length === 0 ? (
        <EmptyState title="No products matched">
          Only active products from verified shops within the radius are returned.
          Try a wider radius or different filters.
        </EmptyState>
      ) : null}

      {!loading && !error && results.length > 0 ? (
        <>
          <p className="subtle" role="status">
            {meta.total} matching product{meta.total === 1 ? '' : 's'}
          </p>
          <ul className="shop-grid">
            {results.map((item, index) => {
              const inventoryId = item?.inventory?._id
              const isReserveTarget =
                reserveTarget != null &&
                typeof inventoryId === 'string' &&
                inventoryId === reserveTarget.inventory?._id
              return (
                <li key={`${item?.shop?._id ?? 'shop'}:${item?.product?._id ?? index}`}>
                  <SearchResultCard item={item} onReserve={canReserve ? openReserve : undefined}>
                    {isReserveTarget ? (
                      <ReservePanel
                        item={item}
                        quantity={reserveQty}
                        onQuantityChange={updateReserveQty}
                        maxQuantity={reserveMaxQuantity(item)}
                        quantityError={reserveQtyError}
                        error={reserveError}
                        submitting={reserving}
                        onCancel={closeReserve}
                        onSubmit={submitReserve}
                      />
                    ) : null}
                  </SearchResultCard>
                </li>
              )
            })}
          </ul>
          <Pager
            page={meta.page}
            pages={meta.pages}
            total={meta.total}
            busy={loading}
            onChange={goToPage}
          />
        </>
      ) : null}
    </div>
  )
}
