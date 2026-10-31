<script setup>
defineProps({
  sections: { type: Array, required: true },
  selectedSectionId: { type: String, default: null },
})

defineEmits(['open-section'])
</script>

<template>
  <section v-if="sections.length > 0" class="section-overview" aria-label="Lernabschnitte">
    <article
      v-for="section in sections"
      :key="section.sectionId"
      class="section-card"
      :class="{ 'section-card-selected': section.sectionId === selectedSectionId }"
    >
      <h3>{{ section.label }}</h3>
      <p>{{ section.libraryCount }} {{ section.libraryCount === 1 ? 'Library' : 'Libraries' }}</p>
      <p>{{ section.questionCount }} Fragen</p>
      <p>{{ section.answeredCount }} beantwortet · {{ section.openCount }} offen</p>
      <div
        class="section-progress"
        role="progressbar"
        :aria-valuenow="section.percent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`${section.label}: ${section.percent} % beantwortet`"
      >
        <span :style="{ width: `${section.percent}%` }"></span>
      </div>
      <p class="section-percent">{{ section.percent }} %</p>
      <p class="section-resume">Resume: {{ section.hasResume ? 'Ja' : 'Nein' }}</p>
      <button class="start-button" type="button" @click="$emit('open-section', section.sectionId)">
        {{ section.hasResume ? 'Weiterlernen' : 'Lernen' }}
      </button>
    </article>
  </section>
</template>
