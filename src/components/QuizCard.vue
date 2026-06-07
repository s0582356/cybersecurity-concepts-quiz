<script setup>
import AnswerOption from './AnswerOption.vue'

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
        Richtig.
      </p>
      <p v-else class="feedback-wrong">
        Nicht ganz. Die richtige Antwort ist:
        <strong>{{ question.correctAnswer }}</strong>
      </p>

      <p class="explanation">
        {{ question.explanation }}
      </p>

      <button
        v-if="!isLastQuestion"
        class="primary-button"
        type="button"
        @click="emit('next-question')"
      >
        Nächste Frage
      </button>

      <button
        v-else
        class="primary-button"
        type="button"
        @click="emit('restart-quiz')"
      >
        Quiz neu starten
      </button>
    </div>
  </section>
</template>
