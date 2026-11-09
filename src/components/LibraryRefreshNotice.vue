<script setup>
import { t } from '../i18n/index.js'
import { REFRESH_ORIGIN } from '../storage/libraryRefresh.js'

// Nicht-blockierender Hinweis: Lernen, Resume und Prüfungsmodus bleiben uneingeschränkt nutzbar.
defineProps({
  ageDays: { type: Number, required: true },
  // Echter Refresh ('import') oder nur Beobachtungsbeginn ('baseline'): ohne bekanntes Aktualisierungsdatum keine Behauptung dazu.
  origin: { type: String, default: REFRESH_ORIGIN.IMPORT },
})

defineEmits(['update-now', 'later'])
</script>

<template>
  <section class="library-refresh-notice" :aria-label="t('refresh.title')">
    <h2>{{ t('refresh.title') }}</h2>
    <p>{{ t(origin === REFRESH_ORIGIN.IMPORT ? 'refresh.text' : 'refresh.textUnknown', { count: ageDays }) }}</p>
    <div class="library-refresh-actions">
      <button class="primary-button" type="button" data-refresh="update" @click="$emit('update-now')">
        {{ t('refresh.updateNow') }}
      </button>
      <button class="secondary-button" type="button" data-refresh="later" @click="$emit('later')">
        {{ t('refresh.later') }}
      </button>
    </div>
  </section>
</template>
