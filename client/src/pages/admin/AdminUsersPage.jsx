import { useCallback, useEffect, useState } from 'react'
import { listUsers, updateUserStatus } from '../../api/admin'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DashboardNav } from '../../components/DashboardNav'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { StatusChip } from '../../components/StatusChip'
import { useAuth } from '../../context/useAuth'
import { formatDateTime } from '../../utils/format'
import { ADMIN_NAV } from './adminNav'

function roleTone(role) {
  if (role === 'admin') return 'pending'
  if (role === 'seller') return 'active'
  return 'neutral'
}

export function AdminUsersPage() {
  const { user: currentUser } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [users, setUsers] = useState([])
  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')

  const applyUsers = useCallback((body) => {
    setUsers(body?.data?.users ?? [])
    setError(null)
  }, [])

  const load = useCallback(async () => {
    try {
      const body = await listUsers()
      applyUsers(body)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [applyUsers])

  // Initial load. State is applied in deferred callbacks, not synchronously.
  useEffect(() => {
    let cancelled = false
    listUsers()
      .then((body) => {
        if (!cancelled) applyUsers(body)
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyUsers])

  async function changeStatus(target, isActive) {
    const id = target._id || target.id
    setBusyId(id)
    setActionError(null)
    setNotice('')
    try {
      const body = await updateUserStatus(id, isActive)
      const updated = body?.data?.user
      if (updated) {
        setUsers((prev) => prev.map((item) => ((item._id || item.id) === id ? updated : item)))
      } else {
        await load()
      }
      setNotice(isActive ? 'Account reactivated.' : 'Account deactivated.')
    } catch (err) {
      setActionError(err)
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Admin console" title="Users">
        <p>Deactivate an account to soft-ban it. Admins cannot deactivate themselves.</p>
      </PageHeader>

      <DashboardNav items={ADMIN_NAV} />

      {notice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__body">{notice}</p>
        </div>
      ) : null}

      {actionError ? (
        <ErrorBanner error={actionError} title="Could not update that account" />
      ) : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading users…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load users" /> : null}

      {!loading && !error ? (
        users.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">All user accounts</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Account</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const id = user._id || user.id
                  const isSelf = currentUser?._id === id || currentUser?.id === id
                  const active = user.isActive !== false
                  const busy = busyId === id

                  return (
                    <tr key={id}>
                      <td>
                        {user.name || '—'}
                        {isSelf ? <div className="subtle">This is you</div> : null}
                      </td>
                      <td>{user.email || '—'}</td>
                      <td>
                        <Chip tone={roleTone(user.role)}>{user.role || 'customer'}</Chip>
                      </td>
                      <td>
                        <StatusChip status={active ? 'ACTIVE' : 'INACTIVE'} />
                      </td>
                      <td>{formatDateTime(user.createdAt)}</td>
                      <td>
                        <div className="data-table__actions">
                          {isSelf ? (
                            <span className="subtle">You cannot change your own status</span>
                          ) : active ? (
                            <ConfirmButton
                              onConfirm={() => changeStatus(user, false)}
                              busy={busy}
                              busyLabel="Deactivating…"
                              confirmLabel="Yes, deactivate"
                              disabled={busy}
                            >
                              Deactivate
                            </ConfirmButton>
                          ) : (
                            <Button onClick={() => changeStatus(user, true)} disabled={busy}>
                              {busy ? 'Working…' : 'Activate'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No users found">Accounts appear here once people register.</EmptyState>
        )
      ) : null}
    </div>
  )
}
