# CLAUDE.md — 402-pub

## What is this?

Static landing page and live service directory for [402.pub](https://402.pub/) — the open marketplace for paid APIs. No build step, no framework, no backend.

## Architecture

```
index.html    Single-page app: hero, audience cards, service directory, announce CTA
style.css     Design system: dark theme, CSS custom properties, amber/blue accents
app.js        Nostr relay manager → event parser → DOM renderer (zero dependencies)
```

### app.js modules (top to bottom)

1. **Relay Manager** — connects to Nostr relays via WebSocket, subscribes to kind 31402, auto-reconnects with exponential backoff
2. **Event Store** — de-duplicates by `pubkey:d-tag`, validates required tags, honours NIP-40 expiration
3. **UI Renderer** — builds DOM via safe `.textContent` (never innerHTML with untrusted data), renders filter pills, service cards, health dots
4. **External Sources** — fetches from l402.directory in parallel, merges with Nostr-sourced services
5. **Health Checks** — async HEAD requests with 5-minute cache, staggered to avoid thundering herd
6. **Particle Network** — ambient canvas animation, throttled to 30fps, respects prefers-reduced-motion

## Running locally

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Conventions

- **British English** — colour, behaviour, licence, initialise
- **XSS safety** — all Nostr event strings go through `.textContent`, never `innerHTML`. Relay URLs from localStorage use DOM construction, not string interpolation.
- **No build tools** — vanilla HTML/CSS/JS. No bundler, no transpiler, no npm scripts.
- **Accessibility** — ARIA labels, roles, `prefers-reduced-motion` support, screen-reader-only utility class

## Common tasks

- **Add a relay**: add to `DEFAULT_RELAYS` array in app.js
- **Add an external source**: add entry to `EXTERNAL_SOURCES` array with a parser function
- **Change design tokens**: edit CSS custom properties in `:root` block of style.css
