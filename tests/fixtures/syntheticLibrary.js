// Synthetische V2-Testfixture: bildet nur die Struktur der V2-Library nach.
// Enthält keine echten Fragen aus der privaten Security-V2-Bibliothek.

const SYNTHETIC_HASH = `sha256:${'a'.repeat(64)}`

export function makeSyntheticLibrary({
  libraryId = 'synthetic-test-library',
  libraryVersion = '1.0.0',
  activeQuestionIndexHash = SYNTHETIC_HASH,
  count = 4,
  idPrefix = 'sec-a30',
} = {}) {
  const questions = Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(4, '0')
    const correctOptionKey = ['a', 'b', 'c', 'd'][index % 4]

    return {
      id: `${idPrefix}-${number}`,
      status: 'active',
      replacedBy: null,
      sourceTranscriptSection: 30,
      learningSectionId: 'la99',
      contentMode: 'learning',
      topicId: index % 2 === 0 ? 'la99.alpha' : 'la99.beta',
      subtopicId: 'la99.alpha.one',
      questionType: 'concept',
      difficulty: 'medium',
      correctOptionKey,
      contentRevision: 1,
      localized: {
        de: {
          question: `Synthetische Frage ${number}?`,
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

  return {
    schemaVersion: '2.0.0',
    libraryId,
    libraryVersion,
    title: 'Synthetische Testbibliothek',
    languageSupport: ['de'],
    sourceSections: [30],
    questionCount: count,
    activeQuestionIndexHash,
    questions,
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
