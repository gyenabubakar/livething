// Cloudflare Web Analytics beacon token — set in the Workers build env. The
// beacon only loads once a token is present, so local dev stays clean.
const cfBeaconToken = process.env.NUXT_PUBLIC_CF_BEACON_TOKEN

export default defineNuxtConfig({
  extends: ['docus'],

  devServer: {
    port: 9000,
  },

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
      script: cfBeaconToken
        ? [
            {
              src: 'https://static.cloudflareinsights.com/beacon.min.js',
              defer: true,
              'data-cf-beacon': JSON.stringify({ token: cfBeaconToken }),
            },
          ]
        : [],
    },
  },

  routeRules: {
    '/': { prerender: true },
  },

  nitro: {
    prerender: {
      crawlLinks: true,
      routes: ['/'],
      // Cap parallelism so the OG-image (satori/resvg) renders don't swamp the
      // worker pool and time out — the heavy OG template needs breathing room.
      concurrency: 3,
    },
  },

  mcp: {
    enabled: false,
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
    // Standard social card ratio (1.91:1).
    defaults: {
      width: 1200,
      height: 630,
    },
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
    build: {
      markdown: {
        highlight: {
          theme: { default: 'github-dark', dark: 'github-dark' },
        },
      },
    },
    experimental: {
      sqliteConnector: 'native',
    },
  },

  mdc: {
    highlight: {
      theme: { default: 'github-dark', dark: 'github-dark' },
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
