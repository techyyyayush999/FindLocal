import { useState } from 'react'
import { getNearbyShops } from '../api/shops'
import { fieldErrorMap } from '../api/http'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'
import { ShopCard } from '../components/ShopCard'
import { TextField } from '../components/TextField'

const DEFAULT_RADIUS = '5'
const RADIUS_MIN_KM = 0.1
const RADIUS_MAX_KM = 50

function validateRadiusKm(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') {
    return null
  }
  const km = Number(raw)
  if (!Number.isFinite(km) || km < RADIUS_MIN_KM || km > RADIUS_MAX_KM) {
    return 'Must be between 0.1 and 50 km.'
  }
  return null
}

export function NearbyPage() {
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [radius, setRadius] = useState(DEFAULT_RADIUS)
  const [shops, setShops] = useState([])
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [geoLoading, setGeoLoading] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [geoNote, setGeoNote] = useState(null)

  async function runSearch(nextLat, nextLng, nextRadius) {
    const radiusError = validateRadiusKm(nextRadius)
    if (radiusError) {
      setShops([])
      setSearched(true)
      setError(null)
      setFieldErrors({ radius: radiusError })
      return
    }
    setLoading(true)
    setError(null)
    setFieldErrors({})
    setSearched(true)
    try {
      const trimmedRadius = String(nextRadius ?? '').trim()
      const radiusMetres =
        trimmedRadius === '' ? undefined : Math.round(Number(trimmedRadius) * 1000)
      const body = await getNearbyShops({
        lat: nextLat,
        lng: nextLng,
        radius: radiusMetres,
      })
      setShops(Array.isArray(body?.data?.shops) ? body.data.shops : [])
    } catch (err) {
      setShops([])
      setError(err)
      setFieldErrors(fieldErrorMap(err))
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(event) {
    event.preventDefault()
    runSearch(lat, lng, radius)
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
        const nextLat = String(position.coords.latitude)
        const nextLng = String(position.coords.longitude)
        setLat(nextLat)
        setLng(nextLng)
        setGeoLoading(false)
        runSearch(nextLat, nextLng, radius)
      },
      (geoError) => {
        setGeoLoading(false)
        setGeoNote(geoError.message || 'Location permission was not granted.')
      },
      { enableHighAccuracy: false, timeout: 10000 }
    )
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Distance search" title="Shops near a point">
        <p>
          The API requires latitude and longitude. Radius is optional (0.1–50 km;
          default 5). Only verified shops are returned.
        </p>
      </PageHeader>

      <form className="panel" onSubmit={handleSubmit}>
        <div className="form-grid form-grid--coords">
          <TextField
            id="lat"
            label="Latitude"
            value={lat}
            onChange={(event) => setLat(event.target.value)}
            required
            inputMode="decimal"
            error={fieldErrors.lat}
            autoComplete="off"
          />
          <TextField
            id="lng"
            label="Longitude"
            value={lng}
            onChange={(event) => setLng(event.target.value)}
            required
            inputMode="decimal"
            error={fieldErrors.lng}
            autoComplete="off"
          />
          <TextField
            id="radius"
            label="Radius (km)"
            value={radius}
            onChange={(event) => setRadius(event.target.value)}
            inputMode="decimal"
            min="0.1"
            max="50"
            step="0.1"
            hint="Optional. Supported range: 0.1–50 km. Default is 5 km."
            error={
              fieldErrors.radius ? (
                <>
                  <span aria-hidden="true">*</span>
                  {' '}
                  {fieldErrors.radius}
                </>
              ) : undefined
            }
            autoComplete="off"
          />
        </div>
        <div className="actions">
          <Button type="submit" disabled={loading}>
            {loading ? 'Searching…' : 'Search nearby'}
          </Button>
          <Button type="button" variant="secondary" onClick={useMyLocation} disabled={geoLoading || loading}>
            {geoLoading ? 'Reading location…' : 'Use my location'}
          </Button>
        </div>
      </form>

      {geoNote ? (
        <p className="note" role="status">
          {geoNote}
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Nearby search failed" /> : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Searching verified shops…
        </p>
      ) : null}

      {!loading && searched && !error && shops.length === 0 ? (
        <EmptyState title="No verified shops in this radius">
          Try a larger radius or different coordinates. Results come only from the
          live nearby endpoint.
        </EmptyState>
      ) : null}

      {!loading && shops.length > 0 ? (
        <ul className="shop-grid">
          {shops.map((shop) => (
            <li key={shop._id}>
              <ShopCard shop={shop} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
