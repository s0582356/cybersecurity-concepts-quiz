<script setup>
import { nextTick, onMounted, ref } from 'vue'
import { t } from '../i18n/index.js'
import { trapTabFocus } from './dialogFocus.js'

// Bestätigung vor dem Verwerfen einer laufenden Prüfung (Phase 3D). Modal wie der Abgabe-Dialog:
// Fokus in den Dialog, Tab bleibt im Dialog, Escape bricht ab (die Prüfung bleibt unverändert).
const props = defineProps({
  discarding: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'cancel'])

const panel = ref(null)

onMounted(async () => {
  await nextTick()
  panel.value?.focus()
})

function onKeydown(event) {
  if (event.key === 'Escape' && !props.discarding) {
    emit('cancel')
  } else if (event.key === 'Tab') {
    trapTabFocus(event, panel.value)
  }
}
</script>

<template>
  <section
    ref="panel"
    class="exam-dialog"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="exam-discard-title"
    aria-describedby="exam-discard-text"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <h3 id="exam-discard-title">{{ t('exam.discard.title') }}</h3>
    <p id="exam-discard-text" class="exam-warning">{{ t('exam.discard.warning') }}</p>

    <div class="exam-actions">
      <button class="secondary-button" type="button" data-exam="discard-cancel" :disabled="discarding" @click="emit('cancel')">
        {{ t('exam.discard.cancel') }}
      </button>
      <button class="primary-button" type="button" data-exam="discard-confirm" :disabled="discarding" @click="emit('confirm')">
        {{ discarding ? t('exam.discard.discarding') : t('exam.discard.confirm') }}
      </button>
    </div>
  </section>
</template>
