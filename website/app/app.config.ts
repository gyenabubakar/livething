export default defineAppConfig({
  navigation: {
    sub: 'header',
  },
  github: {
    rootDir: 'website',
  },
  seo: {
    titleTemplate: '%s - WSKit',
    title: 'WSKit',
    description: 'A typed WebSocket framework for TypeScript. Call server() once and the client inherits the exact types — events, requests, channels, and streams, end to end.',
  },
  assistant: {
    icons: {
      trigger: 'i-custom:ai'
    },
    faqQuestions: [
      {
        category: 'Getting Started',
        items: [
          'What is WSKit?',
          'How do I install WSKit?',
          'How do I create a typed contract?',
        ],
      },
      {
        category: 'Core Features',
        items: [
          'How do channels work?',
          'How do I stream data to the client?',
          'How does reconnection work?',
        ],
      },
      {
        category: 'Production',
        items: [
          'How do I authenticate a connection?',
          'How do I rate limit events?',
          'Which platforms does WSKit run on?',
        ],
      },
    ],
  },
  ui: {
    page: {
      slots: {
        // Left sidebar 25%, center 40%, right TOC 35% of the content area: left
        // columns are 15fr, the center six 8fr, the right two 21fr (of 120).
        root: 'flex flex-col lg:grid lg:grid-cols-[15fr_15fr_8fr_8fr_8fr_8fr_8fr_8fr_21fr_21fr] lg:gap-10',
      },
    },
    colors: {
      primary: 'orange',
      neutral: 'zinc',
    },
    prose: {
      codeIcon: {
        'react': 'i-vscode-icons-file-type-reactts',
        'svelte': 'i-vscode-icons-file-type-svelte',
        'jsonc': 'i-vscode-icons-file-type-json',
        'nuxt': 'i-vscode-icons-file-type-nuxt',
        'nuxt / nitro': 'i-vscode-icons-file-type-nuxt',
        'next.js': 'i-simple-icons-nextdotjs',
        'express': 'i-simple-icons-express',
        'hono': 'i-simple-icons-hono',
        'fastify': 'i-simple-icons-fastify',
        'elysia': 'i-custom:elysia',
        'nestjs': 'i-simple-icons-nestjs',
        'standalone': 'i-ph-cube-duotone',
        'nitro': 'i-custom:nitro',
      },
    },
    button: {
      slots: {
        base: 'active:translate-y-px transition-transform duration-300',
      },
    },
    contentToc: {
      defaultVariants: {
        highlightVariant: 'circuit'
      }
    },
    contentSurround: {
      variants: {
        direction: {
          left: {
            linkLeadingIcon: ['group-active:translate-x-0',],
          },
          right: {
            linkLeadingIcon: ['group-active:translate-x-0',],
          },
        },
      },
    }
  },
})
