<script setup>
import { EXAM_MIN_QUESTIONS } from '../domain/examSelection.js'
import { t } from '../i18n/index.js'

// entry: { state: 'start' | 'resume' | 'damaged' | 'unavailableStorage' | 'unavailablePool', ... } (nur Zahlen)
defineProps({
  entry: { type: Object, required: true },
})

defineEmits(['open'])
</script>

<template>
  <section class="start-card exam-entry" :aria-label="t('exam.entry.label')">
    <p class="eyebrow">{{ t('exam.eyebrow') }}</p>
    <h2>{{ t('exam.title') }}</h2>
    <p>{{ t('exam.intro') }}</p>

    <p v-if="entry.state === 'resume'" class="exam-entry-status">
      {{
        t('exam.entry.running', {
          current: entry.currentIndex + 1,
          total: entry.questionCount,
          answered: entry.answeredCount,
        })
      }}
    </p>
    <p v-else-if="entry.state === 'damaged'" class="exam-entry-status" role="status">{{ t('exam.entry.damaged') }}</p>
    <p v-else-if="entry.state === 'unavailableStorage'" class="exam-entry-status" role="status">
      {{ t('exam.entry.unavailableStorage') }}
    </p>
    <p v-else-if="entry.state === 'unavailablePool'" class="exam-entry-status" role="status">
      {{ t('exam.entry.unavailablePool', { min: EXAM_MIN_QUESTIONS, count: entry.count }) }}
    </p>

    <button
      v-if="entry.state === 'start'"
      class="start-button"
      type="button"
      data-exam="open"
      @click="$emit('open')"
    >
      {{ t('exam.entry.start') }}
    </button>
    <button
      v-else-if="entry.state === 'resume' || entry.state === 'damaged'"
      class="start-button"
      type="button"
      data-exam="open"
      @click="$emit('open')"
    >
      {{ t('exam.entry.resume') }}
    </button>
    <button
      v-else-if="entry.state === 'unavailablePool' && entry.hasResult"
      class="start-button"
      type="button"
      data-exam="open"
      @click="$emit('open')"
    >
      {{ t('exam.entry.open') }}
    </button>
  </section>
</template>
