<script setup>
import { t } from '../i18n/index.js'

defineProps({
  currentQuestionIndex: {
    type: Number,
    required: true,
  },
  totalQuestions: {
    type: Number,
    required: true,
  },
  score: {
    type: Number,
    required: true,
  },
  currentStreak: {
    type: Number,
    required: true,
  },
  bestStreak: {
    type: Number,
    required: true,
  },
})
</script>

<template>
  <aside class="score-card">
    <h2>{{ t('score.title') }}</h2>
    <p>
      {{ t('score.position', { current: currentQuestionIndex + 1, total: totalQuestions }) }}
    </p>
    <p>
      {{ t('score.score') }} <strong>{{ score }}</strong>
    </p>
    <p>
      {{ t('score.streak') }} <strong>{{ currentStreak }}</strong>
    </p>
    <p>
      {{ t('score.best') }} <strong>{{ bestStreak }}</strong>
    </p>
  </aside>
</template>
