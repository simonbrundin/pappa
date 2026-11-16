// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  // Komponenterna ligger i underkataloger (t.ex. app/components/mail/).
  // Utan pathPrefix: false får de prefixet med katalognamnet
  // ("MailAccountSelector"), vilket gör att en referens som
  // <AccountSelector /> inte hittas - komponenten renderas aldrig.
  components: [
    { path: '~/components', pathPrefix: false },
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  runtimeConfig: {
    // Sätts via NUXT_DATABASE_URL, se server/utils/db.ts
    databaseUrl: '',
    // Sätts via NUXT_ADMIN_TOKEN. Krävs för skrivning (dubblettsammanslagning).
    // Utan token är sammanslagning avsiktligt avstängd.
    adminToken: '',
    // Mailagentens HTTP-API, nådbar från servern. I klustret: service mailagent.
    // Sätts via NUXT_MAIL_API_BASE.
    mailApiBase: 'http://localhost:8401/api/v1',
    public: {
      // Basväg webbläsaren använder mot Nuxt:s egen proxy (/api/mail -> mailagent).
      mailApiBase: '/api/mail',
      // Konto som används om inget annat är valt.
      mailDefaultAccount: '',
    },
  },
})
