<script setup>
import { computed, ref } from 'vue'
import QuizCard from './components/QuizCard.vue'
import ScoreBox from './components/ScoreBox.vue'
import PrivateQuestionImporter from './components/PrivateQuestionImporter.vue'
import sampleQuestions from './data/public/sampleQuestions.json'

const questions = ref(sampleQuestions)
const questionBankName = ref('Öffentliche Beispiel-Fragen')
const isQuizStarted = ref(false)
const isQuizComplete = ref(false)
const isReviewMode = ref(false)
const originalQuestions = ref(sampleQuestions)
const currentQuestionIndex = ref(0)
const selectedAnswer = ref(null)
const isAnswered = ref(false)
const score = ref(0)
const incorrectlyAnsweredQuestions = ref([])

const totalQuestions = computed(() => questions.value.length)
const wrongAnswerCount = computed(() => totalQuestions.value - score.value)
const scorePercentage = computed(() => {
  if (totalQuestions.value === 0) {
    return 0
  }

  return Math.round((score.value / totalQuestions.value) * 100)
})

const currentQuestion = computed(() => {
  return questions.value[currentQuestionIndex.value]
})

const isLastQuestion = computed(() => {
  return currentQuestionIndex.value === totalQuestions.value - 1
})

const resultMessage = computed(() => {
  if (scorePercentage.value >= 90) {
    return 'Security+ Ready'
  }

  if (scorePercentage.value >= 75) {
    return 'Prüfungsnah – sehr gut'
  }

  if (scorePercentage.value >= 60) {
    return 'Solide Basis – wiederholen lohnt sich'
  }

  return 'Noch unsicher – Fehlerfragen wiederholen'
})

function getQuestionKey(question) {
  return [
    question.id,
    question.category,
    question.difficulty,
    question.question,
  ]
    .filter(Boolean)
    .join('::')
}

function resetQuizProgress({ clearIncorrectAnswers = true } = {}) {
  currentQuestionIndex.value = 0
  selectedAnswer.value = null
  isAnswered.value = false
  score.value = 0
  isQuizComplete.value = false

  if (clearIncorrectAnswers) {
    incorrectlyAnsweredQuestions.value = []
  }
}

function startQuiz() {
  questions.value = originalQuestions.value
  isReviewMode.value = false
  resetQuizProgress()
  isQuizStarted.value = true
}

function selectAnswer(option) {
  if (isAnswered.value) {
    return
  }

  selectedAnswer.value = option
  isAnswered.value = true

  if (option === currentQuestion.value.correctAnswer) {
    score.value++
    return
  }

  const alreadyTracked = incorrectlyAnsweredQuestions.value.some((question) => {
    return getQuestionKey(question) === getQuestionKey(currentQuestion.value)
  })

  if (!alreadyTracked) {
    incorrectlyAnsweredQuestions.value.push(currentQuestion.value)
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

function finishQuiz() {
  isQuizComplete.value = true
}

function restartWithCurrentQuestionBank() {
  questions.value = originalQuestions.value
  isReviewMode.value = false
  resetQuizProgress()
  isQuizStarted.value = true
}

function repeatIncorrectQuestions() {
  if (incorrectlyAnsweredQuestions.value.length === 0) {
    return
  }

  questions.value = [...incorrectlyAnsweredQuestions.value]
  isReviewMode.value = true
  resetQuizProgress()
  isQuizStarted.value = true
}

function loadPrivateQuestions({ questions: importedQuestions, fileName }) {
  questions.value = importedQuestions
  originalQuestions.value = importedQuestions
  questionBankName.value = `Private Fragebank: ${fileName}`
  isReviewMode.value = false
  isQuizStarted.value = false
  resetQuizProgress()
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
      <p class="question-bank-label">{{ questionBankName }}</p>
      <p v-if="isReviewMode" class="review-mode-label">Wiederholung falscher Fragen</p>
    </section>

    <section v-if="!isQuizStarted" class="start-layout" aria-label="Quiz vorbereiten">
      <PrivateQuestionImporter @questions-loaded="loadPrivateQuestions" />

      <section class="start-card">
        <h2>Quiz bereit</h2>
        <p>
          Du kannst mit den öffentlichen Beispiel-Fragen starten oder vorher eine
          private lokale JSON-Fragebank auswählen.
        </p>

        <button class="start-button" type="button" @click="startQuiz">
          Mit aktueller Fragebank starten
        </button>
      </section>
    </section>

    <section v-else-if="isQuizComplete" class="result-card">
      <p class="eyebrow">
        {{ isReviewMode ? 'Wiederholung abgeschlossen' : 'Quiz abgeschlossen' }}
      </p>
      <h2>Auswertung</h2>

      <div class="result-grid" aria-label="Ergebnisübersicht">
        <div>
          <span>Gesamtfragen</span>
          <strong>{{ totalQuestions }}</strong>
        </div>
        <div>
          <span>Richtige Antworten</span>
          <strong>{{ score }}</strong>
        </div>
        <div>
          <span>Falsche Antworten</span>
          <strong>{{ wrongAnswerCount }}</strong>
        </div>
        <div>
          <span>Prozentwert</span>
          <strong>{{ scorePercentage }}%</strong>
        </div>
      </div>

      <p class="result-message">{{ resultMessage }}</p>
      <p v-if="incorrectlyAnsweredQuestions.length === 0" class="perfect-message">
        Perfekt – keine Fehler zum Wiederholen.
      </p>

      <div class="result-actions">
        <button
          v-if="incorrectlyAnsweredQuestions.length > 0"
          class="primary-button"
          type="button"
          @click="repeatIncorrectQuestions"
        >
          Falsche Fragen wiederholen
        </button>
        <button class="secondary-button" type="button" @click="restartWithCurrentQuestionBank">
          Neu starten
        </button>
        <button class="secondary-button" type="button" @click="isQuizStarted = false">
          Andere Fragebank laden
        </button>
      </div>
    </section>

    <section v-else-if="currentQuestion" class="quiz-layout">
      <ScoreBox
        :current-question-index="currentQuestionIndex"
        :total-questions="totalQuestions"
        :score="score"
      />

      <QuizCard
        :question="currentQuestion"
        :selected-answer="selectedAnswer"
        :is-answered="isAnswered"
        :is-last-question="isLastQuestion"
        @select-answer="selectAnswer"
        @next-question="nextQuestion"
        @restart-quiz="finishQuiz"
      />
    </section>

    <section v-else class="question-card">
      <h2>Keine Fragen gefunden</h2>
      <p>Bitte prüfe die Datei src/data/public/sampleQuestions.json.</p>
    </section>

    <footer class="app-footer" aria-label="Projektinformationen">
      <span>Version 0.3.0</span>
      <span>Component refactor</span>
      <a
        href="https://github.com/s0582356/cybersecurity-concepts-quiz"
        target="_blank"
        rel="noreferrer"
      >
        GitHub
      </a>
    </footer>
  </main>
</template>
