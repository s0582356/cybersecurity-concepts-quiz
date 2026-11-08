<script setup>
// Container des Prüfungsmodus (Phase 3C). Arbeitet ausschließlich über Exam-Core/-Service und den Store `examAttempts`;
// kein Lernmodus-Handler, kein Schreiben von Progress/Sessions.
//
// Der gespeicherte Versuch (enthält Snapshots mit Lösungen) wird nirgends in reaktivem Zustand gehalten: `show` macht
// daraus sofort `view` (buildExamView, leak-frei), und nur dieses Modell erreicht die Komponenten.
import { nextTick, onMounted, ref, shallowRef } from 'vue'
import ExamDiscardPanel from './ExamDiscardPanel.vue'
import ExamQuestionView from './ExamQuestionView.vue'
import ExamReview from './ExamReview.vue'
import ExamResult from './ExamResult.vue'
import ExamStart from './ExamStart.vue'
import ExamSubmitPanel from './ExamSubmitPanel.vue'
import { EXAM_PRESETS, ExamError } from '../domain/examSelection.js'
import { EXAM_LANGUAGES, EXAM_STATUS, createExamAttempt, validateExamAttempt } from '../domain/examAttempt.js'
import { buildExamReview, pickLastExamResult } from '../domain/examReview.js'
import { buildExamView } from '../domain/examView.js'
import { coverageOf } from '../domain/questionContent.js'
import { describeError, msg, t } from '../i18n/index.js'
import { readExamPool, startExam } from '../storage/examService.js'

const props = defineProps({
  store: { type: Object, required: true },
  defaultLanguage: { type: String, default: 'de' },
})

const emit = defineEmits(['close'])

// loading | start | active | result | review | resultDamaged | damaged | failed
const phase = ref('loading')
const view = ref(null)
const info = ref(null)
const error = ref(null)
const notice = ref(null)
const busy = ref(false)
const confirming = ref(false)
const submitting = ref(false)
// Phase 3D: Review (nur nach der Abgabe, aus dem gespeicherten Versuch), Verwerfen, Herkunft des Ergebnisses.
const reviewModel = shallowRef(null)
const resultIsLast = ref(false)
const discardOpen = ref(false)
const discardBusy = ref(false)
const root = ref(null)

let chain = Promise.resolve()
// Element, das den Abgabe-Dialog geöffnet hat: dorthin kehrt der Fokus nach Abbrechen zurück.
let submitTrigger = null
let discardTrigger = null

// Schreibaufträge laufen nacheinander (Antwort → Position → Abgabe behalten ihre Reihenfolge).
function enqueue(task) {
  const run = chain.then(task)

  chain = run.catch(() => {})

  return run
}

function show(record) {
  reviewModel.value = null
  resultIsLast.value = false

  if (record.status === EXAM_STATUS.SUBMITTED) {
    // Ein abgegebener Versuch, der die Validierung nicht besteht, zeigt weder Ergebnis noch Review (keine Reparatur).
    if (!validateExamAttempt(record).valid) {
      view.value = null
      phase.value = 'resultDamaged'
      return
    }

    view.value = buildExamView(record)
    phase.value = 'result'
    return
  }

  view.value = buildExamView(record)
  phase.value = 'active'
}

function fail(key, cause) {
  const detail = cause instanceof ExamError && cause.code === 'poolTooSmall' ? t('exam.error.poolTooSmall') : describeError(cause)

  error.value = msg(key, { detail: typeof detail === 'string' ? detail : t(detail) })
}

// Zahlen für den Startscreen kommen aus dem Exam-Core (Trockenlauf), nicht aus UI-eigener Logik.
async function loadStartInfo() {
  const { pool, libraries } = await readExamPool(props.store)
  const coverage = coverageOf(pool.map((entry) => entry.question))
  const counts = {}

  EXAM_LANGUAGES.forEach((language) => {
    counts[language] = {}
    Object.keys(EXAM_PRESETS).forEach((preset) => {
      try {
        counts[language][preset] = createExamAttempt({ pool, libraries, language, preset }).questionCount
      } catch {
        counts[language][preset] = 0
      }
    })
  })

  // Letztes abgeschlossenes Ergebnis (nur Kennung): ein Lesefehler macht den Startscreen nicht unbenutzbar.
  let lastResult = null

  try {
    lastResult = pickLastExamResult(await props.store.listExamAttempts())
  } catch {
    lastResult = null
  }

  info.value = { pool: { de: coverage.de, en: coverage.en }, counts, lastResult }
}

