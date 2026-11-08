<script setup>
import { nextTick, onMounted, ref } from 'vue'
import { t } from '../i18n/index.js'

// result: unverändert aus attempt.result (Exam-Core); die UI rechnet nichts nach.
defineProps({
  result: { type: Object, required: true },
  language: { type: String, required: true },
  // Phase 3D: Ergebnis wurde über "Letztes Ergebnis ansehen" geöffnet (nur ein Hinweis, keine andere Datenquelle).
  isLast: { type: Boolean, default: false },
})

defineEmits(['new-exam', 'close', 'review'])

const heading = ref(null)

// Nach der Abgabe landet der Fokus auf der Ergebnis-Überschrift (der Dialog ist verschwunden).
onMounted(async () => {
  await nextTick()
  heading.value?.focus()
})
</script>

<template>
  <section class="result-card exam-result" :aria-label="t('exam.result.label')">
    <p class="eyebrow">{{ t('exam.eyebrow') }}</p>
    <h2 ref="heading" tabindex="-1">{{ t('exam.result.title') }}</h2>
    <p v-if="isLast" class="exam-last-badge" data-exam-last>{{ t('exam.result.last') }}</p>

    <div class="result-grid">
      <div>
        <span>{{ t('exam.result.total') }}</span>
        <strong data-result="total">{{ result.total }}</strong>
      </div>
      <div>
        <span>{{ t('exam.result.correct') }}</span>
        <strong data-result="correct">{{ result.correct }}</strong>
      </div>
      <div>
        <span>{{ t('exam.result.incorrect') }}</span>
        <strong data-result="incorrect">{{ result.incorrect }}</strong>
      </div>
      <div>
        <span>{{ t('exam.result.unanswered') }}</span>
        <strong data-result="unanswered">{{ result.unanswered }}</strong>
      </div>
      <div>
        <span>{{ t('exam.result.percent') }}</span>
        <strong data-result="percent">{{ t('exam.result.percentValue', { percent: result.percent }) }}</strong>
      </div>
    </div>

    <p class="result-message">{{ t('exam.result.note', { language: t(`exam.language.${language}`) }) }}</p>

    <div class="result-actions">
      <button class="primary-button" type="button" data-exam="review" @click="$emit('review')">
        {{ t('exam.review.start') }}
      </button>
      <button class="secondary-button" type="button" data-exam="new" @click="$emit('new-exam')">
        {{ t('exam.result.new') }}
      </button>
      <button class="secondary-button" type="button" data-exam="close" @click="$emit('close')">
        {{ t('exam.result.overview') }}
      </button>
    </div>
  </section>
</template>
