import { useState } from 'react'
import { Button } from './Button'

// Two-step button for consequential actions. The first click arms the action;
// the second confirms it. While the parent marks `busy`, the button is disabled
// so the action cannot be submitted twice.
export function ConfirmButton({
  children,
  onConfirm,
  confirmLabel = 'Confirm',
  variant = 'secondary',
  disabled = false,
  busy = false,
  busyLabel = 'Working…',
}) {
  const [confirming, setConfirming] = useState(false)

  if (busy) {
    return (
      <Button type="button" variant={variant} disabled>
        {busyLabel}
      </Button>
    )
  }

  if (!confirming) {
    return (
      <Button type="button" variant={variant} disabled={disabled} onClick={() => setConfirming(true)}>
        {children}
      </Button>
    )
  }

  return (
    <span className="confirm">
      <Button
        type="button"
        variant="primary"
        onClick={() => {
          setConfirming(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
        Keep as is
      </Button>
    </span>
  )
}