async function reloadStored(examSessionId) {
  const record = await props.store.getExamAttempt(examSessionId)

  if (!record) {
    phase.value = 'failed'
    error.value = msg('exam.error.load', { detail: '' })
    return
  }

  show(record)
}

async function load() {
  try {
    const active = await props.store.getActiveExamAttempt()

    if (active) {
      if (validateExamAttempt(active).valid) {
        show(active)
      } else {
        phase.value = 'damaged'
      }

      return
    }

    await loadStartInfo()
    phase.value = 'start'
  } catch (cause) {
    phase.value = 'failed'
    fail('exam.error.load', cause)
  }
}

onMounted(load)

async function start({ language, preset }) {
  if (busy.value) {
    return
  }

  busy.value = true
  error.value = null
  notice.value = null

  try {
    const result = await startExam(props.store, { language, preset })

    if (result.started) {
      show(result.attempt)
    } else if (result.reason === 'activeExists') {
      // Ein anderer Tab war schneller: genau dieser Versuch wird fortgesetzt (Core-Invariante: höchstens einer).
      await load()
      notice.value = msg('exam.notice.alreadyRunning')
    } else {
      fail('exam.error.start', new Error(result.reason))
    }
  } catch (cause) {
    fail('exam.error.start', cause)
  } finally {
    busy.value = false
  }
}

// Antwort oder Position wurde vom Core abgelehnt.
async function handleRejected(outcome, failureKey) {
  if (outcome.reason === 'submitted' || outcome.reason === 'notFound') {
    if (outcome.reason === 'submitted') {
      await reloadStored(view.value.examSessionId)
      notice.value = msg('exam.notice.submittedElsewhere')
    } else {
      await leaveVanishedExam()
    }

    return
  }

  if (outcome.reason === 'invalid') {
    phase.value = 'damaged'
    return
  }

  fail(failureKey, new Error(outcome.reason))
}

// Der angezeigte Versuch existiert nicht mehr (z. B. in einem anderen Tab verworfen): nichts wurde geschrieben,
// die Ansicht wechselt auf den persistierten Stand (Startscreen oder ein inzwischen laufender anderer Versuch).
async function leaveVanishedExam() {
  phase.value = 'loading'
  view.value = null
  reviewModel.value = null
  confirming.value = false
  discardOpen.value = false
  await load()
  notice.value = msg('exam.notice.discardedElsewhere')
}

function select(selectedOptionKey) {
  if (phase.value !== 'active' || submitting.value) {
    return Promise.resolve()
  }

  error.value = null

  return enqueue(async () => {
    try {
      const outcome = await props.store.recordExamAnswer({
        examSessionId: view.value.examSessionId,
        questionId: view.value.question.id,
        selectedOptionKey,
      })

      if (outcome.recorded) {
        show(outcome.attempt)
      } else {
        await handleRejected(outcome, 'exam.error.answer')
      }
    } catch (cause) {
      fail('exam.error.answer', cause)
    }
  })
}

function move(target) {
  if (phase.value !== 'active' || submitting.value) {
    return Promise.resolve()
  }

  error.value = null

  return enqueue(async () => {
    try {
      const outcome = await props.store.setExamPosition({ examSessionId: view.value.examSessionId, ...target })

      if (outcome.moved) {
        show(outcome.attempt)
      } else {
        await handleRejected(outcome, 'exam.error.nav')
      }
    } catch (cause) {
      fail('exam.error.nav', cause)
    }
  })
}

function askSubmit() {
  if (phase.value === 'active') {
    error.value = null
    submitTrigger = document.activeElement
    confirming.value = true
  }
}

// Dialog schließen und den Fokus an den auslösenden Button zurückgeben (erst nach dem Rendern: ein noch
// deaktivierter Button nimmt keinen Fokus an).
async function closeSubmitPanel() {
  confirming.value = false
  await nextTick()

  if (submitTrigger?.isConnected && !submitTrigger.disabled) {
    submitTrigger.focus()
  }

  submitTrigger = null
}

function cancelSubmit() {
  if (!submitting.value) {
    return closeSubmitPanel()
  }
}

async function gotoFirstUnanswered() {
  const index = view.value.firstUnansweredIndex

  await closeSubmitPanel()

  if (index >= 0) {
    await move({ index })
  }
}

