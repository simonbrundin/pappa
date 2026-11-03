/**
 * Admin-token för skrivning mot masterdatabasen.
 *
 * Lagras i sessionStorage (aldrig localStorage) - token ska inte överleva
 * att webbläsaren stängs. Samma token används av dubblettsammanslagning
 * och av att spara kravprofiler.
 */
export function useAdminToken() {
  const token = useState<string>('pappa-admin-token', () => '')
  const input = useState<string>('pappa-admin-token-input', () => '')

  function load() {
    if (!import.meta.client) return
    if (!token.value) {
      token.value = sessionStorage.getItem('pappa-admin-token') ?? ''
      input.value = token.value
    }
  }

  function save(value: string) {
    token.value = value.trim()
    input.value = token.value
    if (import.meta.client) {
      sessionStorage.setItem('pappa-admin-token', token.value)
    }
  }

  /** Header för skrivanrop. Tom streng när ingen token finns. */
  function headers(): Record<string, string> {
    return token.value ? { 'x-admin-token': token.value } : {}
  }

  return { token, input, load, save, headers }
}
