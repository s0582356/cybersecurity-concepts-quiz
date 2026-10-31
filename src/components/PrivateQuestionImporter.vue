<script setup>
import { parseQuestionFile } from '../lib/library/parseLibrary.js'

defineProps({
  // Ohne importierte Bibliothek: Hinweis und Button entsprechend beschriften.
  empty: { type: Boolean, default: false },
})

const emit = defineEmits(['files-loaded'])

// Jede Datei wird einzeln gelesen und geprüft; ein Fehler betrifft nur diese Datei.
async function readEntry(file) {
  try {
    const parsed = parseQuestionFile(JSON.parse(await file.text()))

    if (parsed.retiredIndex) {
      return { fileName: file.name, kind: 'retiredIndex', retiredIndex: parsed.retiredIndex }
    }

    if (parsed.format === 'v1') {
      return { fileName: file.name, kind: 'v1', questions: parsed.questions }
    }

    return { fileName: file.name, kind: 'v2', library: parsed.library, questions: parsed.questions }
  } catch (error) {
    return { fileName: file.name, kind: 'invalid', error: error.message }
  }
}

const handleFileChange = async (event) => {
  const files = [...(event.target.files ?? [])]

  if (files.length === 0) {
    return
  }

  const entries = []

  for (const file of files) {
    entries.push(await readEntry(file))
  }

  event.target.value = ''
  emit('files-loaded', entries)
}
</script>

<template>
  <section class="import-card" aria-label="Private Fragebank importieren">
    <div>
      <h2>{{ empty ? 'Noch keine Lernbibliotheken importiert.' : 'Security+ Bibliothek' }}</h2>
      <p>
        Wähle eine oder mehrere lokale JSON-Dateien aus (z. B. alle Bibliotheken auf einmal).
        Die Dateien werden nur im Browser gelesen und nicht hochgeladen. Die App erkennt
        Bibliothek und Lernabschnitt selbst und merkt sie sich lokal in diesem Browser
        (Fragen, Fortschritt und Lernrunden); bei späteren Besuchen musst du nichts erneut
        auswählen. Hier kann auch die Ersetzungsliste (retired-index.json) geladen werden.
      </p>
    </div>

    <label class="import-button">
      {{ empty ? 'JSON-Bibliotheken auswählen' : 'Bibliotheken importieren' }}
      <input
        type="file"
        accept=".json,application/json"
        multiple
        @change="handleFileChange"
      />
    </label>
  </section>
</template>
