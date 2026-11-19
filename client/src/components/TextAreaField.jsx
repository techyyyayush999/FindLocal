export function TextAreaField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  rows = 3,
  required = false,
  disabled = false,
  maxLength,
}) {
  const errorId = error ? `${id}-error` : undefined
  const hintId = hint ? `${id}-hint` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? <span className="field__required"> required</span> : null}
      </label>
      <textarea
        id={id}
        className={`field__input${error ? ' field__input--error' : ''}`}
        value={value}
        onChange={onChange}
        rows={rows}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
      />
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
