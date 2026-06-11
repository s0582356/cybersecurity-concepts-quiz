<script setup>
const emit = defineEmits(['questions-loaded'])

const validateQuestions = (data) => {
  if (!Array.isArray(data)) {
    throw new Error('Die JSON-Datei muss ein Array von Fragen enthalten.')
  }

  if (data.length === 0) {
    throw new Error('Die JSON-Datei enthält keine Fragen.')
  }

  data.forEach((question, index) => {
    if (!question.question || typeof question.question !== 'string') {
      throw new Error(`Frage ${index + 1}: "question" fehlt oder ist ungültig.`)
    }

    if (!Array.isArray(question.options) || question.options.length < 2) {
      throw new Error(`Frage ${index + 1}: "options" muss mindestens zwei Antworten enthalten.`)
    }

    if (!question.correctAnswer || typeof question.correctAnswer !== 'string') {
      throw new Error(`Frage ${index + 1}: "correctAnswer" fehlt oder ist ungültig.`)
    }

    if (!question.options.includes(question.correctAnswer)) {
      throw new Error(`Frage ${index + 1}: "correctAnswer" muss in "options" enthalten sein.`)
    }

    if (!question.explanation || typeof question.explanation !== 'string') {
      throw new Error(`Frage ${index + 1}: "explanation" fehlt oder ist ungültig.`)
    }
  })

  return data.map((question, index) => ({
    id: question.id ?? index + 1,
    question: question.question,
    options: question.options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
  }))
}

const handleFileChange = async (event) => {
  const file = event.target.files?.[0]

  if (!file) {
    return
  }

  try {
    const fileContent = await file.text()
    const parsedData = JSON.parse(fileContent)
    const validatedQuestions = validateQuestions(parsedData)

    emit('questions-loaded', {
      questions: validatedQuestions,
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
        Wähle eine lokale JSON-Datei aus. Die Datei wird nur im Browser gelesen,
        nicht hochgeladen und nicht gespeichert.
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
