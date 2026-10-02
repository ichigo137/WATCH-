# WatchTogether MVP

Responsive watch-party web app for PC and mobile.

## Features

- 6-character room tokens
- Shareable invite links
- Room-wide play / pause / seek synchronization
- Host-only control by default, with an everyone-can-control option
- Realtime room chat via Server-Sent Events (SSE)
- Live member list and automatic host hand-off
- Direct MP4 and HLS (`.m3u8`) URLs
- Local video preview (local-device only in this MVP)
- Optional PostgreSQL persistence via `DATABASE_URL`
- Render deployment configuration included
- Responsive mobile/desktop layout

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## PostgreSQL persistence

Without `DATABASE_URL`, the app uses in-memory room state. With `DATABASE_URL`, the app automatically creates its tables and persists room metadata and chat messages. Live connections and member presence remain in memory, which is appropriate for a single-instance MVP.

## Render

Create a web service from this repository and provide a PostgreSQL connection string as the `DATABASE_URL` environment variable. The included `render.yaml` declares the service configuration.

## Video sources

The browser needs a directly playable media URL. Supported MVP inputs are direct MP4/video URLs and HLS manifests where the browser/HLS.js can access them. A random video webpage URL is not universally playable because many providers use embeds, authentication, CORS rules, signed URLs, or DRM.
# WATCH-
