# 402.pub Bech32 Deep-Link + NIP-89 Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add naddr deep-linking to 402.pub so individual services are shareable, and register 402.pub as the NIP-89 handler for kind 31402.

**Architecture:** Two new plain JS files (`bech32.js` for bech32 encoding/decoding, `nip19.js` for NIP-19 naddr TLV) loaded before `app.js`. Hash-based routing in `app.js` detects `#naddr1...` on page load, shows a loading modal, and populates it when the matching event arrives. A share button in the detail modal encodes the service to naddr and copies the URL.

**Tech Stack:** Vanilla JS (no dependencies, no build step), bech32 algorithm hand-written per BIP-173/BIP-350 spec, NIP-19 TLV per the Nostr spec.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `bech32.js` (new) | Bech32/bech32m encode and decode. Exposes `window.bech32` with `encode`, `decode`, `toWords`, `fromWords` methods. |
| `nip19.js` (new) | NIP-19 naddr encode/decode. Exposes `window.nip19` with `encodeNaddr({ kind, pubkey, dTag, relays })` and `decodeNaddr(bech32str)`. Depends on `window.bech32`. |
| `app.js` (modify) | Hash routing, loading modal, share button, relay hint injection, hash cleanup on modal close. |
| `index.html` (modify) | Two script tags before `app.js`. |

---

### Task 1: Bech32 Encode/Decode Library

**Files:**
- Create: `bech32.js`
- Create: `test/bech32.test.mjs`

- [ ] **Step 1: Write the test file**

Create `test/bech32.test.mjs` with tests using the NIP-19 test vectors:

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Load the script in a minimal way — bech32.js sets window.bech32,
// but for Node testing we eval it in a context with a fake window.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(dir, '..', 'bech32.js'), 'utf8')

function loadBech32() {
  const context = { window: {} }
  vm.createContext(context)
  vm.runInContext(src, context)
  return context.window.bech32
}

