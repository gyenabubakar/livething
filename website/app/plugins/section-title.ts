// Pages share names across sections (`http()`, `keepalive`, `Channels`), so the title names the section.
const SECTIONS: Record<string, string> = {
  server: 'Server',
  runtimes: 'Server',
  client: 'Client',
  core: 'Core',
}

export default defineNuxtPlugin(() => {
  const route = useRoute()
  useHead(
    {
      titleTemplate: (title) => {
        if (!title) return 'LiveThing'
        // The landing page's title already names LiveThing.
        if (route.path === '/') return title
        const section = SECTIONS[route.path.split('/')[1] ?? '']
        return section ? `${title} - ${section} - LiveThing` : `${title} - LiveThing`
      },
    },
    { tagPriority: 'high' },
  )
})
