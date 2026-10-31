<script setup>
import AnswerOption from './AnswerOption.vue'
import { t } from '../i18n/index.js'

const props = defineProps({
  question: {
    type: Object,
    required: true,
  },
  selectedAnswer: {
    type: String,
    default: null,
  },
  isAnswered: {
    type: Boolean,
    required: true,
  },
  isLastQuestion: {
    type: Boolean,
    required: true,
  },
})

const emit = defineEmits(['select-answer', 'next-question', 'restart-quiz'])

function getAnswerClass(option) {
  if (!props.isAnswered) {
    return ''
  }

  if (option === props.question.correctAnswer) {
    return 'answer-correct'
  }

  if (option === props.selectedAnswer) {
    return 'answer-wrong'
  }

  return 'answer-muted'
}
</script>

<template>
  <section class="question-card">
    <div class="question-meta">
      <span>{{ question.category }}</span>
      <span>{{ question.difficulty }}</span>
    </div>

    <p v-if="question.languageFallback" class="language-fallback-badge">{{ t('language.fallbackBadge') }}</p>

    <h2>{{ question.question }}</h2>

    <div class="answers">
      <AnswerOption
        v-for="option in question.options"
        :key="option"
        :option="option"
        :answer-class="getAnswerClass(option)"
        :is-disabled="isAnswered"
        @select="emit('select-answer', option)"
      />
    </div>

    <div v-if="isAnswered" class="feedback-box">
      <p v-if="selectedAnswer === question.correctAnswer" class="feedback-correct">
        {{ t('quiz.correct') }}
      </p>
      <p v-else class="feedback-wrong">
        {{ t('quiz.wrong') }}
        <strong>{{ question.correctAnswer }}</strong>
      </p>

      <p class="explanation">
        {{ question.explanation }}
      </p>

      <p v-if="question.memoryAid?.text" class="memory-aid">
        <strong>{{ t('quiz.memoryAid') }}:</strong> {{ question.memoryAid.text }}
      </p>

      <button
        v-if="!isLastQuestion"
        class="primary-button"
        type="button"
        @click="emit('next-question')"
      >
        {{ t('quiz.next') }}
      </button>

      <button
        v-else
        class="primary-button"
        type="button"
        @click="emit('restart-quiz')"
      >
        {{ t('quiz.finish') }}
      </button>
    </div>
  </section>
</template>
