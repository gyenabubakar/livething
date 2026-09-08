# Docus Default Starter

> A beautiful, minimal starter for creating documentation with Docus

This is the default Docus starter template that provides everything you need to build beautiful documentation sites with Markdown and Vue components.

> [!TIP]
> If you're looking for i18n support, check out the [i18n starter](https://github.com/nuxt-themes/docus/tree/main/.starters/i18n).

## ✨ Features

- 🎨 **Beautiful Design** - Clean, modern documentation theme
- 📱 **Responsive** - Mobile-first responsive design
- 🌙 **Dark Mode** - Built-in dark/light mode support
- 🔍 **Search** - Full-text search functionality
- 📝 **Markdown Enhanced** - Extended markdown with custom components
- 🎨 **Customizable** - Easy theming and brand customization
- ⚡ **Fast** - Optimized for performance with Nuxt 4
- 🔧 **TypeScript** - Full TypeScript support

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Your documentation site will be running at `http://localhost:3000`

## 📁 Project Structure

```
my-docs/
├── content/              # Your markdown content
│   ├── index.md         # Homepage
│   ├── 1.getting-started/  # Getting started section
│   └── 2.essentials/    # Essential documentation
├── public/              # Static assets
└── package.json         # Dependencies and scripts
```

## ⚡ Built with

This starter comes pre-configured with:

- [Nuxt 4](https://nuxt.com) - The web framework
- [Nuxt Content](https://content.nuxt.com/) - File-based CMS
- [Nuxt UI](https://ui.nuxt.com) - UI components
- [Nuxt Image](https://image.nuxt.com/) - Optimized images
- [Tailwind CSS 4](https://tailwindcss.com/) - Utility-first CSS
- [Docus Layer](https://www.npmjs.com/package/docus) - Documentation theme

## 📖 Documentation

For detailed documentation on customizing your Docus project, visit the [Docus Documentation](https://docus.dev)

## Cloudflare deployment

The site is a static Nuxt build deployed with Cloudflare Workers Static Assets at `https://wskit.dev`.

From the repository root, run the local Worker preview with:

```bash
pnpm --filter @wskit/website run preview
```

For Cloudflare Workers Builds, configure the `wskit` Worker with:

- Root directory: `website`
- Build command: `pnpm install && pnpm run generate`
- Deploy command: `pnpm exec wrangler deploy`
- Non-production deploy command: `pnpm exec wrangler versions upload`
- Build variables: `NODE_VERSION=24` and `PNPM_VERSION=11.25.0`

`wrangler.jsonc` uploads `.output/public` as static assets. Once the `wskit.dev` zone is active in Cloudflare, attach the apex domain to the Worker.

Use Cloudflare Web Analytics automatic setup for the proxied zone. Do not set `NUXT_PUBLIC_CF_BEACON_TOKEN`, which is only for a manual beacon installation.

## 📄 License

[MIT License](https://opensource.org/licenses/MIT)
