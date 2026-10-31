<script setup>
import { t } from '../i18n/index.js'

defineProps({
  sections: { type: Array, required: true },
  selectedSectionId: { type: String, default: null },
})

defineEmits(['open-section'])
</script>

<template>
  <section v-if="sections.length > 0" class="section-overview" :aria-label="t('section.overview')">
    <article
      v-for="section in sections"
      :key="section.sectionId"
      class="section-card"
      :class="{ 'section-card-selected': section.sectionId === selectedSectionId }"
    >
      <h3>{{ t(section.label) }}</h3>
      <p>{{ t('section.libraries', { count: section.libraryCount }) }}</p>
      <p>{{ t('section.questions', { count: section.questionCount }) }}</p>
      <p>{{ t('section.answeredOpen', { answered: section.answeredCount, open: section.openCount }) }}</p>
      <div
        class="section-progress"
        role="progressbar"
        :aria-valuenow="section.percent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="t('section.progressLabel', { label: t(section.label), percent: section.percent })"
      >
        <span :style="{ width: `${section.percent}%` }"></span>
      </div>
      <p class="section-percent">{{ t('section.percent', { percent: section.percent }) }}</p>
      <p class="section-resume">
        {{ t('section.resume', { state: t(section.hasResume ? 'section.resume.yes' : 'section.resume.no') }) }}
      </p>
      <p class="section-languages">
        {{ t('section.language.de') }}<template v-if="section.englishComplete"> · {{ t('section.language.enComplete') }}</template
        ><template v-else-if="section.englishCount > 0"> · {{ t('section.language.enPartial', { en: section.englishCount, total: section.questionCount }) }}</template>
      </p>
      <button class="start-button" type="button" @click="$emit('open-section', section.sectionId)">
        {{ t(section.hasResume ? 'section.continue' : 'section.learn') }}
      </button>
    </article>
  </section>
</template>
