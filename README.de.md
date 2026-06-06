# Cybersecurity Concepts Quiz

Eine kleine Vue.js-Portfolio-App zum Lernen und Wiederholen allgemeiner Cybersecurity-Grundlagen.

Die App zeigt Multiple-Choice-Fragen aus einer öffentlichen JSON-Fragebank an und bietet direktes Feedback, Erklärungen, Score-Anzeige und einfache Quiz-Navigation.

## Projektübersicht

Cybersecurity Concepts Quiz ist eine schlanke Lern-App mit Vue.js und Vite.

Die öffentliche Version enthält eigene Beispiel-Fragen zu allgemeinen Cybersecurity-Themen wie:

* Confidentiality, Integrity und Availability
* Authentication und Authorization
* Multi-Factor Authentication
* Zero Trust
* Security-Grundlagen und Fachbegriffe

Ziel des Projekts ist es, eine saubere Frontend-Struktur, JSON-basierte Datenmodellierung, grundlegendes State Handling in Vue, Git/GitHub-Workflow, Deployment-Fähigkeit sowie Datenschutzbewusstsein und klare Inhaltstrennung zu zeigen.

## Funktionen

* Vue.js Single-Page-App
* Öffentliche JSON-basierte Fragebank
* Multiple-Choice-Quizoberfläche
* Direktes Feedback nach Antwortauswahl
* Erklärung nach jeder Antwort
* Score-Anzeige
* Navigation zur nächsten Frage
* Neustart nach der letzten Frage
* Klare Trennung zwischen öffentlichen Demo-Daten und privaten lokalen Lernmaterialien

## Technologien

* Ubuntu Linux
* VS Code
* Vue.js
* Vite
* JavaScript
* JSON
* CSS
* Git und GitHub
* Static Site Deployment

## Öffentliche vs. private Fragebanken

Die öffentliche Fragebank liegt unter:

```
src/data/public/sampleQuestions.json
```

Diese Datei ist für GitHub und Deployment vorgesehen. Sie enthält nur eigene Beispiel-Fragen zu allgemeinen Cybersecurity-Konzepten.

Private lokale Lernmaterialien können außerhalb des öffentlichen Quellcodes abgelegt werden und werden von Git ignoriert:

```
private/
```

Der private Ordner ist über `.gitignore` ausgeschlossen und soll nicht committed, gepusht, deployed oder in Screenshots gezeigt werden.

## Lokale Entwicklung

Abhängigkeiten installieren:

```
npm install
```

Entwicklungsserver starten:

```
npm run dev
```

Danach die im Terminal angezeigte lokale Adresse öffnen, normalerweise:

```
http://localhost:5173/
```

## Build und Vorschau

Produktionsbuild erstellen:

```
npm run build
```

Produktionsbuild lokal testen:

```
npm run preview
```

## Deployment

Dieses Projekt ist als statische Vue/Vite-Anwendung geplant.

Beispiel-Einstellungen für einen Static-Site-Hosting-Anbieter:

```
Build Command:
npm install && npm run build

Publish Directory:
dist
```

Für die erste Version werden kein Backend, keine Datenbank, kein Login-System und kein Docker-Setup benötigt.

## Datenschutz- und Inhaltshinweis

Dieses Projekt ist eine inoffizielle Cybersecurity-Lern-App für Bildungs- und Portfoliozwecke.

Die öffentliche Version enthält nur eigene Beispiel-Fragen zu allgemeinen Cybersecurity-Konzepten.

Sie enthält keine echten Prüfungsfragen, keine Brain Dumps, keine kopierten Kursmaterialien und keine Inhalte aus fremden Übungsprüfungen.

Das Projekt steht in keiner Verbindung zu Zertifizierungsanbietern, Trainingsplattformen, Kursautoren oder Prüfungsanbietern.

Private Lernfragebanken können lokal verwendet werden. Diese privaten Dateien werden nicht hochgeladen, nicht gespeichert, nicht deployed und nicht im öffentlichen Repository veröffentlicht.
