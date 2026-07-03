// Cloudflare Web Analytics beacon token — set in the Workers build env. The
// beacon only loads once a token is present, so local dev stays clean.
const cfBeaconToken = process.env.NUXT_PUBLIC_CF_BEACON_TOKEN

// Single source of truth for the site's public URL. Override via the
// NUXT_PUBLIC_SITE_URL build env var, or just change this default when the
// real domain is bought — every canonical/OG/sitemap URL follows it.
const siteUrl = process.env.NUXT_PUBLIC_SITE_URL || 'https://wskit.gyen.dev'

export default defineNuxtConfig({
  extends: ['docus'],

  devServer: {
    port: 9000,
  },

  runtimeConfig: {
    public: {
      siteUrl,
    },
  },

  app: {
    head: {
      meta: [
        { name: 'twitter:site', content: '@GyenAbubakar' },
        { name: 'twitter:creator', content: '@GyenAbubakar' },
      ],
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
    url: siteUrl,
  },

  llms: {
    domain: siteUrl,
    title: 'WSKit',
    description:
      'A typed, end-to-end WebSocket framework for TypeScript: define one contract and get an inferred client and server, with channels, streams, requests, presence, and reliability built in.',
    full: {
      title: 'WSKit — full documentation',
      description: 'Every WSKit documentation page concatenated into one file.',
    },
    // Group the index by the seven navbar sections. `@nuxt/content` fills each
    // section's links by querying the `docs` collection with these path filters.
    sections: [
      {
        title: 'Start',
        description: 'Install WSKit and build your first typed realtime app.',
        contentCollection: 'docs',
        contentFilters: [{ field: 'path', operator: 'LIKE', value: '/start/%' }],
      },
      {
        title: 'Learn',
        description: 'The guided tour — the server and client as two halves of one contract.',
        contentCollection: 'docs',
        contentFilters: [{ field: 'path', operator: 'LIKE', value: '/learn/%' }],
      },
      {
        title: 'Client',
        description: 'The @wskit/client package: the socket, primitives, channels, streams, and errors.',
        contentCollection: 'docs',
        contentFilters: [{ field: 'path', operator: 'LIKE', value: '/client/%' }],
      },
      {
        title: 'Server',
        description:
          'The @wskit/server package: define, capabilities, handlers, channels, streams, and adapters.',
        contentCollection: 'docs',
        contentFilters: [{ field: 'path', operator: 'LIKE', value: '/server/%' }],
      },
      {
        title: 'Core',
        description: 'The @wskit/core shared layer: the error model, built-in errors, and close codes.',
        contentCollection: 'docs',
        contentFilters: [{ field: 'path', operator: 'LIKE', value: '/core/%' }],
      },
      {
        title: 'Recipes',
        description: 'Complete worked apps, plus the framework-wiring setup.',
        contentCollection: 'docs',
        contentFilters: [{ field: 'path', operator: 'LIKE', value: '/recipes/%' }],
      },
      {
        title: 'Reference',
        description: 'Lookup tables: error codes, close codes, and the socket API.',
        contentCollection: 'docs',
        contentFilters: [{ field: 'path', operator: 'LIKE', value: '/reference/%' }],
      },
    ],
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
