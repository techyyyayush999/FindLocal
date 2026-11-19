import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getVerifiedShops } from '../api/shops'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'
import { ShopCard } from '../components/ShopCard'

export function HomePage() {
  const [shops, setShops] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const body = await getVerifiedShops()
        if (!cancelled) {
          setShops(Array.isArray(body?.data?.shops) ? body.data.shops : [])
        }
      } catch (err) {
        if (!cancelled) {
          setShops([])
          setError(err)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <PageHeader eyebrow="Verified shops" title="What’s around you">
        <p>
          Browse shops that FindLocal has verified. Distance search lives on{' '}
          <Link to="/nearby">Nearby</Link>. This list does not include products or
          reservations — those APIs are not public for guests.
        </p>
      </PageHeader>

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading verified shops…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load shops" /> : null}

      {!loading && !error && shops.length === 0 ? (
        <EmptyState title="No verified shops yet">
          When a shop is verified by FindLocal, it will appear here. Nothing is
          being invented for this empty list.
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
