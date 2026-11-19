export function CheckboxField({ id, label, checked, onChange, hint, disabled = false }) {
  const hintId = hint ? `${id}-hint` : undefined

  return (
    <div className="field field--checkbox">
      <label className="field__check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          aria-describedby={hintId}
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
