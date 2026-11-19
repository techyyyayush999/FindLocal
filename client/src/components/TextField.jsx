export function TextField({
  id,
  label,
  type = 'text',
  value,
  onChange,
  error,
  hint,
  required = false,
  autoComplete,
  inputMode,
  step,
  min,
  max,
  name,
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
      <input
        id={id}
        className={`field__input${error ? ' field__input--error' : ''}`}
        type={type}
        name={name || id}
        value={value}
        onChange={onChange}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        step={step}
        min={min}
        max={max}
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
