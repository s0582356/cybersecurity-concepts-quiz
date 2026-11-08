<script setup>
import { ref } from 'vue'
import { EXAM_MIN_QUESTIONS, EXAM_PRESETS } from '../domain/examSelection.js'
import { t } from '../i18n/index.js'

// info: { pool: { de, en }, counts: { de: { short, medium, long }, en: { ... } } } – Zahlen aus dem Exam-Core
// (Trockenlauf von createExamAttempt); die UI rechnet selbst nichts aus.
const props = defineProps({
  info: { type: Object, required: true },
  defaultLanguage: { type: String, default: 'de' },
  busy: { type: Boolean, default: false },
  // Phase 3D: { examSessionId, completedAt } des letzten abgegebenen Versuchs oder null (kein Ergebnis -> kein Button).
  lastResult: { type: Object, default: null },
})

const emit = defineEmits(['start', 'close', 'last-result'])

const PRESETS = Object.keys(EXAM_PRESETS)
const LANGUAGES = ['de', 'en']

const language = ref(LANGUAGES.includes(props.defaultLanguage) ? props.defaultLanguage : 'de')
const preset = ref('medium')

const countOf = (name) => props.info.counts[language.value][name]
const startable = () => !props.busy && countOf(preset.value) > 0
const capped = () => PRESETS.some((name) => countOf(name) > 0 && countOf(name) < EXAM_PRESETS[name])
</script>

<template>
  <section class="start-card exam-start" :aria-label="t('exam.title')">
    <p class="eyebrow">{{ t('exam.eyebrow') }}</p>
    <h2 tabindex="-1">{{ t('exam.title') }}</h2>
    <p>{{ t('exam.intro') }}</p>

    <h3>{{ t('exam.start.presets') }}</h3>
    <div class="language-options exam-presets" role="group" :aria-label="t('exam.start.presets')">
      <button
        v-for="name in PRESETS"
        :key="name"
        class="language-option"
        :class="{ 'language-option-active': preset === name }"
        type="button"
        :data-preset="name"
        :aria-pressed="preset === name"
        :disabled="countOf(name) === 0"
        @click="preset = name"
      >
        {{ t(`exam.preset.${name}`, { count: countOf(name) || EXAM_PRESETS[name] }) }}
      </button>
    </div>
    <p v-if="capped()" class="language-preview">{{ t('exam.start.capped', { pool: info.pool[language] }) }}</p>

    <h3>{{ t('exam.start.language') }}</h3>
    <div class="language-options exam-languages" role="group" :aria-label="t('exam.start.language')">
      <button
        v-for="code in LANGUAGES"
        :key="code"
        class="language-option"
        :class="{ 'language-option-active': language === code }"
        type="button"
        :data-language="code"
        :aria-pressed="language === code"
        @click="language = code"
      >
        {{ t(`exam.language.${code}`) }}
      </button>
    </div>
    <p class="exam-pool-info">{{ t('exam.start.available', { pool: info.pool[language] }) }}</p>
    <p v-if="info.pool[language] < EXAM_MIN_QUESTIONS" class="language-preview" role="status">
      {{ t('exam.start.tooFew', { min: EXAM_MIN_QUESTIONS }) }}
    </p>
    <p class="exam-language-fixed">{{ t('exam.start.languageFixed') }}</p>

    <div class="exam-actions">
      <button
        class="start-button"
        type="button"
        data-exam="start"
        :disabled="!startable()"
        @click="emit('start', { language, preset })"
      >
        {{ busy ? t('exam.start.starting') : t('exam.start.button') }}
      </button>
      <button
        v-if="lastResult"
        class="secondary-button"
        type="button"
        data-exam="last-result"
        :disabled="busy"
        @click="emit('last-result', lastResult.examSessionId)"
      >
        {{ t('exam.start.lastResult') }}
      </button>
      <button class="secondary-button" type="button" data-exam="close" @click="emit('close')">
        {{ t('exam.close') }}
      </button>
    </div>
  </section>
</template>
