/**
 * Bas-URL mot mailagentens HTTP-API.
 *
 * Klienten (Go-tjänsten `mailagent`) ligger bakom Nuxt:s egen serverproxy
 * på `/api/mail`. Det gör att webbläsaren och SSR går samma väg - ingen
 * CORS, och klienten behöver inte veta var den ligger i klustret.
 *
 * På servern måste URL:en vara absolut (ofetch kan inte tolka en relativ
 * sökväg utan bas-URL), i webbläsaren räcker den relativa sökvägen.
 */
export function useMailApiBase(): string {
  const config = useRuntimeConfig()
  const origin = import.meta.server ? useRequestURL().origin : ''

  return `${origin}${config.public.mailApiBase}`
}
