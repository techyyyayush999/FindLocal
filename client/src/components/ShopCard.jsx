import { Link } from 'react-router-dom'
import { Chip } from './Chip'

export function ShopCard({ shop }) {
  const id = shop?._id
  if (!id) return null

  const open = shop.isOpen === true

  return (
    <article className="shop-card">
      <div className="shop-card__top">
        <h2 className="shop-card__name">
          <Link to={`/shops/${id}`}>{shop.name || 'Unnamed shop'}</Link>
        </h2>
        <Chip tone={open ? 'open' : 'closed'}>{open ? 'Open' : 'Closed'}</Chip>
      </div>
      {shop.address ? <p className="shop-card__address">{shop.address}</p> : null}
      {shop.description ? <p className="shop-card__desc">{shop.description}</p> : null}
      <div className="shop-card__meta">
        {shop.distanceFormatted ? <span>{shop.distanceFormatted}</span> : null}
        {shop.phone ? <span>{shop.phone}</span> : null}
      </div>
    </article>
  )
}
