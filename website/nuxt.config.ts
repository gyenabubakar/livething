export default defineNuxtConfig({
  extends: ['docus'],

  app: {
    head: {
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
        { rel: 'shortcut icon', href: '/favicon.ico' },
      ],
    },
  },

  routeRules: {
    '/': { prerender: true },
  },

  modules: [
    '@nuxt/fonts',
    'motion-v/nuxt',
    'nuxt-studio',
  ],

  colorMode: {
    preference: 'dark',
  },

  fonts: {
    families: [
      { name: 'Geist', weights: [400, 500, 600, 700], global: true },
      { name: 'DM Mono', weights: [400, 500], global: true },
      {
        name: 'Geist Pixel Line',
        src: '/fonts/GeistPixel-Line.woff2',
        weights: [400],
        global: true,
      },
    ],
  },

  css: ['~/assets/css/main.css'],

  site: {
    name: 'WSKit',
    url: 'https://www.wskit.dev',
  },

  ogImage: {
    // OgImageDocs.satori.vue uses heavy shadow/blur effects, so Satori is slow.
    // The 15s default can time some pages out during prerender — bump it so every
    // OG image renders fully at build time instead of failing the prerender.
    security: {
      renderTimeout: 60_000,
    },
  },

  studio: {
    development: {
      sync: false,
    },
    repository: {
      provider: 'github',
      owner: 'plain-software-co',
      repo: 'wskit',
      rootDir: 'website',
    },
  },

  content: {
    experimental: {
      sqliteConnector: 'native',
    },
  },

  mdc: {
    highlight: {
      noApiRoute: false,
      // Include every language used in `content/` — a narrow list (e.g. only `tsx`) breaks SSR
      // on refresh when Shiki/MDC cannot load grammars for `bash`, `vue`, etc.
      langs: [
        'apl',
        'bash',
        'css',
        'diff',
        'html',
        'js',
        'json',
        'jsonc',
        'jsx',
        'md',
        'mdc',
        'shell',
        'svelte',
        'toml',
        'ts',
        'tsx',
        'typescript',
        'vue',
        'yaml',
      ],
    },
  },

  icon: {
    customCollections: [
      {
        prefix: 'custom',
        dir: './app/assets/icons',
      },
    ],
    clientBundle: {
      scan: true,
      includeCustomCollections: true,
    },
    provider: 'iconify',
  },

  vite: {
    optimizeDeps: {
      include: ['shaders/vue'],
    },
  },
})
