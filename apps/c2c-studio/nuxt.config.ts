// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss'],
  devtools: { enabled: true },
  runtimeConfig: {
    public: {
      c2cBffBaseUrl: process.env.NUXT_PUBLIC_C2C_BFF_BASE_URL || '',
    }
  },
  css: ['~/assets/css/main.css'],
})
