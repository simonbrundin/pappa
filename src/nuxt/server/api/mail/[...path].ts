/**
 * Proxy till mailagentens HTTP-API.
 *
 * Klienten (`mailagent`) körs som en egen tjänst och exponerar `/api/v1`.
 * Här proxias anropen dit, vilket ger tre fördelar:
 *
 *   - webbläsaren använder relativa URL:er och slipper CORS-huvud
 *   - SSR i klustret når klienten via DNS-namnet `mailagent`
 *   - klientens adress behöver inte hårdkodas i webbläsaren
 *
 * Sökvägen efter `/api/mail` skickas vidare ordagrant, så även
 * `/accounts/<konto>/folders/<mapp>/emails` fungerar.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const base = String(config.mailApiBase || '').replace(/\/+$/, '')
  const path = event.context.params?.path ?? ''

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(getQuery(event))) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item))
    } else {
      search.append(key, String(value))
    }
  }

  const query = search.toString()
  const target = `${base}/${path}${query ? `?${query}` : ''}`

  return proxyRequest(event, target)
})
