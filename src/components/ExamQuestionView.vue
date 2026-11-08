<script setup>
import AnswerOption from './AnswerOption.vue'
import { t } from '../i18n/index.js'

// view: leak-freies Modell aus buildExamView (Frage ohne Lösung/Erklärung/Merkhilfe, nur Zahlen und Auswahl).
const props = defineProps({
  view: { type: Object, required: true },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['select', 'back', 'next', 'submit'])

const question = () => props.view.question
const isFirst = () => props.view.currentIndex === 0
const isLast = () => props.view.currentIndex === props.view.questionCount - 1
</script>

<template>
  <section class="question-card exam-card" :aria-label="t('exam.title')">
    <p class="eyebrow">{{ t('exam.eyebrow') }}</p>
    <h2>{{ t('exam.title') }}</h2>

    <div class="question-meta exam-meta">
      <span class="exam-position">{{ t('exam.active.position', { current: view.currentIndex + 1, total: view.questionCount }) }}</span>
      <span class="exam-answered">{{ t('exam.active.answered', { answered: view.answeredCount, total: view.questionCount }) }}</span>
      <span class="exam-unanswered">{{ t('exam.active.unanswered', { unanswered: view.unansweredCount }) }}</span>
    </div>
    <div
      class="section-progress exam-progress"
      role="progressbar"
      :aria-valuenow="view.answeredCount"
      aria-valuemin="0"
      :aria-valuemax="view.questionCount"
      :aria-label="t('exam.active.progress')"
    >
      <span :style="{ width: `${(view.answeredCount / view.questionCount) * 100}%` }"></span>
    </div>
    <p class="exam-language">{{ t('exam.active.language', { language: t(`exam.language.${view.language}`) }) }}</p>

    <h3 class="exam-question-text">{{ question().text }}</h3>

    <div class="answers exam-options" role="group" :aria-label="t('exam.active.options')">
      <AnswerOption
        v-for="option in question().options"
        :key="option.key"
        class="exam-option"
        :class="{ 'answer-selected': question().selectedKey === option.key }"
        :option="option.text"
        :aria-pressed="question().selectedKey === option.key"
        :is-disabled="busy"
        :data-option-key="option.key"
        @select="emit('select', option.key)"
      />
    </div>
    <p class="exam-selection-status" role="status">
      {{ question().selectedKey ? t('exam.active.selectedHint') : t('exam.active.noneSelected') }}
    </p>

    <nav class="exam-nav" :aria-label="t('exam.nav.label')">
      <button class="secondary-button" type="button" data-exam="back" :disabled="busy || isFirst()" @click="emit('back')">
        {{ t('exam.nav.back') }}
      </button>
      <button class="secondary-button" type="button" data-exam="next" :disabled="busy || isLast()" @click="emit('next')">
        {{ t('exam.nav.next') }}
      </button>
      <button class="primary-button exam-submit" type="button" data-exam="submit" :disabled="busy" @click="emit('submit')">
        {{ t('exam.nav.submit') }}
      </button>
    </nav>
  </section>
</template>
