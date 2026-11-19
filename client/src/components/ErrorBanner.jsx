import { formatError, isApiError } from '../api/http'

export function ErrorBanner({ error, title = 'Unable to complete that request' }) {
  if (!error) return null

  const message = formatError(error)
  const fieldErrors = isApiError(error) ? error.errors : []

  return (
    <div className="banner banner--error" role="alert">
      <p className="banner__title">{title}</p>
      <p className="banner__body">{message}</p>
      {fieldErrors.length > 0 ? (
        <ul className="banner__list">
          {fieldErrors.map((item) => (
            <li key={`${item.field}-${item.message}`}>
              {item.field ? `${item.field}: ` : ''}
              {item.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
