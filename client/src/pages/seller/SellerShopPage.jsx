import { useCallback, useEffect, useState } from 'react'
import { fieldErrorMap, isApiError } from '../../api/http'
import { createShop, getMyShop, updateMyShop } from '../../api/sellerShop'
import { Button } from '../../components/Button'
import { CheckboxField } from '../../components/CheckboxField'
import { DashboardNav } from '../../components/DashboardNav'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { StatusChip } from '../../components/StatusChip'
import { TextAreaField } from '../../components/TextAreaField'
import { TextField } from '../../components/TextField'
import { SELLER_NAV } from './sellerNav'

const EMPTY_FORM = {
  name: '',
  address: '',
  phone: '',
  description: '',
  longitude: '',
  latitude: '',
  isOpen: true,
}

export function SellerShopPage() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [shop, setShop] = useState(null)
  const [hasShop, setHasShop] = useState(false)

  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [success, setSuccess] = useState('')
  const [geoError, setGeoError] = useState('')

  const applyFound = useCallback((found) => {
    setShop(found)
    setHasShop(Boolean(found))
    setLoadError(null)
    if (found) {
      setForm({
        name: found.name ?? '',
        address: found.address ?? '',
        phone: found.phone ?? '',
        description: found.description ?? '',
        longitude: String(found.location?.coordinates?.[0] ?? ''),
        latitude: String(found.location?.coordinates?.[1] ?? ''),
        isOpen: found.isOpen === true,
      })
    }
  }, [])

  // Initial load. State is applied in deferred callbacks, not synchronously.
  useEffect(() => {
    let cancelled = false
    getMyShop()
      .then((body) => {
        if (!cancelled) applyFound(body?.data?.shop ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        if (isApiError(err) && err.status === 404) {
          setShop(null)
          setHasShop(false)
          setForm(EMPTY_FORM)
          setLoadError(null)
        } else {
          setLoadError(err)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyFound])

  function update(field) {
    return (event) => {
      setForm((prev) => ({ ...prev, [field]: event.target.value }))
    }
  }

  function useMyLocation() {
    setGeoError('')
    if (!navigator.geolocation) {
      setGeoError('Geolocation is not available in this browser. Enter coordinates manually.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setForm((prev) => ({
          ...prev,
          longitude: position.coords.longitude.toFixed(6),
          latitude: position.coords.latitude.toFixed(6),
        }))
      },
      () => setGeoError('Could not read your location. Enter coordinates manually.')
    )
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaveError(null)
    setFieldErrors({})
    setSuccess('')

    const errors = {}
    if (!form.name.trim()) errors.name = 'Shop name is required.'
    if (!form.address.trim()) errors.address = 'Address is required.'
    const lng = Number(form.longitude)
    const lat = Number(form.latitude)
    if (form.longitude === '' || Number.isNaN(lng)) errors.longitude = 'Longitude is required.'
    if (form.latitude === '' || Number.isNaN(lat)) errors.latitude = 'Latitude is required.'
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }

    const payload = {
      name: form.name.trim(),
      address: form.address.trim(),
      isOpen: form.isOpen,
      longitude: lng,
      latitude: lat,
    }
    // Send optional text fields only when they carry a value — the backend
    // validates pattern fields (e.g. phone) when a value is present.
    if (form.description.trim()) payload.description = form.description.trim()
    if (form.phone.trim()) payload.phone = form.phone.trim()

    setSaving(true)
    try {
      const body = hasShop ? await updateMyShop(payload) : await createShop(payload)
      const updated = body?.data?.shop ?? null
      if (updated) {
        setShop(updated)
        setHasShop(true)
      }
      setSuccess(
        hasShop
          ? 'Shop profile updated.'
          : 'Shop created. An admin must verify it before you can list inventory.'
      )
    } catch (err) {
      setSaveError(err)
      setFieldErrors(fieldErrorMap(err))
    } finally {
      setSaving(false)
    }
  }

  const verified = shop?.isVerified === true

  return (
    <div className="page">
      <PageHeader eyebrow="Seller workspace" title="Shop profile">
        <p>
          A seller can have one shop. Your shop must be verified by an admin before you can
          list products in inventory.
        </p>
      </PageHeader>

      <DashboardNav items={SELLER_NAV} />

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading your shop…
        </p>
      ) : null}

      {loadError ? <ErrorBanner error={loadError} title="Could not load your shop" /> : null}

      {!loading && !loadError && hasShop && shop ? (
        <section className="panel">
          <div className="page-actions">
            <h2 className="panel__title">Current shop</h2>
            <div className="row">
              <StatusChip status={verified ? 'VERIFIED' : 'UNVERIFIED'} />
              <StatusChip status={shop.isOpen === true ? 'OPEN' : 'CLOSED'} />
            </div>
          </div>
          <dl className="facts">
            <dt>Name</dt>
            <dd>{shop.name || '—'}</dd>
            <dt>Address</dt>
            <dd>{shop.address || '—'}</dd>
            <dt>Phone</dt>
            <dd>{shop.phone || '—'}</dd>
            <dt>Description</dt>
            <dd>{shop.description || '—'}</dd>
          </dl>
        </section>
      ) : null}

      {!loading && !loadError && hasShop && !verified ? (
        <div className="banner banner--info" role="status">
          <p className="banner__title">Not verified yet</p>
          <p className="banner__body">
            Until an admin verifies this shop you cannot add products to inventory, change
            prices or update stock. You can still keep your profile and open status current.
          </p>
        </div>
      ) : null}

      {!loading && !loadError ? (
        <section className="panel panel--muted">
          <h2 className="panel__title">
            {hasShop ? 'Edit shop details' : 'Create your shop'}
          </h2>

          {success ? (
            <div className="banner banner--success" role="status">
              <p className="banner__body">{success}</p>
            </div>
          ) : null}

          {saveError ? <ErrorBanner error={saveError} title="Could not save your shop" /> : null}
          {geoError ? (
            <div className="banner banner--info" role="status">
              <p className="banner__body">{geoError}</p>
            </div>
          ) : null}

          <form onSubmit={handleSubmit}>
            <div className="stack">
              <fieldset className="form-grid" disabled={saving}>
                <TextField
                  id="shop-name"
                  label="Shop name"
                  value={form.name}
                  onChange={update('name')}
                  required
                  error={fieldErrors.name}
                />
                <TextField
                  id="shop-phone"
                  label="Phone"
                  value={form.phone}
                  onChange={update('phone')}
                  error={fieldErrors.phone}
                  hint="Optional. Digits, spaces, +, - and parentheses."
                />
                <TextField
                  id="shop-address"
                  label="Address"
                  value={form.address}
                  onChange={update('address')}
                  required
                  error={fieldErrors.address}
                />
                <TextField
                  id="shop-longitude"
                  label="Longitude"
                  type="number"
                  step="any"
                  value={form.longitude}
                  onChange={update('longitude')}
                  required
                  error={fieldErrors.longitude}
                />
                <TextField
                  id="shop-latitude"
                  label="Latitude"
                  type="number"
                  step="any"
                  value={form.latitude}
                  onChange={update('latitude')}
                  required
                  error={fieldErrors.latitude}
                />
              </fieldset>

              <div className="row">
                <Button type="button" variant="secondary" onClick={useMyLocation} disabled={saving}>
                  Use my current location
                </Button>
              </div>

              <TextAreaField
                id="shop-description"
                label="Description"
                value={form.description}
                onChange={update('description')}
                error={fieldErrors.description}
                hint="Optional. Shown to customers on your shop page."
              />

              <CheckboxField
                id="shop-open"
                label="Shop is open"
                checked={form.isOpen}
                onChange={(checked) => setForm((prev) => ({ ...prev, isOpen: checked }))}
                hint="Closed shops cannot take new reservations."
              />

              <div className="actions">
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : hasShop ? 'Save changes' : 'Create shop'}
                </Button>
              </div>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  )
}
