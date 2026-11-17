
import { alphaTab } from "@coderline/alphatab-vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },

  future: {
    compatibilityVersion: 4,
  },

  // alphaTab renders and synthesizes inside Web Workers; the plugin copies
  // Bravura + SONiVOX into the output root and wires the worker URLs.
  vite: {
    // Assets live in public/ so the dev server can serve them too; the plugin
    // still wires the Web Worker and Audio Worklet URLs.
    plugins: [alphaTab({ assetOutputDir: false })],
  },

  modules: [
    "@nuxtjs/color-mode",
    "@nuxt/icon",
    "@nuxt/fonts",
  ],

  colorMode: {
    storageKey: "app-color-mode",
    classSuffix: "",
  },

  icon: {
    clientBundle: {
      scan: true,
      sizeLimitKb: 0,
    },
    mode: "svg",
    class: "shrink-0",
    fetchTimeout: 2000,
    serverBundle: "local",
  },
});
