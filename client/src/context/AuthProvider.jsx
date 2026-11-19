import { useCallback, useEffect, useMemo, useState } from 'react'
import { getMe, login as loginRequest, logout as logoutRequest, registerCustomer } from '../api/auth'
import { ApiError } from '../api/http'
import { AuthContext } from './auth-context'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [status, setStatus] = useState('loading')
  const [bootstrapError, setBootstrapError] = useState(null)

  const applySessionFailure = useCallback((error) => {
    setUser(null)
    if (error instanceof ApiError && error.status === 401) {
      setBootstrapError(null)
    } else {
      setBootstrapError(error)
    }
    setStatus('ready')
  }, [])

  const applySessionUser = useCallback((nextUser) => {
    setUser(nextUser)
    setBootstrapError(null)
    setStatus('ready')
  }, [])

  useEffect(() => {
    let cancelled = false

    // Cookie session check: the HttpOnly token cannot be read in JS, so the
    // first paint asks GET /api/v1/auth/me. 401 is treated as logged out.
    getMe()
      .then((body) => {
        if (!cancelled) applySessionUser(body?.data?.user ?? null)
      })
      .catch((error) => {
        if (!cancelled) applySessionFailure(error)
      })

    return () => {
      cancelled = true
    }
  }, [applySessionFailure, applySessionUser])

  const login = useCallback(
    async (credentials) => {
      const body = await loginRequest(credentials)
      applySessionUser(body?.data?.user ?? null)
      return body
    },
    [applySessionUser]
  )

  const register = useCallback(
    async (payload) => {
      const body = await registerCustomer(payload)
      applySessionUser(body?.data?.user ?? null)
      return body
    },
    [applySessionUser]
  )

  const logout = useCallback(async () => {
    await logoutRequest()
    setUser(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const body = await getMe()
      applySessionUser(body?.data?.user ?? null)
    } catch (error) {
      applySessionFailure(error)
    }
  }, [applySessionFailure, applySessionUser])

  const value = useMemo(
    () => ({
      user,
      status,
      bootstrapError,
      isAuthenticated: Boolean(user),
      refresh,
      login,
      register,
      logout,
    }),
    [user, status, bootstrapError, refresh, login, register, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
