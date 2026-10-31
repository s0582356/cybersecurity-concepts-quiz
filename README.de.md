# Cybersecurity Concepts Quiz

Eine kleine Vue.js-Portfolio-App zum Lernen und Wiederholen allgemeiner Cybersecurity-Grundlagen.

Die App zeigt Multiple-Choice-Fragen aus einer öffentlichen JSON-Fragebank an und bietet direktes Feedback, Erklärungen, Score-Anzeige, Abschlussauswertung, sitzungsbasierte Wiederholung falscher Fragen, Quiz-Navigation und einen kleinen Versions-Footer.

## Live-Demo

Die deployte App ist hier erreichbar:

https://cybersecurity-concepts-quiz.onrender.com

## Projektübersicht

Cybersecurity Concepts Quiz ist eine schlanke Lern-App mit Vue.js und Vite.

Die öffentliche Version enthält eigene Beispiel-Fragen zu allgemeinen Cybersecurity-Themen wie:

* Confidentiality, Integrity und Availability
* Authentication und Authorization
* Multi-Factor Authentication
* Zero Trust
* Security-Grundlagen und Fachbegriffe

Ziel des Projekts ist es, eine saubere Frontend-Struktur, JSON-basierte Datenmodellierung, komponentenbasierte Vue-Entwicklung, grundlegendes State Handling, Git/GitHub-Workflow, Deployment-Fähigkeit sowie Datenschutzbewusstsein und klare Inhaltstrennung zu zeigen.

## Funktionen

* Vue.js Single-Page-App
* Öffentliche JSON-basierte Fragebank
* Multiple-Choice-Quizoberfläche
* Direktes Feedback nach Antwortauswahl
* Erklärung nach jeder Antwort
* Score-Anzeige
* Abschlussauswertung mit Gesamtfragen, richtigen Antworten, falschen Antworten und Prozentwert
* Ergebnisabhängiger Bewertungstext
* Sitzungsbasierter Wiederholungsmodus für falsch beantwortete Fragen
* Sichtbares Label für den Wiederholungsmodus
* Lokales Laden privater Fragebanken über die Dateiauswahl
* Navigation zur nächsten Frage
* Neustart über den Ergebnisbildschirm
* Komponentenbasierte UI-Struktur
* Versions-Footer mit GitHub-Link
* Klare Trennung zwischen öffentlichen Demo-Daten und privaten lokalen Lernmaterialien
* Deployment als statische Website

## Technologien

* Ubuntu Linux
* VS Code
* Vue.js
* Vite
* JavaScript
* JSON
* CSS
* Git und GitHub
* Render Static Site Deployment

## Projektstruktur

```text
cybersecurity-concepts-quiz/
├── README.md
├── README.de.md
├── .gitignore
├── package.json
├── public/
└── src/
    ├── components/
    │   ├── AnswerOption.vue
    │   ├── QuizCard.vue
    │   └── ScoreBox.vue
    ├── data/
    │   └── public/
    │       └── sampleQuestions.json
    ├── App.vue
    ├── main.js
    └── style.css
```

## Öffentliche vs. private Fragebanken

Die öffentliche Fragebank liegt unter:

```text
src/data/public/sampleQuestions.json
```

Diese Datei ist für GitHub und Deployment vorgesehen. Sie enthält nur eigene Beispiel-Fragen zu allgemeinen Cybersecurity-Konzepten.

Private Fragebanken können lokal über die Dateiauswahl des Browsers als JSON-Dateien geladen werden (auch mehrere gleichzeitig). Sie werden nur im Browser gelesen und nicht hochgeladen, nicht auf einem Server gespeichert und nicht in die deployte statische Website eingebunden.