describe('bech32', () => {
  const b = loadBech32()

  it('decodes npub to 32-byte hex pubkey', () => {
    const decoded = b.decode('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg')
    assert.equal(decoded.prefix, 'npub')
    const bytes = b.fromWords(decoded.words)
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
    assert.equal(hex, '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e')
  })

  it('round-trips encode/decode', () => {
    const hex = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'
    const bytes = Uint8Array.from(hex.match(/.{2}/g).map(h => parseInt(h, 16)))
    const words = b.toWords(bytes)
    const encoded = b.encode('npub', words)
    assert.equal(encoded, 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg')
  })

  it('rejects invalid checksum', () => {
    assert.throws(() => {
      b.decode('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptX')
    })
  })

  it('rejects mixed case', () => {
    assert.throws(() => {
      b.decode('Npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg')
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/darren/WebstormProjects/402-pub && node --test test/bech32.test.mjs`
Expected: FAIL — `bech32.js` does not exist yet.

- [ ] **Step 3: Implement bech32.js**

Create `bech32.js` — a self-contained bech32 encoder/decoder following BIP-173. Exposes `window.bech32` with `encode`, `decode`, `toWords`, `fromWords` methods.

```js
/**
 * bech32.js — Minimal bech32 encoder/decoder (BIP-173)
 *
 * Exposes window.bech32 = { encode, decode, toWords, fromWords }
 * Zero dependencies. MIT-compatible with @scure/base test vectors.
 */
;(function () {
  'use strict'

  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const CHARSET_REV = new Int8Array(128).fill(-1)
  for (let i = 0; i < CHARSET.length; i++) CHARSET_REV[CHARSET.charCodeAt(i)] = i

  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

  function polymod(values) {
    let chk = 1
    for (const v of values) {
      const top = chk >> 25
      chk = ((chk & 0x1ffffff) << 5) ^ v
      for (let i = 0; i < 5; i++) {
        if ((top >> i) & 1) chk ^= GENERATOR[i]
      }
    }
    return chk
  }

  function hrpExpand(hrp) {
    const ret = []
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5)
    ret.push(0)
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31)
    return ret
  }

  function verifyChecksum(hrp, data) {
    return polymod([...hrpExpand(hrp), ...data]) === 1
  }

  function createChecksum(hrp, data) {
    const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
    const mod = polymod(values) ^ 1
    const ret = []
    for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 31)
    return ret
  }

  function encode(hrp, words) {
    const combined = [...words, ...createChecksum(hrp, words)]
    return hrp + '1' + combined.map(d => CHARSET[d]).join('')
  }

  function decode(str, limit) {
    if (typeof limit === 'undefined') limit = 90
    if (str.length > limit && limit !== false) throw new Error('Exceeds length limit')

    const lowered = str.toLowerCase()
    const uppered = str.toUpperCase()
    if (str !== lowered && str !== uppered) throw new Error('Mixed case')
    str = lowered

    const pos = str.lastIndexOf('1')
    if (pos < 1) throw new Error('Missing separator')
    if (pos + 7 > str.length) throw new Error('Data too short')

    const hrp = str.slice(0, pos)
    const dataChars = str.slice(pos + 1)
    const data = []
    for (const c of dataChars) {
      const d = CHARSET_REV[c.charCodeAt(0)]
      if (d === -1) throw new Error('Invalid character: ' + c)
      data.push(d)
    }

    if (!verifyChecksum(hrp, data)) throw new Error('Invalid checksum')
    return { prefix: hrp, words: data.slice(0, -6) }
  }

  function toWords(bytes) {
    let value = 0
    let bits = 0
    const result = []
    for (const byte of bytes) {
      value = (value << 8) | byte
      bits += 8
      while (bits >= 5) {
        bits -= 5
        result.push((value >> bits) & 31)
      }
    }
    if (bits > 0) result.push((value << (5 - bits)) & 31)
    return result
  }

  function fromWords(words) {
    let value = 0
    let bits = 0
    const result = []
    for (const word of words) {
      value = (value << 5) | word
      bits += 5
      while (bits >= 8) {
        bits -= 8
        result.push((value >> bits) & 255)
      }
    }
    if (bits >= 5) throw new Error('Excess padding')
    if ((value << (8 - bits)) & 255) throw new Error('Non-zero padding')
    return Uint8Array.from(result)
  }

  window.bech32 = { encode, decode, toWords, fromWords }
})()
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/darren/WebstormProjects/402-pub && node --test test/bech32.test.mjs`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bech32.js test/bech32.test.mjs
git commit -m "feat: add bech32 encode/decode library (BIP-173)"
```

---

### Task 2: NIP-19 naddr Encode/Decode

**Files:**
- Create: `nip19.js`
- Create: `test/nip19.test.mjs`

- [ ] **Step 1: Write the test file**

Create `test/nip19.test.mjs`:

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const dir = dirname(fileURLToPath(import.meta.url))

function loadNip19() {
  const context = { window: {} }
  vm.createContext(context)
  // Load bech32 first (nip19 depends on it)
  vm.runInContext(readFileSync(join(dir, '..', 'bech32.js'), 'utf8'), context)
  vm.runInContext(readFileSync(join(dir, '..', 'nip19.js'), 'utf8'), context)
  return context.window.nip19
}

describe('nip19 naddr', () => {
  const nip19 = loadNip19()

  it('round-trips a kind 31402 naddr', () => {
    const input = {
      kind: 31402,
      pubkey: '7ff69c072127407d7b56712c407e6a95cababdb8c934e49aef869f08b238d898',
      dTag: 'jokes-api',
      relays: ['wss://relay.damus.io'],
    }
    const encoded = nip19.encodeNaddr(input)
    assert.ok(encoded.startsWith('naddr1'))
    const decoded = nip19.decodeNaddr(encoded)
    assert.equal(decoded.kind, 31402)
    assert.equal(decoded.pubkey, input.pubkey)
    assert.equal(decoded.dTag, 'jokes-api')
    assert.deepEqual(decoded.relays, ['wss://relay.damus.io'])
  })

  it('round-trips naddr with no relays', () => {
    const input = {
      kind: 31402,
      pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
      dTag: 'my-service',
      relays: [],
    }
    const encoded = nip19.encodeNaddr(input)
    const decoded = nip19.decodeNaddr(encoded)
    assert.equal(decoded.kind, input.kind)
    assert.equal(decoded.pubkey, input.pubkey)
    assert.equal(decoded.dTag, 'my-service')
    assert.deepEqual(decoded.relays, [])
  })

  it('round-trips naddr with multiple relays', () => {
    const input = {
      kind: 31402,
      pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
      dTag: 'test',
      relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    }
    const encoded = nip19.encodeNaddr(input)
    const decoded = nip19.decodeNaddr(encoded)
    assert.deepEqual(decoded.relays, ['wss://relay.damus.io', 'wss://nos.lol'])
  })

  it('round-trips naddr with empty d-tag', () => {
    const input = {
      kind: 30023,
      pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
      dTag: '',
      relays: [],
    }
    const encoded = nip19.encodeNaddr(input)
    const decoded = nip19.decodeNaddr(encoded)
    assert.equal(decoded.dTag, '')
    assert.equal(decoded.kind, 30023)
  })

  it('rejects non-naddr strings', () => {
    assert.throws(() => {
      nip19.decodeNaddr('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg')
    }, /not an naddr/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/darren/WebstormProjects/402-pub && node --test test/nip19.test.mjs`
Expected: FAIL — `nip19.js` does not exist yet.

- [ ] **Step 3: Implement nip19.js**

Create `nip19.js` — NIP-19 naddr TLV encode/decode. Depends on `window.bech32`.

```js
/**
 * nip19.js — NIP-19 naddr encode/decode
 *
 * TLV types:
 *   0 = d-tag (UTF-8 string)
 *   1 = relay (UTF-8 string, repeatable)
 *   2 = author pubkey (32 bytes)
 *   3 = kind (32-bit unsigned int, big-endian)
 *
 * Depends on window.bech32 (from bech32.js).
 * Exposes window.nip19 = { encodeNaddr, decodeNaddr }
 */
;(function () {
  'use strict'

  const { encode, decode, toWords, fromWords } = window.bech32
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  /**
   * Encode an naddr from its components.
   *
   * @param {{ kind: number, pubkey: string, dTag: string, relays: string[] }} params
   * @returns {string} bech32 naddr string
   */
  function encodeNaddr({ kind, pubkey, dTag, relays }) {
    const buf = []

    // TLV 0: d-tag
    const dBytes = encoder.encode(dTag)
    buf.push(0, dBytes.length, ...dBytes)

    // TLV 1: relays (repeatable)
    for (const relay of relays) {
      const rBytes = encoder.encode(relay)
      buf.push(1, rBytes.length, ...rBytes)
    }

    // TLV 2: author pubkey (32 bytes from hex)
    const pkBytes = Uint8Array.from(pubkey.match(/.{2}/g).map(h => parseInt(h, 16)))
    buf.push(2, 32, ...pkBytes)

    // TLV 3: kind (32-bit big-endian)
    buf.push(3, 4, (kind >> 24) & 0xff, (kind >> 16) & 0xff, (kind >> 8) & 0xff, kind & 0xff)

    const words = toWords(Uint8Array.from(buf))
    return encode('naddr', words, false)
  }

  /**
   * Decode an naddr string into its components.
   *
   * @param {string} str - bech32 naddr string
   * @returns {{ kind: number, pubkey: string, dTag: string, relays: string[] }}
   */
  function decodeNaddr(str) {
    const { prefix, words } = decode(str, false)
    if (prefix !== 'naddr') throw new Error('not an naddr: prefix is ' + prefix)

    const bytes = fromWords(words)
    let dTag = ''
    const relays = []
    let pubkey = ''
    let kind = 0

    let i = 0
    while (i < bytes.length) {
      const type = bytes[i]
      const len = bytes[i + 1]
      const value = bytes.slice(i + 2, i + 2 + len)
      i += 2 + len

      switch (type) {
        case 0: // d-tag
          dTag = decoder.decode(value)
          break
        case 1: // relay
          relays.push(decoder.decode(value))
          break
        case 2: // author pubkey
          pubkey = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('')
          break
        case 3: // kind
          kind = (value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]
          break
        // Ignore unknown TLV types per NIP-19 spec
      }
    }

    return { kind, pubkey, dTag, relays }
  }

  window.nip19 = { encodeNaddr, decodeNaddr }
})()
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/darren/WebstormProjects/402-pub && node --test test/nip19.test.mjs`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nip19.js test/nip19.test.mjs
git commit -m "feat: add NIP-19 naddr encode/decode"
```

---

### Task 3: Script Tags in index.html

**Files:**
- Modify: `index.html:165`

- [ ] **Step 1: Add script tags before app.js**

In `index.html`, add the two new scripts before the existing `app.js` script tag. Change line 165 from:

```html
  <script src="app.js"></script>
```

to:

```html
  <script src="bech32.js"></script>
  <script src="nip19.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 2: Verify the page loads locally**

Run: `cd /Users/darren/WebstormProjects/402-pub && npx serve . -l 8402 &`
Open `http://localhost:8402` — page should load normally with no console errors.
Kill the server after checking.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: load bech32 and nip19 scripts"
```

---

### Task 4: Hash Routing + Loading Modal

**Files:**
- Modify: `app.js` (add deep-link handling after `connectAll()` at line 2420)
- Modify: `app.js` (modify `handleEvent()` to check for pending deep-link)
- Modify: `app.js` (modify `showServiceDetail()` to update location.hash)

- [ ] **Step 1: Add deep-link state variables and loading modal function**

After the constants section (after line 53) in `app.js`, add:

```js
/* ============================================================
   Deep-Link State
   ============================================================ */

/** Pending deep-link target: { pubkey, dTag, kind, relays } or null */
let pendingDeepLink = null

/** Timeout ID for deep-link "not found" state */
let deepLinkTimeout = null
```

- [ ] **Step 2: Add showDeepLinkLoading function**

Before the `showServiceDetail` function (before line 1339), add a function that shows a loading modal:

```js
/**
 * Shows a loading modal for a pending deep-link while we wait for the
 * matching event to arrive from relays.
 */
function showDeepLinkLoading() {
  const existing = document.getElementById('service-modal')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'service-modal'
  overlay.className = 'modal-overlay'
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      clearDeepLink()
      overlay.remove()
    }
  })

  const modal = document.createElement('div')
  modal.className = 'modal-content modal-loading'

  const closeBtn = document.createElement('button')
  closeBtn.className = 'modal-close'
  closeBtn.textContent = '\u00d7'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.addEventListener('click', () => {
    clearDeepLink()
    overlay.remove()
  })
  modal.appendChild(closeBtn)

  const spinner = document.createElement('div')
  spinner.className = 'modal-spinner'
  spinner.textContent = 'Connecting to relays\u2026'
  modal.appendChild(spinner)

  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      clearDeepLink()
      overlay.remove()
      document.removeEventListener('keydown', handleEsc)
    }
  }
  document.addEventListener('keydown', handleEsc)
}

/**
 * Replaces the loading modal content with a "not found" message.
 */
function showDeepLinkNotFound() {
  const modal = document.querySelector('#service-modal .modal-content')
  if (!modal) return

  const spinner = modal.querySelector('.modal-spinner')
  if (spinner) {
    spinner.textContent = 'Service not found on connected relays.'
    spinner.className = 'modal-not-found'
  }
}

/** Clears deep-link state and timeout. */
function clearDeepLink() {
  pendingDeepLink = null
  if (deepLinkTimeout) {
    clearTimeout(deepLinkTimeout)
    deepLinkTimeout = null
  }
  // Clear hash without triggering scroll
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
}
```

- [ ] **Step 3: Modify handleEvent to resolve pending deep-links**

In `handleEvent()`, after the line `services.set(key, {` block (after the `renderServices()` call on line 360), add a check for the pending deep-link:

```js
  // Check if this event resolves a pending deep-link
  if (pendingDeepLink && event.pubkey === pendingDeepLink.pubkey && dTag === pendingDeepLink.dTag) {
    pendingDeepLink = null
    if (deepLinkTimeout) {
      clearTimeout(deepLinkTimeout)
      deepLinkTimeout = null
    }
    showServiceDetail(services.get(key))
  }
```

Insert this right after the `renderServices()` call on line 360, before the closing `}` of `handleEvent`.

- [ ] **Step 4: Add hash routing to the initialisation section**

After `connectAll()` on line 2420, add the deep-link check. Note: the destructured variable must avoid shadowing the module-level `relays` Map (line 127), so we use `decoded.relays` instead.

```js
// Deep-link: check for naddr in hash
;(function checkDeepLink() {
  const hash = window.location.hash.slice(1) // Remove leading #
  if (!hash.startsWith('naddr1')) return

  try {
    const decoded = window.nip19.decodeNaddr(hash)
    if (decoded.kind !== L402_KIND) {
      console.warn('Deep-link kind', decoded.kind, 'is not', L402_KIND)
      return
    }

    // Check if we already have this service (from cache or fast relay)
    const key = decoded.pubkey + ':' + decoded.dTag
    const existing = services.get(key)
    if (existing) {
      showServiceDetail(existing)
      return
    }

    // Connect to relay hints (if not already connected)
    for (const hint of decoded.relays) {
      if (typeof hint === 'string' && hint.startsWith('wss://') && !relays.has(hint)) {
        connectToRelay(hint)
      }
    }

    // Show loading modal and set timeout
    pendingDeepLink = { pubkey: decoded.pubkey, dTag: decoded.dTag }
    showDeepLinkLoading()
    deepLinkTimeout = setTimeout(() => {
      if (pendingDeepLink) {
        showDeepLinkNotFound()
        pendingDeepLink = null
      }
    }, 10_000)
  } catch (err) {
    console.warn('Invalid naddr in URL hash:', err.message)
  }
})()
```

- [ ] **Step 5: Run the tests and verify no regressions**

Run: `cd /Users/darren/WebstormProjects/402-pub && node --test test/bech32.test.mjs && node --test test/nip19.test.mjs`
Expected: All tests still pass.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: hash routing for naddr deep-links with loading modal"
```

---

### Task 5: Share Button in Detail Modal

**Files:**
- Modify: `app.js` (inside `showServiceDetail()` function, after topics section ~line 1566)
- Modify: `app.js` (update modal close to clear hash)

- [ ] **Step 1: Add share button to the modal**

Inside `showServiceDetail()`, after the topics section (after line 1566, before `overlay.appendChild(modal)`), add:

```js
  // --- Share button ---
  if (s.pubkey && s.identifier) {
    const shareSection = document.createElement('div')
    shareSection.className = 'modal-section modal-share-section'

    const shareBtn = document.createElement('button')
    shareBtn.className = 'btn-share'
    shareBtn.textContent = 'Copy share link'
    shareBtn.addEventListener('click', () => {
      const naddr = window.nip19.encodeNaddr({
        kind: L402_KIND,
        pubkey: s.pubkey,
        dTag: s.identifier,
        relays: [],
      })
      history.replaceState(null, '', '#' + naddr)
      const url = window.location.href
      navigator.clipboard.writeText(url).then(() => {
        shareBtn.textContent = 'Copied!'
        setTimeout(() => { shareBtn.textContent = 'Copy share link' }, 1500)
      }).catch(() => {
        shareBtn.textContent = 'Error'
        setTimeout(() => { shareBtn.textContent = 'Copy share link' }, 1500)
      })
    })
    shareSection.appendChild(shareBtn)
    modal.appendChild(shareSection)
  }
```

- [ ] **Step 2: Clear hash when modal closes**

In the `showServiceDetail()` function, update the three close handlers (overlay click, close button click, Escape key) to also clear the hash. Add this line to each close path:

```js
history.replaceState(null, '', window.location.pathname + window.location.search)
```

For the overlay click handler (~line 1353):
```js
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove()
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  })
```

For the close button handler (~line 1365):
```js
  closeBtn.addEventListener('click', () => {
    overlay.remove()
    history.replaceState(null, '', window.location.pathname + window.location.search)
  })
```

For the Escape key handler (~line 1576):
```js
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      overlay.remove()
      history.replaceState(null, '', window.location.pathname + window.location.search)
      document.removeEventListener('keydown', handleEsc)
    }
  }
```

- [ ] **Step 3: Add CSS for the share button and loading modal**

In `style.css`, add these styles (at the end of the modal styles section):

```css
.modal-share-section {
  border-top: 1px solid var(--border);
  padding-top: 1rem;
  display: flex;
  justify-content: center;
}

.btn-share {
  background: var(--accent);
  color: var(--bg);
  border: none;
  padding: 0.5rem 1.25rem;
  border-radius: 6px;
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
  transition: opacity 0.15s;
}
.btn-share:hover { opacity: 0.85; }

.modal-loading .modal-spinner,
.modal-loading .modal-not-found {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-muted);
  font-size: 0.95rem;
}

.modal-not-found {
  color: var(--text-secondary);
}
```

- [ ] **Step 4: Verify locally**

Run: `cd /Users/darren/WebstormProjects/402-pub && npx serve . -l 8402 &`
1. Open `http://localhost:8402` — page loads normally
2. Click a service card "Details" button — modal should show share button
3. Click "Copy share link" — URL bar should update with `#naddr1...`, clipboard should have the full URL
4. Copy the URL, open in a new tab — should show loading modal, then the service detail
5. Close the modal — hash should clear from URL bar
Kill the server after checking.

- [ ] **Step 5: Run all tests**

Run: `cd /Users/darren/WebstormProjects/402-pub && node --test test/bech32.test.mjs && node --test test/nip19.test.mjs`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add app.js style.css
git commit -m "feat: share button and hash cleanup in service modal"
```

---

### Task 6: Publish NIP-89 Handler Event

This task is done manually via nostr-bray MCP tools after the code is deployed.

**Files:** None (uses nostr-bray MCP tools)

- [ ] **Step 1: Deploy the code changes**

Push the branch to origin and merge to main (or push directly to main if that's the workflow). GitHub Pages will auto-deploy.

```bash
cd /Users/darren/WebstormProjects/402-pub && git push origin main
```

- [ ] **Step 2: Verify deep-linking works on production**

Open `https://402.pub` — page loads normally. Click a service, click "Copy share link", open the URL in a new tab. The deep-link should work.

- [ ] **Step 3: Publish the NIP-89 handler event**

Using nostr-bray MCP, publish a kind 31990 event. Use the `relay-query` tool or a dedicated publish tool:

The event to publish:
```json
{
  "kind": 31990,
  "content": "{\"name\":\"402.pub\",\"about\":\"L402 service directory with live health checks, filtering, and trust tiers\",\"picture\":\"https://402.pub/icon.svg\"}",
  "tags": [
    ["d", "402-pub-l402"],
    ["k", "31402"],
    ["web", "https://402.pub/#<bech32>", "naddr"]
  ]
}
```

Publish to the default relay set (relay.damus.io, nos.lol, relay.nostr.band, etc.).

- [ ] **Step 4: Verify on NostrHub**

Check `https://nostrhub.io` to confirm 402.pub appears as a handler for kind 31402.

- [ ] **Step 5: Commit any final adjustments**

If any tweaks were needed after production testing, commit them.
