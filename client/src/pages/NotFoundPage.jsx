import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'

export function NotFoundPage() {
  return (
    <div className="page page--narrow">
      <PageHeader title="Page not found">
        <p>
          That route is not part of the customer app.{' '}
          <Link to="/">Return to verified shops</Link>.
        </p>
      </PageHeader>
    </div>
  )
}
