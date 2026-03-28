# Contributing

## Setup

```bash
git clone https://github.com/forgesworn/402-pub.git
cd 402-pub
```

No dependencies to install — this is a static site with zero build tools.

## Development

Serve the site locally with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000` and services will stream in from the configured relays.

## Refreshing External Data

External directories (satring, x402 Bazaar, agent-commerce) are stored as local JSON snapshots in `data/`. To refresh them:

```bash
node scripts/fetch-sources.mjs
```

## Project Structure

```
index.html          Landing page + live service directory
style.css           Design system (dark theme, CSS custom properties, amber/blue accents)
app.js              Nostr relay manager, event parser, DOM renderer (zero dependencies)
data/               Pre-fetched JSON snapshots of external directories
scripts/            Build/fetch scripts (fetch-sources.mjs)
social-preview.*    Social preview assets (PNG + SVG source)
favicon.*           Favicon set (ICO, SVG, PNG sizes)
llms.txt            AI-readable project summary
CLAUDE.md           AI agent coding instructions
```

## Making Changes

1. Create a branch: `git checkout -b feat/short-description`
2. Make your changes.
3. Test locally by serving the site and verifying the directory loads.
4. Commit using conventional commits: `type: description`
   - `feat:` — new feature
   - `fix:` — bug fix
   - `docs:` — documentation only
   - `refactor:` — no behaviour change
5. Open a pull request against `main`.

## Code Style

- **British English** in all prose and comments — colour, behaviour, licence, initialise.
- **No build tools** — vanilla HTML/CSS/JS. No bundler, no transpiler, no npm scripts.
- **XSS safety** — all Nostr event strings go through `.textContent`, never `innerHTML`. Relay URLs from localStorage use DOM construction, not string interpolation.
- **Accessibility** — ARIA labels, roles, `prefers-reduced-motion` support, screen-reader-only utility class.
- **No runtime dependencies** — `app.js` has zero imports. Keep it that way.

## Common Tasks

| Task | How |
|------|-----|
| Add a relay | Add to `DEFAULT_RELAYS` array in `app.js` |
| Add an external source | Add entry to `EXTERNAL_SOURCES` array with a parser function |
| Change design tokens | Edit CSS custom properties in `:root` block of `style.css` |
| Update external snapshots | Run `node scripts/fetch-sources.mjs` |

## Licence

By contributing, you agree that your contributions will be licensed under the MIT licence.
