# Cybersecurity Concepts Quiz

A small Vue.js portfolio project for learning and reviewing general cybersecurity concepts.

The app displays multiple-choice questions from a public JSON question bank and provides immediate feedback, explanations, score tracking, quiz navigation, and a small version footer.

## Live Demo

The deployed app is available here:

https://cybersecurity-concepts-quiz.onrender.com

## Project Overview

Cybersecurity Concepts Quiz is a lightweight learning app built with Vue.js and Vite.

The public version contains original sample questions about general cybersecurity topics such as:

* Confidentiality, Integrity, and Availability
* Authentication and Authorization
* Multi-Factor Authentication
* Zero Trust
* Security basics and terminology

The goal of this project is to demonstrate a clean frontend structure, JSON-based data modeling, component-based Vue development, basic state handling, Git/GitHub workflow, deployment readiness, and awareness of privacy and content separation.

## Features

* Vue.js single-page application
* Public JSON-based question bank
* Multiple-choice quiz interface
* Immediate answer feedback
* Explanation after each answer
* Score tracking
* Next-question navigation
* Restart option after the last question
* Component-based UI structure
* Version footer with GitHub link
* Clear separation between public demo data and private local study material
* Deployed as a static site

## Tech Stack

* Ubuntu Linux
* VS Code
* Vue.js
* Vite
* JavaScript
* JSON
* CSS
* Git and GitHub
* Render Static Site Deployment

## Project Structure

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

## Public vs. Private Question Banks

The public question bank is located at:

```text
src/data/public/sampleQuestions.json
```

This file is intended for GitHub and deployment. It contains only original sample questions about general cybersecurity concepts.

Private local study material can be stored outside the public source code and is ignored by Git:

```text
private/
```

The private folder is excluded through `.gitignore` and is not intended to be committed, pushed, deployed, or shown in screenshots.

## Local Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the local URL shown in the terminal, usually:

```text
http://localhost:5173/
```

To test the app on another device in the same local network, start Vite with:

```bash
npm run dev -- --host 0.0.0.0
```

Then open the displayed network URL on the other device.

## Build and Preview

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## Deployment

This project is deployed as a static Vue/Vite application on Render.

Render settings:

```text
Build Command:
npm install && npm run build

Publish Directory:
dist
```

No backend, database, login system, or Docker setup is required for the current version.

## Current Version

```text
Version 0.3.0
Component refactor
```

The current version includes a refactored component structure and a small footer with version information and a GitHub link.

## Privacy and Content Disclaimer

This project is an unofficial cybersecurity learning app created for educational and portfolio purposes.

It contains original public sample questions about general cybersecurity concepts.

It does not include real exam questions, brain dumps, copied course materials, or third-party practice exam content.

It is not affiliated with any certification provider, training platform, course author, or exam preparation provider.

Private study question banks can be used locally in future versions. These private files are not uploaded, stored, deployed, or included in the public repository.
