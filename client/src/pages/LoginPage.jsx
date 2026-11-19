import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { fieldErrorMap } from '../api/http'
import { Button } from '../components/Button'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'
import { TextField } from '../components/TextField'
import { useAuth } from '../context/useAuth'

export function LoginPage() {
  const { user, status, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = location.state?.from?.pathname || '/account'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  if (status !== 'loading' && user) {
    return <Navigate to={from} replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    // Read the live DOM values: browser/password-manager autofill can populate
    // these inputs without React's onChange firing, leaving the controlled state
    // stale. Submitting the DOM value avoids sending outdated credentials.
    const form = event.currentTarget
    const submittedEmail = form.elements.email?.value ?? email
    const submittedPassword = form.elements.password?.value ?? password
    setSubmitting(true)
    setError(null)
    setFieldErrors({})
    try {
      await login({ email: submittedEmail, password: submittedPassword })
      navigate(from, { replace: true })
    } catch (err) {
      setError(err)
      setFieldErrors(fieldErrorMap(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page page--narrow">
      <PageHeader eyebrow="Customer session" title="Log in">
        <p>
          Sign-in uses an HttpOnly cookie. FindLocal never stores a token in
          localStorage or sessionStorage.
        </p>
      </PageHeader>

      {error ? <ErrorBanner error={error} title="Could not log in" /> : null}

      <form className="panel" onSubmit={handleSubmit}>
        <TextField
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
          error={fieldErrors.email}
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete="current-password"
          error={fieldErrors.password}
        />
        <div className="actions">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Log in'}
          </Button>
        </div>
      </form>
      <p className="note">
        New here? <Link to="/register">Create a customer account</Link>
      </p>
    </div>
  )
}
