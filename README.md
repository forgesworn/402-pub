# 402.pub

**Nostr:** [`npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`](https://njump.me/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

**The open marketplace for paid APIs.** Discover services on Nostr, pay with L402, x402, or Cashu — no registry, no API keys, no gatekeepers.

[402.pub](https://402.pub/) is a live directory that streams [kind 31402](https://github.com/forgesworn/402-announce) service announcements from Nostr relays in real time. It also indexes external directories like [l402.directory](https://l402.directory/) so you get a single view of the entire L402 ecosystem.

![402.pub social preview](social-preview.png)

## Who is this for?

### I run an API

Gate any HTTP endpoint behind a paywall in a few lines of code. Announce it on Nostr and it appears here automatically.

```bash
npm i @forgesworn/toll-booth
```

- [toll-booth](https://github.com/forgesworn/toll-booth) — L402 paywall middleware for Express, Hono, or any HTTP framework
- [402-announce](https://github.com/forgesworn/402-announce) — publish your service on Nostr for decentralised discovery
- [toll-booth-announce](https://github.com/forgesworn/toll-booth-announce) — one-line bridge from your toll-booth config to Nostr

### I build agents

Give your AI agent a wallet. It discovers paid APIs on Nostr, pays with L402, x402, or Cashu, and caches credentials — no human approval needed.

```bash
npx 402-mcp
```

- [402-mcp](https://github.com/forgesworn/402-mcp) — MCP server that lets AI agents discover, pay for, and consume L402 APIs autonomously

## How it works

1. The page connects to multiple Nostr relays via WebSocket
2. It subscribes to **kind 31402** events — the standard for announcing paid API services
3. Services appear in a filterable, searchable directory with live health checks
4. External directories (l402.directory) are fetched in parallel to fill gaps

All service data is sourced from public Nostr events. There is no backend, no database, no sign-up.

## Running locally

This is a static site — no build step required.

```bash
# Serve with any static file server
npx serve .

# Or use Python
python3 -m http.server 8000
```

Open `http://localhost:8000` and services will stream in from the configured relays.

## Project structure

```
index.html          Landing page + live service directory
style.css           Design system (dark theme, amber/blue accents)
app.js              Nostr relay manager, event parser, DOM renderer
social-preview.*    Social preview assets (PNG + SVG source)
favicon.*           Favicon set (ICO, SVG, PNG sizes)
```

## Part of the L402 ecosystem

402.pub is the public face of a suite of open-source tools for paid APIs:

| Package | Purpose |
|---------|---------|
| [toll-booth](https://github.com/forgesworn/toll-booth) | L402 paywall middleware |
| [402-announce](https://github.com/forgesworn/402-announce) | Nostr service announcements |
| [toll-booth-announce](https://github.com/forgesworn/toll-booth-announce) | Config-to-Nostr bridge |
| [402-mcp](https://github.com/forgesworn/402-mcp) | AI agent MCP client |

## Licence

MIT
