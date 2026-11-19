import { NavLink } from 'react-router-dom'

// Secondary, in-page navigation shared by the seller and admin dashboards.
export function DashboardNav({ items }) {
  return (
    <ul className="dash-nav">
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'dash-nav__link is-active' : 'dash-nav__link')}
          >
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  )
}
