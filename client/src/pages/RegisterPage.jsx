import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { fieldErrorMap } from '../api/http'
import { Button } from '../components/Button'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'
import { TextField } from '../components/TextField'
import { useAuth } from '../context/useAuth'

export function RegisterPage() {
  const { user, status, register } = useAuth()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [confirmError, setConfirmError] = useState('')

  if (status !== 'loading' && user) {
    return <Navigate to="/account" replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setConfirmError('')
    if (password !== confirm) {
      setConfirmError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    setError(null)
    setFieldErrors({})
    try {
      await register({ name, email, password })
      navigate('/account', { replace: true })
    } catch (err) {
      setError(err)
      setFieldErrors(fieldErrorMap(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page page--narrow">
      <PageHeader eyebrow="Customer session" title="Create an account">
        <p>
          This form registers a customer only. Seller and admin accounts are not
          created here.
        </p>
      </PageHeader>

      {error ? <ErrorBanner error={error} title="Could not create account" /> : null}

      <form className="panel" onSubmit={handleSubmit}>
        <TextField
          id="name"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          autoComplete="name"
          error={fieldErrors.name}
        />
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
          autoComplete="new-password"
          hint="At least 8 characters."
          error={fieldErrors.password}
        />
        <TextField
          id="confirm"
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
          autoComplete="new-password"
          error={confirmError}
        />
        <div className="actions">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create customer account'}
          </Button>
        </div>
      </form>
      <p className="note">
        Already registered? <Link to="/login">Log in</Link>
      </p>
    </div>
  )
}
