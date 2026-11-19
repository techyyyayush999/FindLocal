export function PageHeader({ eyebrow, title, children }) {
  return (
    <header className="page-header">
      {eyebrow ? <p className="page-header__eyebrow">{eyebrow}</p> : null}
      <h1 className="page-header__title">{title}</h1>
      {children ? <div className="page-header__lede">{children}</div> : null}
    </header>
  )
}
