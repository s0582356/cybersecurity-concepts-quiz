<script setup>
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
})
</script>

<template>
  <aside class="score-card">
    <h2>Fortschritt</h2>
    <p>
      Frage {{ currentQuestionIndex + 1 }} von {{ totalQuestions }}
    </p>
    <p>
      Score: <strong>{{ score }}</strong>
    </p>
  </aside>
</template>
