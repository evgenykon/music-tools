<script setup lang="ts">
const route = useRoute()

const tabs = [
  { to: '/', label: 'Квинтовый круг' },
  { to: '/chords', label: 'Определить аккорд' },
  { to: '/tree', label: 'Дерево аккордов' },
  { to: '/notebook', label: 'Блокнот' },
  { to: '/player', label: 'Табы' },
]

/** Exact match: "/" must not stay active on subpages. */
const isActive = (to: string) => route.path === to || route.path === `${to}/`
</script>

<template>
  <div class="app-shell">
    <header class="app-bar">
      <NuxtLink to="/" class="app-brand">
        <svg class="app-brand-mark" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="19.5" fill="none" stroke="currentColor" stroke-width="6" />
          <circle cx="32" cy="12.5" r="6.4" fill="currentColor" />
          <circle cx="48.9" cy="42.25" r="6.4" fill="currentColor" />
          <circle cx="15.1" cy="42.25" r="6.4" fill="currentColor" />
        </svg>
        <span class="app-brand-name">music-tools</span>
      </NuxtLink>

      <nav class="app-tabs" aria-label="Разделы">
        <NuxtLink
          v-for="tab in tabs"
          :key="tab.to"
          :to="tab.to"
          class="app-tab"
          :class="{ 'app-tab--active': isActive(tab.to) }"
        >
          {{ tab.label }}
        </NuxtLink>
      </nav>
    </header>

    <slot />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: var(--background);
}

.app-bar {
  position: sticky;
  top: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 16px;
  height: var(--app-bar-h);
  padding: 0 16px;
  background: color-mix(in srgb, var(--background) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}

.app-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  color: var(--foreground);
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.app-brand-mark {
  width: 18px;
  height: 18px;
  color: var(--accent);
  flex-shrink: 0;
}

.app-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.app-tabs::-webkit-scrollbar {
  display: none;
}

.app-tab {
  font-size: 13px;
  line-height: 1;
  color: var(--muted-foreground);
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px 11px;
  white-space: nowrap;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.app-tab:hover {
  color: var(--foreground);
  background: var(--muted);
}

.app-tab--active {
  color: var(--foreground);
  background: var(--muted);
  border-color: var(--border);
}

@media (max-width: 560px) {
  .app-bar {
    gap: 10px;
    padding: 0 10px;
  }

  .app-brand-name {
    display: none;
  }

  .app-tab {
    padding: 8px 9px;
    font-size: 12px;
  }
}
</style>
