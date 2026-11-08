<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { sectionNumber } from '../domain/libraryCatalog.js'
import { t } from '../i18n/index.js'

// review: Modell aus buildExamReview (nur aus dem gespeicherten, abgegebenen Versuch). Die Ansicht ist read-only:
// keine Antwort-, Wertungs- oder Schreibaktion, nur Navigation durch die Fragen.
const props = defineProps({
  review: { type: Object, required: true },
})

const emit = defineEmits(['back'])

const SYMBOLS = { correct: '✓', incorrect: '✗', unanswered: '–' }

const heading = ref(null)
const questionHeading = ref(null)
const index = ref(0)

const item = computed(() => props.review.items[index.value])
const isFirst = computed(() => index.value === 0)
const isLast = computed(() => index.value === props.review.questionCount - 1)

onMounted(async () => {
  await nextTick()
  heading.value?.focus()
})

// Wird die gedrückte Schaltfläche an der Grenze deaktiviert, würde der Fokus auf <body> fallen: dann auf die Frage.
async function go(delta) {
  index.value += delta
  await nextTick()

  if (document.activeElement === document.body || document.activeElement?.disabled) {
    questionHeading.value?.focus()
  }
}
</script>

<template>
  <section class="question-card exam-card exam-review" :aria-label="t('exam.review.label')">
    <p class="eyebrow">{{ t('exam.eyebrow') }}</p>
    <h2 ref="heading" tabindex="-1">{{ t('exam.review.title') }}</h2>
    <p class="exam-language">{{ t('exam.review.language', { language: t(`exam.language.${review.language}`) }) }}</p>
    <p class="exam-selection-status">{{ t('exam.review.readOnly') }}</p>

    <div class="question-meta exam-meta">
      <span class="exam-position" role="status">
        {{ t('exam.review.position', { current: index + 1, total: review.questionCount }) }}
      </span>
      <span class="exam-review-section">{{ t('section.label', { id: sectionNumber(item.sectionId) }) }}</span>
    </div>

    <p class="exam-review-status" :class="`review-status-${item.status}`" :data-review-status="item.status">
      <span aria-hidden="true">{{ SYMBOLS[item.status] }}</span>
      {{ t(`exam.review.status.${item.status}`) }}
    </p>

    <h3 ref="questionHeading" class="exam-question-text" tabindex="-1">{{ item.text }}</h3>

    <ul class="answers exam-review-options" :aria-label="t('exam.review.options')">
      <li
        v-for="option in item.options"
        :key="option.key"
        class="exam-review-option"
        :class="{
          'review-option-correct': option.correct,
          'review-option-wrong': option.selected && !option.correct,
          'review-option-selected': option.selected,
        }"
        :data-option-key="option.key"
      >
        <span class="exam-review-option-text">{{ option.text }}</span>
        <span v-if="option.selected" class="exam-review-tag" data-tag="selected">{{ t('exam.review.yourAnswer') }}</span>
        <span v-if="option.correct" class="exam-review-tag" data-tag="correct">{{ t('exam.review.correctAnswer') }}</span>
      </li>
    </ul>

    <p v-if="item.status === 'unanswered'" class="exam-warning exam-review-noanswer" role="status">
      {{ t('exam.review.noAnswer') }}
    </p>

    <div class="feedback-box exam-review-feedback">
      <h4>{{ t('exam.review.explanation') }}</h4>
      <p class="explanation" data-review="explanation">{{ item.explanation }}</p>

      <p v-if="item.memoryAid" class="memory-aid" data-review="memory-aid" :data-memory-aid-type="item.memoryAid.type ?? ''">
        <strong>{{ t('exam.review.memoryAid') }}</strong> {{ item.memoryAid.text }}
      </p>
    </div>

    <nav class="exam-nav" :aria-label="t('exam.review.nav')">
      <button class="secondary-button" type="button" data-exam="review-back" :disabled="isFirst" @click="go(-1)">
        {{ t('exam.nav.back') }}
      </button>
      <button class="secondary-button" type="button" data-exam="review-next" :disabled="isLast" @click="go(1)">
        {{ t('exam.nav.next') }}
      </button>
      <button class="primary-button exam-submit" type="button" data-exam="review-result" @click="emit('back')">
        {{ t('exam.review.backToResult') }}
      </button>
    </nav>
  </section>
</template>