// Abgabe: das Ergebnis kommt ausschließlich aus dem Core (gespeicherter Datensatz). Ein zweiter Klick während der
// Abgabe wird sofort verworfen; der Core ist zusätzlich idempotent.
async function confirmSubmit() {
  if (submitting.value || phase.value !== 'active') {
    return
  }

  submitting.value = true
  error.value = null

  try {
    const outcome = await enqueue(() => props.store.finalizeExamAttempt(view.value.examSessionId))

    if (outcome.finalized || outcome.reason === 'alreadySubmitted') {
      confirming.value = false
      show(outcome.attempt)
    } else if (outcome.reason === 'invalid') {
      confirming.value = false
      phase.value = 'damaged'
    } else if (outcome.reason === 'notFound') {
      await leaveVanishedExam()
    } else {
      fail('exam.error.submit', new Error(outcome.reason))
    }
  } catch (cause) {
    // Nichts wurde als abgegeben angezeigt; die Antworten sind gespeichert, der Nutzer kann es erneut versuchen.
    fail('exam.error.submit', cause)
  } finally {
    submitting.value = false
  }
}

async function newExam() {
  view.value = null
  reviewModel.value = null
  error.value = null
  notice.value = null
  confirming.value = false
  discardOpen.value = false
  phase.value = 'loading'
  await load()
}

// --- Phase 3D: letztes Ergebnis, Review, Verwerfen ---

async function openLastResult(examSessionId) {
  if (busy.value || phase.value !== 'start') {
    return
  }

  busy.value = true
  error.value = null
  notice.value = null

  try {
    const record = await props.store.getExamAttempt(examSessionId)

    if (!record || record.status !== EXAM_STATUS.SUBMITTED) {
      // Verschwunden oder (anderer Tab) wieder anders: Startscreen/laufenden Versuch neu laden, nichts erfinden.
      await load()
      fail('exam.error.load', new Error('notFound'))
      return
    }

    show(record)
    resultIsLast.value = phase.value === 'result'
  } catch (cause) {
    fail('exam.error.load', cause)
  } finally {
    busy.value = false
  }
}

// Review nur aus dem frisch gelesenen, abgegebenen Versuch (nie aus einem laufenden, nie aus aktuellen Libraries).
async function openReview() {
  if (phase.value !== 'result' || busy.value) {
    return
  }

  busy.value = true
  error.value = null

  try {
    const record = await props.store.getExamAttempt(view.value.examSessionId)

    if (!record) {
      await leaveVanishedExam()
      return
    }

    const built = buildExamReview(record)

    if (built.ok) {
      reviewModel.value = built.review
      phase.value = 'review'
    } else {
      // Beschädigt oder nicht abgegeben: kein Review, stattdessen der persistierte Stand (Fehlerzustand bzw. laufend).
      show(record)
    }
  } catch (cause) {
    fail('exam.error.review', cause)
  } finally {
    busy.value = false
  }
}

function backToResult() {
  if (phase.value === 'review' && view.value) {
    reviewModel.value = null
    phase.value = 'result'
  }
}

function askDiscard() {
  if (phase.value === 'active' && !submitting.value && !confirming.value && !discardBusy.value) {
    error.value = null
    discardTrigger = document.activeElement
    discardOpen.value = true
  }
}

async function closeDiscardPanel() {
  discardOpen.value = false
  await nextTick()

  if (discardTrigger?.isConnected && !discardTrigger.disabled) {
    discardTrigger.focus()
  }

  discardTrigger = null
}

function cancelDiscard() {
  if (!discardBusy.value) {
    return closeDiscardPanel()
  }
}

// Verwerfen löscht ausschließlich einen LAUFENDEN Versuch (Status und Löschen in einer Transaktion im Store).
async function confirmDiscard() {
  if (discardBusy.value || phase.value !== 'active') {
    return
  }

  discardBusy.value = true
  error.value = null

  try {
    const examSessionId = view.value.examSessionId
    const outcome = await enqueue(() => props.store.discardActiveExamAttempt(examSessionId))

    discardOpen.value = false
    discardTrigger = null

    if (outcome.discarded) {
      await newExam()
      notice.value = msg('exam.notice.discarded')
      await nextTick()
      root.value?.querySelector('.exam-start h2')?.focus()
    } else if (outcome.reason === 'notActive') {
      // Inzwischen abgegeben (anderer Tab): das Ergebnis bleibt unverändert erhalten.
      await reloadStored(examSessionId)
      notice.value = msg('exam.notice.submittedElsewhere')
    } else {
      await leaveVanishedExam()
    }
  } catch (cause) {
    // Nichts wurde gelöscht: Dialog bleibt offen, Abbrechen und erneutes Bestätigen sind möglich.
    fail('exam.error.discard', cause)
  } finally {
    discardBusy.value = false
  }
}

