import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getShopById } from '../api/shops'
import { Chip } from '../components/Chip'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'

export function ShopDetailPage() {
  const { id } = useParams()
  const [shop, setShop] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      setShop(null)
      try {
        const body = await getShopById(id)
        if (!cancelled) setShop(body?.data?.shop ?? null)
      } catch (err) {
        if (!cancelled) setError(err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [id])

  const coordinates = shop?.location?.coordinates
  const hasCoords = Array.isArray(coordinates) && coordinates.length === 2
  const open = shop?.isOpen === true

  return (
    <div className="page">
      <p className="crumb">
        <Link to="/">Shops</Link>
        <span aria-hidden="true"> / </span>
        <span>Detail</span>
      </p>

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading shop…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Shop not available" /> : null}

      {!loading && !error && shop ? (
        <>
          <PageHeader eyebrow="Verified shop" title={shop.name || 'Shop'}>
            <div className="header-row">
              <Chip tone={open ? 'open' : 'closed'}>{open ? 'Open now' : 'Closed'}</Chip>
            </div>
          </PageHeader>

          <section className="panel">
            <dl className="facts">
              {shop.address ? (
                <>
                  <dt>Address</dt>
                  <dd>{shop.address}</dd>
                </>
              ) : null}
              {shop.phone ? (
                <>
                  <dt>Phone</dt>
                  <dd>{shop.phone}</dd>
                </>
              ) : null}
              {shop.description ? (
                <>
                  <dt>About</dt>
                  <dd>{shop.description}</dd>
                </>
              ) : null}
              {hasCoords ? (
                <>
                  <dt>Coordinates</dt>
                  <dd>
                    Longitude {coordinates[0]}, latitude {coordinates[1]}
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="note">
              This page shows the shop record from GET /api/v1/shops/:id. There is
              no customer endpoint for this shop’s inventory, so products and
              reserve actions are not shown.
            </p>
          </section>
        </>
      ) : null}
    </div>
  )
}
