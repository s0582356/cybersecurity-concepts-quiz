// Synthetische V2-Testfixture: bildet nur die Struktur der V2-Library nach.
// Enthält keine echten Fragen aus der privaten Security-V2-Bibliothek.

const SYNTHETIC_HASH = `sha256:${'a'.repeat(64)}`

export function makeSyntheticLibrary({
  libraryId = 'synthetic-test-library',
  libraryVersion = '1.0.0',
  activeQuestionIndexHash = SYNTHETIC_HASH,
  count = 4,
  idPrefix = 'sec-a30',
  learningSectionId = 'la99',
  questionLabel = 'Synthetische Frage',
  // Phase 2F: 'all' | 'none' | Liste von IDs mit englischer Fassung; `englishOverrides` ersetzt/zerstört einzelne EN-Fassungen.
  english = 'none',
  englishOverrides = {},
  languageSupport = null,
  contentRevisions = {},
  omitIds = [],
} = {}) {
  const questions = Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(4, '0')
    const correctOptionKey = ['a', 'b', 'c', 'd'][index % 4]

    return {
      id: `${idPrefix}-${number}`,
      status: 'active',
      replacedBy: null,
      sourceTranscriptSection: 30,
      learningSectionId,
      contentMode: 'learning',
      topicId: index % 2 === 0 ? 'la99.alpha' : 'la99.beta',
      subtopicId: 'la99.alpha.one',
      questionType: 'concept',
      difficulty: 'medium',
      correctOptionKey,
      contentRevision: contentRevisions[`${idPrefix}-${number}`] ?? 1,
      localized: {
        de: {
          question: `${questionLabel} ${number}?`,
          optionText: {
            a: `Synthetisch ${number} A`,
            b: `Synthetisch ${number} B`,
            c: `Synthetisch ${number} C`,
            d: `Synthetisch ${number} D`,
          },
          explanation: `Synthetische Erklärung ${number}.`,
          memoryAid: { type: 'mini_scenario', text: 'Synthetisch.' },
        },
        en: null,
      },
      meta: { tags: ['synthetic'] },
    }
  })

  questions.forEach((question) => {
    const number = question.id.slice(-4)
    const wantsEnglish = english === 'all' || (Array.isArray(english) && english.includes(question.id))

    if (wantsEnglish) {
      question.localized.en = {
        question: `${questionLabel} EN ${number}?`,
        optionText: {
          a: `English ${number} A`,
          b: `English ${number} B`,
          c: `English ${number} C`,
          d: `English ${number} D`,
        },
        explanation: `Synthetic explanation ${number}.`,
        memoryAid: { type: 'mini_scenario', text: `Synthetic memory aid ${number}.` },
      }
    }

    if (question.id in englishOverrides) {
      question.localized.en = englishOverrides[question.id]
    }
  })

  const kept = questions.filter((question) => !omitIds.includes(question.id))

  return {
    schemaVersion: '2.0.0',
    libraryId,
    libraryVersion,
    title: 'Synthetische Testbibliothek',
    languageSupport: languageSupport ?? (english === 'none' ? ['de'] : ['de', 'en']),
    sourceSections: [30],
    questionCount: kept.length,
    activeQuestionIndexHash,
    questions: kept,
  }
}

export const V1_QUESTIONS = [
  {
    id: 1,
    category: 'V1 Kategorie',
    difficulty: 'easy',
    question: 'V1 Frage eins?',
    options: ['V1 richtig', 'V1 falsch A', 'V1 falsch B'],
    correctAnswer: 'V1 richtig',
    explanation: 'V1 Erklärung eins.',
  },
  {
    id: 2,
    category: 'V1 Kategorie',
    difficulty: 'easy',
    question: 'V1 Frage zwei?',
    options: ['V1 zwei richtig', 'V1 zwei falsch'],
    correctAnswer: 'V1 zwei richtig',
    explanation: 'V1 Erklärung zwei.',
  },
]
