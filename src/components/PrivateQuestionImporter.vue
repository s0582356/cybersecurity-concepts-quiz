<script setup>
import { parseQuestionFile } from '../lib/library/parseLibrary.js'

const emit = defineEmits(['questions-loaded'])

const handleFileChange = async (event) => {
  const file = event.target.files?.[0]

  if (!file) {
    return
  }

  try {
    const fileContent = await file.text()
    const parsedData = JSON.parse(fileContent)
    const { questions, library } = parseQuestionFile(parsedData)

    emit('questions-loaded', {
      questions,
      library,
      fileName: file.name,
    })

    event.target.value = ''
  } catch (error) {
    alert(`Import fehlgeschlagen: ${error.message}`)
    event.target.value = ''
  }
}
</script>

<template>
  <section class="import-card" aria-label="Private Fragebank importieren">
    <div>
      <h2>Private Fragebank lokal laden</h2>
      <p>
        Wähle eine lokale JSON-Datei aus. Die Datei wird nur im Browser gelesen
        und nicht hochgeladen. Bei V2-Bibliotheken speichert der Browser nur
        Fortschrittsdaten (Frage-IDs und Ergebnisse), nie die Fragen selbst.
      </p>
    </div>

    <label class="import-button">
      Private JSON auswählen
      <input
        type="file"
        accept=".json,application/json"
        @change="handleFileChange"
      />
    </label>
  </section>
</template>
