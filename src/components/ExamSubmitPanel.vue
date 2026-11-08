<script setup>
import { nextTick, onMounted, ref } from 'vue'
import { t } from '../i18n/index.js'

const props = defineProps({
  total: { type: Number, required: true },
  unanswered: { type: Number, required: true },
  submitting: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'cancel', 'goto-first'])

const panel = ref(null)

// Tastatur: Fokus in den Dialog, Escape bricht ab (die Prüfung bleibt unverändert aktiv).
onMounted(async () => {
  await nextTick()
  panel.value?.focus()
})

// Fokusfalle: Tab/Shift+Tab bleiben im Dialog (der Hintergrund ist zusätzlich deaktiviert).
function trapFocus(event) {
  const controls = [...panel.value.querySelectorAll('button:not(:disabled)')]

  if (controls.length === 0) {
    event.preventDefault()
    panel.value.focus()
    return
  }

  const first = controls[0]
  const last = controls[controls.length - 1]
  const inside = panel.value.contains(document.activeElement) && document.activeElement !== panel.value

  if (event.shiftKey && (document.activeElement === first || !inside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
    event.preventDefault()
    first.focus()
  }
}

function onKeydown(event) {
  if (event.key === 'Escape' && !props.submitting) {
    emit('cancel')
  } else if (event.key === 'Tab') {
    trapFocus(event)
  }
}
</script>

<template>
  <section
    ref="panel"
    class="exam-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="exam-submit-title"
    aria-describedby="exam-submit-text"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <h3 id="exam-submit-title">{{ t('exam.submit.title') }}</h3>
    <p v-if="unanswered === 0" id="exam-submit-text">{{ t('exam.submit.allAnswered', { total }) }}</p>
    <p v-else id="exam-submit-text" class="exam-warning" role="alert">
      {{ t('exam.submit.unanswered', { count: unanswered }) }}
    </p>

    <div class="exam-actions">
      <button class="primary-button" type="button" data-exam="confirm" :disabled="submitting" @click="emit('confirm')">
        {{ submitting ? t('exam.submit.submitting') : t('exam.submit.confirm') }}
      </button>
      <button class="secondary-button" type="button" data-exam="cancel" :disabled="submitting" @click="emit('cancel')">
        {{ t('exam.submit.cancel') }}
      </button>
      <button
        v-if="unanswered > 0"
        class="secondary-button"
        type="button"
        data-exam="goto-first"
        :disabled="submitting"
        @click="emit('goto-first')"
      >
        {{ t('exam.submit.gotoFirst') }}
      </button>
    </div>
  </section>
</template>
