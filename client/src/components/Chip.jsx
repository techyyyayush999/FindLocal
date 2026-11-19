export function Chip({ tone = 'neutral', children }) {
  return <span className={`chip chip--${tone}`}>{children}</span>
}