Bei V2-Bibliotheken (JSON-Objekte mit `libraryId`) speichert der Browser die importierten Inhalte (Fragen, Antwortoptionen, Erklärungen) lokal in IndexedDB (Object Store `libraryContent`). Dadurch zeigt die App die Bibliotheksübersicht nach einem Seiten-Reload an und kann ohne erneuten Dateiimport weiterlernen. Die Daten bleiben ausschließlich im Browser auf dem eigenen Gerät: kein Server-Upload, kein Cloud-Sync, kein Konto. Lernfortschritt (Bibliotheks-ID, Version, Index-Hash, Lernabschnitt, Zähler je stabiler Frage-ID) und Lernrunden (Fragenreihenfolge als IDs, aktuelle Position, Rundenstand) werden getrennt davon gespeichert. Die Bibliotheken werden automatisch nach Lernabschnitt gruppiert. V1-Fragenlisten werden nicht gespeichert. Nach einem Seiten-Reload genügt es, den Lernabschnitt erneut zu öffnen; ein vollständiger Neustart des Browser-Prozesses wurde noch nicht getestet.

Private lokale Lernmaterialien sollten außerhalb des öffentlichen Quellcodes bleiben und nicht committed, gepusht, deployed oder in Screenshots gezeigt werden. Die privaten JSON-Dateien gehören nie ins öffentliche Repository; echte private Fragen sind weder in öffentlichen Fixtures noch im Build eingebettet.

## Lernworkflow

Eine Quiz-Sitzung kann mit den öffentlichen Beispiel-Fragen oder mit einer lokal ausgewählten privaten Fragebank durchgeführt werden. Am Ende zeigt die App eine Abschlussauswertung mit Gesamtfragen, richtigen Antworten, falschen Antworten, Prozentwert und einem kurzen Bewertungstext.

Wenn Fragen falsch beantwortet wurden, bietet der Ergebnisbildschirm einen Wiederholungsmodus für diese Fehlerfragen an. Dadurch startet eine neue Sitzung nur mit den verpassten Fragen, während die ursprüngliche Fragebank für einen normalen Neustart erhalten bleibt.

## Lokale Entwicklung

Abhängigkeiten installieren:

```bash
npm install
```

Entwicklungsserver starten:

```bash
npm run dev
```

Danach die im Terminal angezeigte lokale Adresse öffnen, normalerweise:

```text
http://localhost:5173/
```

Um die App auf einem anderen Gerät im gleichen lokalen Netzwerk zu testen, kann Vite so gestartet werden:

```bash
npm run dev -- --host 0.0.0.0
```

Danach kann die angezeigte Netzwerkadresse auf dem anderen Gerät geöffnet werden.

## Build und Vorschau

Produktionsbuild erstellen:

```bash
npm run build
```

Produktionsbuild lokal testen:

```bash
npm run preview
```

## Deployment

Dieses Projekt ist als statische Vue/Vite-Anwendung auf Render deployed.

Render-Einstellungen:

```text
Build Command:
npm install && npm run build

Publish Directory:
dist
```

Für die aktuelle Version werden kein Backend, keine Datenbank, kein Login-System und kein Docker-Setup benötigt.

## Aktuelle Version

```text
Version 0.3.0
Component refactor
```

Die aktuelle Version enthält eine ausgelagerte Komponentenstruktur, eine Abschlussauswertung, sitzungsbasierte Wiederholung falscher Fragen, lokales Laden privater Fragebanken und einen kleinen Footer mit Versionsinformation und GitHub-Link.

## Datenschutz- und Inhaltshinweis

Dieses Projekt ist eine inoffizielle Cybersecurity-Lern-App für Bildungs- und Portfoliozwecke.

Die öffentliche Version enthält nur eigene Beispiel-Fragen zu allgemeinen Cybersecurity-Konzepten.

Sie enthält keine echten Prüfungsfragen, keine Brain Dumps, keine kopierten Kursmaterialien und keine Inhalte aus fremden Übungsprüfungen.

Das Projekt steht in keiner Verbindung zu Zertifizierungsanbietern, Trainingsplattformen, Kursautoren oder Prüfungsanbietern.

Private Fragebanken können lokal über die Dateiauswahl verwendet werden. Diese privaten Dateien werden nicht auf einen Server hochgeladen, nicht deployed und nicht im öffentlichen Repository veröffentlicht. Ihr Inhalt wird nur lokal im IndexedDB des Browsers gehalten (siehe „Öffentliche vs. private Fragebanken“).
