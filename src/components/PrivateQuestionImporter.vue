<script setup>
import { parseQuestionFile } from '../lib/library/parseLibrary.js'
import { msg, t } from '../i18n/index.js'

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
    // Übersetzbare Fehler (Parser, Ersetzungsliste) behalten ihren Schlüssel; JSON-Syntaxfehler werden verpackt.
    const message = error.i18n
      ? error.i18n
      : error.issueItems
        ? msg('result.retiredInvalid', { issues: error.issueItems.slice(0, 3) })
        : error instanceof SyntaxError
          ? msg('import.invalidJson', { detail: error.message })
          : error.message

    return { fileName: file.name, kind: 'invalid', error: message }
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
  <section class="import-card" :aria-label="t('import.cardLabel')">
    <div>
      <h2>{{ empty ? t('import.title.empty') : t('import.title') }}</h2>
      <p>{{ t('import.text') }}</p>
    </div>

    <label class="import-button">
      {{ empty ? t('import.button.empty') : t('import.button') }}
      <input
        type="file"
        accept=".json,application/json"
        multiple
        @change="handleFileChange"
      />
    </label>
  </section>
</template>
