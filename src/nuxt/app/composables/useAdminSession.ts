/**
 * Adminsession för skrivning mot masterdatabasen.
 *
 * Lösenordet lever bara på servern. Webbklienten loggar in via
 * POST /api/admin/login och får en httpOnly-cookie som servern
 * validerar - webbläsaren lagrar alltså aldrig lösenordet självt.
 *
 * Inloggningen sker på /admin, där lösenordet matas in i ett formulär.
 */
export function useAdminSession() {
  const authenticated = useState<boolean>('pappa-admin-authenticated', () => false)

  /** Läs aktuell sessionstatus från servern. */
  async function refresh() {
    try {
      const status = await $fetch<{ authenticated: boolean }>('/api/admin/session')
      authenticated.value = status.authenticated
    } catch {
      authenticated.value = false
    }
    return authenticated.value
  }

  /** Logga in med admin-lösenordet (skickas i requestkroppen, inte i URL:en). */
  async function login(password: string) {
    await $fetch('/api/admin/login', { method: 'POST', body: { password } })
    authenticated.value = true
  }

  /** Logga ut - cookien rensas på servern. */
  async function logout() {
    await $fetch('/api/admin/logout', { method: 'POST' })
    authenticated.value = false
  }

  return { authenticated, refresh, login, logout }
}
