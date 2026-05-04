# App Compass - Product Requirements Document

## Problem
User wants a "compass" app that helps them discover which applications to use for any task they want to perform. They describe what they want, and the app suggests the right tools.

## MVP Features
- **Natural language search**: User types (in Italian or English) what they want to do.
- **AI recommendations** (Claude Sonnet 4.5 via Emergent LLM Key): Returns 4-6 real app recommendations with name, description, platforms, pricing, pros/cons, and link.
- **Category browse**: 12 guided categories (Foto, Video, Produttività, Finanza, Fitness, Studio, Viaggi, Musica, Design, Comunicazione, AI, Shopping).
- **Favorites**: Save apps for later with bookmark toggle.
- **History**: Automatic search history with re-run + delete.
- **Comparison view**: Side-by-side comparison of 2-3 selected apps.
- **Open links**: Directly open the app's official website.

## Architecture
- **Frontend**: Expo Router tabs (index, saved, history). Dark theme (Jewel archetype: midnight + champagne gold).
- **Backend**: FastAPI with MongoDB for favorites and history persistence.
- **AI**: emergentintegrations `LlmChat` + Claude Sonnet 4.5.

## API
- `GET /api/categories`
- `POST /api/recommend` `{ query, category? }`
- `GET /api/history`, `DELETE /api/history`, `DELETE /api/history/{id}`
- `GET /api/favorites`, `POST /api/favorites`, `DELETE /api/favorites/{id}`

## Iteration 2 — Voice, Featured App, Share
- ✅ POST `/api/transcribe` (OpenAI Whisper via Emergent LLM Key) — detta richieste in italiano
- ✅ GET `/api/featured-app` — rotazione settimanale su 8 app curate
- ✅ Home: bottone mic 🎤 + card "App della Settimana" + bottone "Condividi" nei risultati
- ✅ `_layout.tsx`: scaffold `expo-notifications` (schedula reminder settimanale Lun 9:00 su build nativi)
- ✅ `app.json`: permessi `RECORD_AUDIO` Android + `NSMicrophoneUsageDescription` iOS
- ✅ Share: Web Share API + React Native Share + fallback Clipboard (deep link `/?q=...&auto=1`)
