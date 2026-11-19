import { useState } from 'react'
import { formatError } from '../../api/http'
import { updateInventory, updateInventoryStock } from '../../api/inventory'
import { Button } from '../../components/Button'
import { ConfirmButton } from '../../components/ConfirmButton'
import { StatusChip } from '../../components/StatusChip'
import { formatPaise, orDash } from '../../utils/format'

const PRICE_MIN_PAISE = 1
const PRICE_MAX_PAISE = 100000000
const QUANTITY_MAX = 1000000

function toRupees(paise) {
  if (typeof paise !== 'number' || Number.isNaN(paise)) return ''
  return String(paise / 100)
}

export function InventoryRow({ entry, canEditPriceStock, onUpdated }) {
  const id = entry._id || entry.id
  const product = entry.product && typeof entry.product === 'object' ? entry.product : null

  const [priceRupees, setPriceRupees] = useState(toRupees(entry.pricePaise))
  const [stockValue, setStockValue] = useState(String(entry.quantity ?? ''))
  const [adjustValue, setAdjustValue] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)

  async function run(kind, action, message) {
    setBusy(kind)
    setError(null)
    try {
      const body = await action()
      onUpdated?.(body?.data?.inventory, message)
    } catch (err) {
      setError(err)
    } finally {
      setBusy('')
    }
  }

  function savePrice() {
    const rupees = Number(priceRupees)
    if (priceRupees.trim() === '' || Number.isNaN(rupees) || rupees <= 0) {
      setError(new Error('Enter a price greater than zero.'))
      return
    }
    const pricePaise = Math.round(rupees * 100)
    if (pricePaise < PRICE_MIN_PAISE || pricePaise > PRICE_MAX_PAISE) {
      setError(new Error('Price must be between ₹0.01 and ₹1,000,000.'))
      return
    }
    run('price', () => updateInventory(id, { pricePaise }), 'Price updated.')
  }

  function setStock() {
    const value = Number(stockValue)
    if (stockValue.trim() === '' || !Number.isInteger(value) || value < 0 || value > QUANTITY_MAX) {
      setError(new Error('Quantity must be a whole number between 0 and 1,000,000.'))
      return
    }
    run('stock', () => updateInventoryStock(id, { quantity: value }), 'Stock set.')
  }

  function adjustStock() {
    const value = Number(adjustValue)
    if (adjustValue.trim() === '' || !Number.isInteger(value) || value === 0) {
      setError(new Error('Adjustment must be a non-zero whole number (negative to reduce).'))
      return
    }
    run('stock', () => updateInventoryStock(id, { adjust: value }), 'Stock adjusted.')
  }

  function toggleActive() {
    const next = !(entry.isActive === true)
    run(
      'active',
      () => updateInventory(id, { isActive: next }),
      next ? 'Listing activated.' : 'Listing deactivated.'
    )
  }

  const reserved = entry.reservedQuantity ?? 0
  const available =
    typeof entry.availableQuantity === 'number'
      ? entry.availableQuantity
      : (entry.quantity ?? 0) - reserved

  return (
    <tr>
      <td>
        <strong>{product?.name || 'Product'}</strong>
        {product?.brand ? <div className="subtle">{product.brand}</div> : null}
        {product?.category ? <div className="subtle">{product.category}</div> : null}
      </td>
      <td>{formatPaise(entry.pricePaise)}</td>
      <td>{orDash(entry.quantity)}</td>
      <td>{orDash(reserved)}</td>
      <td>{orDash(available)}</td>
      <td>
        <StatusChip status={entry.isActive === true ? 'ACTIVE' : 'INACTIVE'} />
      </td>
      <td>
        <div className="stack--tight">
          {canEditPriceStock ? (
            <>
              <div className="inline-form">
                <label className="sr-only" htmlFor={`price-${id}`}>
                  Price in rupees
                </label>
                <input
                  id={`price-${id}`}
                  className="field__input"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={priceRupees}
                  onChange={(event) => setPriceRupees(event.target.value)}
                  disabled={busy !== ''}
                />
                <Button variant="secondary" onClick={savePrice} disabled={busy !== ''}>
                  {busy === 'price' ? 'Saving…' : 'Save price'}
                </Button>
              </div>

              <div className="inline-form">
                <label className="sr-only" htmlFor={`stock-${id}`}>
                  Stock quantity
                </label>
                <input
                  id={`stock-${id}`}
                  className="field__input"
                  type="number"
                  step="1"
                  min="0"
                  value={stockValue}
                  onChange={(event) => setStockValue(event.target.value)}
                  disabled={busy !== ''}
                />
                <Button variant="secondary" onClick={setStock} disabled={busy !== ''}>
                  {busy === 'stock' ? 'Saving…' : 'Set'}
                </Button>
              </div>

              <div className="inline-form">
                <label className="sr-only" htmlFor={`adjust-${id}`}>
                  Stock adjustment
                </label>
                <input
                  id={`adjust-${id}`}
                  className="field__input"
                  type="number"
                  step="1"
                  value={adjustValue}
                  onChange={(event) => setAdjustValue(event.target.value)}
                  placeholder="±"
                  disabled={busy !== ''}
                />
                <Button variant="secondary" onClick={adjustStock} disabled={busy !== ''}>
                  Adjust
                </Button>
              </div>
            </>
          ) : (
            <p className="subtle">Price and stock changes require a verified shop.</p>
          )}

          <div className="data-table__actions">
            {entry.isActive === true ? (
              <ConfirmButton
                onConfirm={toggleActive}
                busy={busy === 'active'}
                busyLabel="Deactivating…"
                confirmLabel="Yes, deactivate"
              >
                Deactivate
              </ConfirmButton>
            ) : (
              <Button onClick={toggleActive} disabled={busy !== ''}>
                {busy === 'active' ? 'Activating…' : 'Activate'}
              </Button>
            )}
          </div>

          {error ? (
            <p className="field__error" role="alert">
              {formatError(error)}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
