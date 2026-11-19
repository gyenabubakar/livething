<script setup lang="ts">
import type { NuxtError } from '#app'
import type { ContentNavigationItem, PageCollections } from '@nuxt/content'
import * as nuxtUiLocales from '@nuxt/ui/locale'

// Overrides Docus's error.vue. The stock version renders <AppHeader /> bare
// inside <UApp>, which drops the flex wrapper the normal layout (app.vue) gives
// the header — so on a 404 the header/sub-navigation lose their width container
// and the borders and padding break. This restores that wrapper (and the
// sub-header height) so the error page's header matches every other page.

const props = defineProps<{
  error: NuxtError
}>()

const { locale, locales, isEnabled, t, switchLocalePath } = useDocusI18n()

const nuxtUiLocale = computed(() => nuxtUiLocales[locale.value as keyof typeof nuxtUiLocales] || nuxtUiLocales.en)
const lang = computed(() => nuxtUiLocale.value.code)
const dir = computed(() => nuxtUiLocale.value.dir)

useHead({
  htmlAttrs: {
    lang,
    dir,
  },
})

const localizedError = computed(() => {
  return {
    ...props.error,
    statusMessage: t('common.error.title'),
    message: t('common.error.description'),
  }
})

useSeoMeta({
  title: () => t('common.error.title'),
  description: () => t('common.error.description'),
})

if (isEnabled.value) {
  const route = useRoute()
  const defaultLocale = useRuntimeConfig().public.i18n.defaultLocale!
  onMounted(() => {
    const currentLocale = route.path.split('/')[1]
    if (!locales.some(locale => locale.code === currentLocale)) {
      return navigateTo(switchLocalePath(defaultLocale) as string)
    }
  })
}

const collectionName = computed(() => isEnabled.value ? `docs_${locale.value}` : 'docs')

const { data: fullNavigation } = await useAsyncData(`navigation_${collectionName.value}`, () => queryCollectionNavigation(collectionName.value as keyof PageCollections), {
  transform: (data: ContentNavigationItem[]) => transformNavigation(data, isEnabled.value, locale.value),
  watch: [locale],
})

// Same scoping as app.vue: the header shows the sections of the track the missing page is in.
const errorRoute = useRoute()
const navigation = computed(() => trackNavigation(fullNavigation.value, errorRoute.path))

provide('navigation', navigation)

const { subNavigationMode } = useSubNavigation(navigation)
</script>

<template>
  <UApp :locale="nuxtUiLocale">
    <div class="flex">
      <div
        class="flex-1 min-w-0"
        :class="{ 'docus-sub-header': subNavigationMode === 'header' }"
      >
        <AppHeader v-if="$route.meta.header !== false" />

        <UError :error="localizedError" />

        <AppFooter v-if="$route.meta.footer !== false" />

        <ClientOnly>
          <AppSearch :navigation="fullNavigation ?? undefined" />
        </ClientOnly>
      </div>
    </div>
  </UApp>
</template>

<style>
@media (min-width: 1024px) {
  .docus-sub-header {
    /* 64px base header + 48px sub-navigation bar — matches app.vue */
    --ui-header-height: 112px;
  }
}
</style>
