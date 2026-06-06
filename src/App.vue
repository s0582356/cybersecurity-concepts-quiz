<script setup>
import { computed, ref } from 'vue'
import questions from './data/public/sampleQuestions.json'

const currentQuestionIndex = ref(0)
const selectedAnswer = ref(null)
const isAnswered = ref(false)
const score = ref(0)

const totalQuestions = computed(() => questions.length)

const currentQuestion = computed(() => {
  return questions[currentQuestionIndex.value]
})

const isLastQuestion = computed(() => {
  return currentQuestionIndex.value === totalQuestions.value - 1
})

function selectAnswer(option) {
  if (isAnswered.value) {
    return
  }

  selectedAnswer.value = option
  isAnswered.value = true

  if (option === currentQuestion.value.correctAnswer) {
    score.value++
  }
}

function nextQuestion() {
  if (isLastQuestion.value) {
    return
  }

  currentQuestionIndex.value++
  selectedAnswer.value = null
  isAnswered.value = false
}

function restartQuiz() {
  currentQuestionIndex.value = 0
  selectedAnswer.value = null
  isAnswered.value = false
  score.value = 0
}

function getAnswerClass(option) {
  if (!isAnswered.value) {
    return ''
  }

  if (option === currentQuestion.value.correctAnswer) {
    return 'answer-correct'
  }

  if (option === selectedAnswer.value) {
    return 'answer-wrong'
  }

  return 'answer-muted'
}
</script>

<template>
  <main class="app-shell">
    <section class="hero-section">
      <p class="eyebrow">Cybersecurity Concepts Quiz</p>
      <h1>Trainiere wichtige Security-Grundlagen</h1>
      <p class="intro">
        Eine kleine Vue.js-Lern-App mit neutralen Beispiel-Fragen zu allgemeinen
        Cybersecurity-Konzepten.
      </p>
    </section>

    <section v-if="currentQuestion" class="quiz-layout">
      <aside class="score-card">
        <h2>Fortschritt</h2>
        <p>
          Frage {{ currentQuestionIndex + 1 }} von {{ totalQuestions }}
        </p>
        <p>
          Score: <strong>{{ score }}</strong>
        </p>
      </aside>

      <section class="question-card">
        <div class="question-meta">
          <span>{{ currentQuestion.category }}</span>
          <span>{{ currentQuestion.difficulty }}</span>
        </div>

        <h2>{{ currentQuestion.question }}</h2>

        <div class="answers">
          <button
            v-for="option in currentQuestion.options"
            :key="option"
            class="answer-button"
            :class="getAnswerClass(option)"
            type="button"
            :disabled="isAnswered"
            @click="selectAnswer(option)"
          >
            {{ option }}
          </button>
        </div>

        <div v-if="isAnswered" class="feedback-box">
          <p v-if="selectedAnswer === currentQuestion.correctAnswer" class="feedback-correct">
            Richtig.
          </p>
          <p v-else class="feedback-wrong">
            Nicht ganz. Die richtige Antwort ist:
            <strong>{{ currentQuestion.correctAnswer }}</strong>
          </p>

          <p class="explanation">
            {{ currentQuestion.explanation }}
          </p>

          <button
            v-if="!isLastQuestion"
            class="primary-button"
            type="button"
            @click="nextQuestion"
          >
            Nächste Frage
          </button>

          <button
            v-else
            class="primary-button"
            type="button"
            @click="restartQuiz"
          >
            Quiz neu starten
          </button>
        </div>
      </section>
    </section>

    <section v-else class="question-card">
      <h2>Keine Fragen gefunden</h2>
      <p>Bitte prüfe die Datei src/data/public/sampleQuestions.json.</p>
    </section>
  </main>
</template>
