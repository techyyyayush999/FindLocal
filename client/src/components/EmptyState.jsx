export function EmptyState({ title, children }) {
  return (
    <div className="empty">
      <h2 className="empty__title">{title}</h2>
      {children ? <p className="empty__body">{children}</p> : null}
    </div>
  )
}