async function discardDamaged() {
  try {
    const active = await props.store.getActiveExamAttempt()

    if (active) {
      // Nur laufende Versuche (auch beschädigte) sind verwerfbar; ein abgegebener Versuch bleibt im Store unverändert.
      await props.store.discardActiveExamAttempt(active.examSessionId)
    }

    await newExam()
  } catch (cause) {
    fail('exam.error.discard', cause)
  }
}
</script>

<template>
  <div ref="root" class="exam-mode">
    <p v-if="notice" class="library-message library-message-warning" role="status">{{ t(notice) }}</p>

    <section v-if="phase === 'loading'" class="start-card" aria-live="polite">
      <p>{{ t('exam.loading') }}</p>
    </section>

    <ExamStart
      v-else-if="phase === 'start'"
      :info="info"
      :default-language="defaultLanguage"
      :busy="busy"
      :last-result="info.lastResult"
      @start="start"
      @last-result="openLastResult"
      @close="emit('close')"
    />

    <template v-else-if="phase === 'active'">
      <ExamQuestionView
        :view="view"
        :busy="submitting || confirming || discardOpen"
        @select="select"
        @back="move({ direction: 'previous' })"
        @next="move({ direction: 'next' })"
        @submit="askSubmit"
      />
      <ExamSubmitPanel
        v-if="confirming"
        :total="view.questionCount"
        :unanswered="view.unansweredCount"
        :submitting="submitting"
        @confirm="confirmSubmit"
        @cancel="cancelSubmit"
        @goto-first="gotoFirstUnanswered"
      />
      <ExamDiscardPanel v-if="discardOpen" :discarding="discardBusy" @confirm="confirmDiscard" @cancel="cancelDiscard" />
      <div class="exam-actions">
        <button
          class="secondary-button"
          type="button"
          data-exam="discard-open"
          :disabled="submitting || confirming || discardOpen"
          @click="askDiscard"
        >
          {{ t('exam.discard.open') }}
        </button>
        <button class="secondary-button" type="button" data-exam="close" :disabled="submitting || discardBusy" @click="emit('close')">
          {{ t('exam.close') }}
        </button>
      </div>
    </template>

    <ExamResult
      v-else-if="phase === 'result'"
      :result="view.result"
      :language="view.language"
      :is-last="resultIsLast"
      @review="openReview"
      @new-exam="newExam"
      @close="emit('close')"
    />

    <ExamReview v-else-if="phase === 'review' && reviewModel" :review="reviewModel" @back="backToResult" />

    <section v-else-if="phase === 'resultDamaged'" class="start-card exam-damaged" :aria-label="t('exam.damagedResult.title')">
      <h2>{{ t('exam.damagedResult.title') }}</h2>
      <p role="alert">{{ t('exam.damagedResult.text') }}</p>
      <div class="exam-actions">
        <button class="primary-button" type="button" data-exam="to-start" @click="newExam">
          {{ t('exam.damagedResult.toStart') }}
        </button>
        <button class="secondary-button" type="button" data-exam="close" @click="emit('close')">
          {{ t('exam.close') }}
        </button>
      </div>
    </section>

    <section v-else-if="phase === 'damaged'" class="start-card exam-damaged" :aria-label="t('exam.damaged.title')">
      <h2>{{ t('exam.damaged.title') }}</h2>
      <p>{{ t('exam.damaged.text') }}</p>
      <div class="exam-actions">
        <button class="primary-button" type="button" data-exam="discard" @click="discardDamaged">
          {{ t('exam.damaged.discard') }}
        </button>
        <button class="secondary-button" type="button" data-exam="close" @click="emit('close')">
          {{ t('exam.close') }}
        </button>
      </div>
    </section>

    <section v-else class="start-card">
      <div class="exam-actions">
        <button class="secondary-button" type="button" data-exam="close" @click="emit('close')">
          {{ t('exam.close') }}
        </button>
      </div>
    </section>

    <p v-if="error" class="library-message library-message-error" role="alert">{{ t(error) }}</p>
  </div>
</template>
