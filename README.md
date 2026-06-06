# Cybersecurity Concepts Quiz

A small Vue.js portfolio project for learning and reviewing general cybersecurity concepts.

The app displays multiple-choice questions from a public JSON question bank and provides immediate feedback, explanations, score tracking, and basic quiz navigation.

## Project Overview

Cybersecurity Concepts Quiz is a lightweight learning app built with Vue.js and Vite.

The public version contains original sample questions about general cybersecurity topics such as:

* Confidentiality, Integrity, and Availability
* Authentication and Authorization
* Multi-Factor Authentication
* Zero Trust
* Security basics and terminology

The goal of this project is to demonstrate a clean frontend structure, JSON-based data modeling, basic state handling in Vue, Git/GitHub workflow, deployment readiness, and awareness of privacy and content separation.

## Features

* Vue.js single-page application
* Public JSON-based question bank
* Multiple-choice quiz interface
* Immediate answer feedback
* Explanation after each answer
* Score tracking
* Next-question navigation
* Restart option after the last question
* Clear separation between public demo data and private local study material

## Tech Stack

* Ubuntu Linux
* VS Code
* Vue.js
* Vite
* JavaScript
* JSON
* CSS
* Git and GitHub
* Static site deployment

## Public vs. Private Question Banks

The public question bank is located at:

```
src/data/public/sampleQuestions.json
```

This file is intended for GitHub and deployment. It contains only original sample questions about general cybersecurity concepts.

Private local study material can be stored outside the public source code and is ignored by Git:

```
private/
```

The private folder is excluded through `.gitignore` and is not intended to be committed, pushed, deployed, or shown in screenshots.

## Local Development

Install dependencies:

```
npm install
```

Start the development server:

```
npm run dev
```

Open the local URL shown in the terminal, usually:

```
http://localhost:5173/
```

## Build and Preview

Create a production build:

```
npm run build
```

Preview the production build locally:

```
npm run preview
```

## Deployment

This project is designed as a static Vue/Vite application.

Example deployment settings for a static hosting provider:

```
Build Command:
npm install && npm run build

Publish Directory:
dist
```

No backend, database, login system, or Docker setup is required for the first version.

## Privacy and Content Disclaimer

This project is an unofficial cybersecurity learning app created for educational and portfolio purposes.

It contains original public sample questions about general cybersecurity concepts.

It does not include real exam questions, brain dumps, copied course materials, or third-party practice exam content.

It is not affiliated with any certification provider, training platform, course author, or exam preparation provider.

Private study question banks can be used locally. These private files are not uploaded, stored, deployed, or included in the public repository.
