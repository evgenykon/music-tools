<script setup>
import './assets/css/main.css'

const base = useRuntimeConfig().app.baseURL

useHead({
  link: [
    { rel: 'icon', type: 'image/svg+xml', href: `${base}icon.svg` },
    { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}icon-32.png` },
    { rel: 'apple-touch-icon', sizes: '180x180', href: `${base}apple-touch-icon.png` },
    { rel: 'manifest', href: `${base}site.webmanifest` },
  ],
  meta: [{ name: 'theme-color', content: '#0b0f0e' }],
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
