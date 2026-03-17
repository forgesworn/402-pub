/**
 * app.js — Live discovery dashboard for kind 31402 Nostr events
 *
 * Connects to multiple Nostr relays, subscribes to kind 31402 service
 * announcements, and renders them in a filterable grid.
 *
 * XSS safety: ALL untrusted strings from Nostr events are set via
 * .textContent on DOM elements — never innerHTML. The entire UI is built
 * using createElement + textContent, which is inherently injection-safe.
 * URLs from events are validated via isSafeHttpUrl() (http(s) only,
 * no private IPs) before being assigned to href or src attributes.
 */

/* ============================================================
   Constants
   ============================================================ */

const L402_KIND = 31402

const DEFAULT_RELAYS = [
  'wss://relay.trotters.cc',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
]

/** localStorage key for user-added relay URLs */
const STORAGE_KEY = 'l402-dashboard-relays'

/** Maximum reconnect backoff in milliseconds (30 s) */
const RECONNECT_MAX = 30_000

/** Maximum number of services to store (prevents memory exhaustion from relay flood) */
const MAX_SERVICES = 500

/* ============================================================
   URL Validation
   ============================================================ */

/**
 * Returns true if the URL is a safe, publicly-routable http(s) URL.
 * Blocks javascript:, data:, and other non-HTTP schemes.
 * Blocks localhost, loopback, and private network addresses.
 *
 * @param {string} urlStr - URL string to validate
 * @returns {boolean}
 */
function isSafeHttpUrl(urlStr) {
  try {
    const parsed = new URL(urlStr)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    // Strip brackets from IPv6 and trailing dot from FQDN for comparison
    const h = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
    // Loopback
    if (h === 'localhost' || h === '0.0.0.0' || h === '0' || h === '::1' || h === '::') return false
    if (h.startsWith('127.')) return false
    // RFC 1918 + link-local IPv4
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h)) return false
    // Private / link-local IPv6 (fc00::/7 unique-local, fe80::/10 link-local)
    if (/^(fc|fd|fe[89ab])/i.test(h)) return false
    // IPv4-mapped IPv6 (::ffff:x.x.x.x) — browsers normalise to hex (::ffff:7f00:1)
    // Parse the two hex words back to an IPv4 address and re-check
    const ffffMatch = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
    if (ffffMatch) {
      const hi = parseInt(ffffMatch[1], 16)
      const lo = parseInt(ffffMatch[2], 16)
      const mapped = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      if (mapped.startsWith('127.') || mapped === '0.0.0.0' ||
          /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(mapped)) return false
    }
    return true
  } catch {
    return false
  }
}

/* ============================================================
   Relay Manager
   ============================================================ */

/**
 * Per-relay state:
 *   url        {string}   WebSocket URL
 *   ws         {WebSocket|null}
 *   status     {'connecting'|'connected'|'disconnected'}
 *   backoff    {number}   Current reconnect delay in ms
 */
const relays = new Map()

/** Returns the merged list of default + user-supplied relay URLs. */
function getRelayUrls() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (Array.isArray(stored) && stored.length > 0) {
      const valid = stored.filter(s => typeof s === 'string' && s.startsWith('wss://'))
      if (valid.length > 0) return [...new Set([...DEFAULT_RELAYS, ...valid])]
    }
  } catch {
    // Ignore parse errors — fall through to defaults
  }
  return [...DEFAULT_RELAYS]
}

/**
 * Opens (or reopens) a WebSocket connection to a relay URL.
 * On success, sends a REQ for all kind 31402 events.
 * On close, schedules an exponential-backoff reconnect.
 *
 * @param {string} url - WebSocket relay URL
 */
function connectToRelay(url) {
  const existing = relays.get(url)
  const state = existing || { url, ws: null, status: 'disconnected', backoff: 1000 }
  if (!existing) relays.set(url, state)

  state.status = 'connecting'
  renderRelayStatus()

  try {
    const ws = new WebSocket(url)
    state.ws = ws

    ws.onopen = () => {
      state.status = 'connected'
      state.backoff = 1000 // Reset backoff on successful connect
      renderRelayStatus()

      // Subscribe to all kind 31402 events (past + future)
      const subId = 'l402-' + Math.random().toString(36).slice(2, 8)
      ws.send(JSON.stringify(['REQ', subId, { kinds: [L402_KIND] }]))
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg[0] === 'EVENT' && msg[2]) {
          handleEvent(msg[2])
        } else if (msg[0] === 'EOSE') {
          handleEose(url)
        } else if (msg[0] === 'NOTICE') {
          console.log('[' + url + '] NOTICE:', msg[1])
        }
      } catch {
        // Silently discard malformed relay messages
      }
    }

    ws.onclose = () => {
      state.status = 'disconnected'
      state.ws = null
      renderRelayStatus()
      // Schedule reconnect with capped exponential backoff
      setTimeout(() => connectToRelay(url), state.backoff)
      state.backoff = Math.min(state.backoff * 2, RECONNECT_MAX)
    }

    ws.onerror = () => {
      // onclose always fires after onerror — backoff is handled there
    }
  } catch {
    // WebSocket constructor can throw for invalid URLs
    state.status = 'disconnected'
    renderRelayStatus()
    setTimeout(() => connectToRelay(url), state.backoff)
    state.backoff = Math.min(state.backoff * 2, RECONNECT_MAX)
  }
}

/** Opens connections to all configured relay URLs. */
function connectAll() {
  getRelayUrls().forEach(connectToRelay)
}

/* ============================================================
   Event Store
   ============================================================ */

/**
 * De-duplicated service map.
 * Key: `${pubkey}:${dTag}` — one entry per (publisher, identifier) pair.
 * Value: parsed service object (see handleEvent).
 */
const services = new Map()

/** Keys of services that were just added (not updated). Cleared after render. */
const newlyAddedKeys = new Set()

/** Number of relays that have sent EOSE — used to hide the loading indicator. */
let eoseCount = 0

/**
 * Processes a raw Nostr event. Validates it is a kind 31402 event with
 * all required tags, checks NIP-40 expiration, de-duplicates by
 * (pubkey, d-tag), and upserts the service store.
 *
 * @param {object} event - Raw Nostr event object
 */
function handleEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return
  if (event.kind !== L402_KIND) return
  if (!Array.isArray(event.tags)) return

  const tags = event.tags

  /** Returns the first value of a named tag, or undefined. */
  const getTag = (name) => tags.find(t => t[0] === name)?.[1]

  /** Returns all tags with a given name. */
  const getTags = (name) => tags.filter(t => t[0] === name)

  const dTag = getTag('d')
  const name = getTag('name')
  const url = getTag('url')
  const about = getTag('about')

  // Require all four mandatory fields
  if (!dTag || !name || !url || !about) return

  // Validate URL: must be http(s), not localhost/private networks
  if (!isSafeHttpUrl(url)) return

  // NIP-40: honour event expiration (NaN or missing = never expires)
  const expiration = getTag('expiration')
  if (expiration) {
    const exp = parseInt(expiration, 10)
    if (Number.isFinite(exp) && exp < Math.floor(Date.now() / 1000)) return
  }

  // Deduplicate: keep the most recently created version
  const key = event.pubkey + ':' + dTag
  const existing = services.get(key)
  if (existing && existing.createdAt >= event.created_at) return

  // Cap total service count to prevent memory exhaustion from relay flood
  if (!existing && services.size >= MAX_SERVICES) return

  // Track genuinely new services (not updates to existing ones)
  if (!existing) newlyAddedKeys.add(key)

  // Parse pricing tags: ['price', capability, amount, currency]
  const pricing = getTags('price').map(t => {
    const raw = parseFloat(t[2])
    return {
      capability: t[1] || '',
      price: Number.isFinite(raw) && raw >= 0 ? raw : 0,
      currency: t[3] || 'sats',
    }
  })

  // Parse payment method identifiers (pmi tags)
  const paymentMethods = getTags('pmi').map(t => t[1]).filter(Boolean)

  // Parse topic tags
  const topics = getTags('t').map(t => t[1]).filter(Boolean)

  // Optionally parse JSON content for capabilities + version
  let capabilities, version
  try {
    if (event.content) {
      const content = JSON.parse(event.content)
      capabilities = content.capabilities
      version = content.version
    }
  } catch {
    // Content is optional — ignore parse failures
  }

  services.set(key, {
    id: event.id,
    pubkey: event.pubkey,
    identifier: dTag,
    name,
    url,
    about,
    picture: getTag('picture'),
    pricing,
    paymentMethods,
    topics,
    capabilities,
    version,
    createdAt: event.created_at,
    source: 'nostr',
  })

  renderServices()
}

/**
 * Called when a relay sends EOSE (End of Stored Events).
 * Hides the loading indicator after the first relay responds.
 *
 * @param {string} url - The relay that sent EOSE
 */
function handleEose(url) {
  eoseCount++
  const loading = document.getElementById('loading')
  if (loading) loading.hidden = true
  renderServices()
}

/* ============================================================
   UI Renderer
   ============================================================ */

// Current filter state
let searchQuery = ''
let activePaymentFilters = new Set()
let activeTopicFilters = new Set()

/**
 * Rebuilds the relay status row in the header.
 * Each relay gets a coloured dot + text label (colour-blind safe).
 * All relay URLs (including user-added ones from localStorage) are escaped.
 */
function renderRelayStatus() {
  const container = document.getElementById('relay-status')
  if (!container) return

  const relayList = [...relays.values()]
  const connected = relayList.filter(r => r.status === 'connected').length

  const relayCountEl = document.getElementById('relay-count')
  if (relayCountEl) {
    relayCountEl.textContent = connected + ' relay' + (connected !== 1 ? 's' : '') + ' connected'
  }

  // Build each relay indicator using safe DOM construction
  // (not innerHTML) since relay URLs may come from localStorage
  container.textContent = ''

  relayList.forEach(r => {
    let colour, label
    switch (r.status) {
      case 'connected':  colour = '#22c55e'; label = 'Connected';    break
      case 'connecting': colour = '#f59e0b'; label = 'Connecting';   break
      default:           colour = '#ef4444'; label = 'Disconnected'; break
    }

    let host
    try {
      host = new URL(r.url).hostname
    } catch {
      host = r.url
    }

    const wrapper = document.createElement('span')
    wrapper.className = 'relay-dot'
    wrapper.title = r.url + ' — ' + label
    wrapper.style.setProperty('--dot-colour', colour)

    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.setAttribute('aria-hidden', 'true')

    const labelEl = document.createElement('span')
    labelEl.className = 'relay-label'
    labelEl.textContent = host + ' (' + label + ')'

    wrapper.appendChild(dot)
    wrapper.appendChild(labelEl)
    container.appendChild(wrapper)
  })

  // Update hero relay count
  const heroRelayCountEl = document.getElementById('hero-relay-count')
  if (heroRelayCountEl) {
    heroRelayCountEl.textContent = connected
  }
}

/**
 * Applies current filters to the service store, sorts by recency,
 * and re-renders the services grid and filter pills.
 */
function renderServices() {
  const grid = document.getElementById('services-grid')
  const emptyState = document.getElementById('empty-state')
  const allServices = [...services.values()]

  // Rebuild filter pills based on all available services
  renderFilterPills(allServices)

  // Apply search query
  let filtered = allServices
  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    filtered = filtered.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.about.toLowerCase().includes(q) ||
      s.topics.some(t => t.toLowerCase().includes(q))
    )
  }

  // Apply payment method filters (AND logic — must have all selected)
  if (activePaymentFilters.size > 0) {
    filtered = filtered.filter(s =>
      [...activePaymentFilters].every(f => s.paymentMethods.includes(f))
    )
  }

  // Apply topic filters (AND logic)
  if (activeTopicFilters.size > 0) {
    filtered = filtered.filter(s =>
      [...activeTopicFilters].every(f => s.topics.includes(f))
    )
  }

  // Sort by most recently announced first
  filtered.sort((a, b) => b.createdAt - a.createdAt)

  // Update service count in toolbar (with bounce animation on change)
  const nostrCount = allServices.filter(s => s.source === 'nostr').length
  const indexedCount = allServices.length - nostrCount
  const countEl = document.getElementById('service-count')
  const newText =
    allServices.length + ' live service' + (allServices.length !== 1 ? 's' : '') +
    (nostrCount > 0 && indexedCount > 0
      ? ' (' + nostrCount + ' streaming, ' + indexedCount + ' indexed)'
      : '')

  if (countEl.textContent !== newText) {
    countEl.textContent = newText
    countEl.classList.add('count-updated')
    setTimeout(() => countEl.classList.remove('count-updated'), 350)
  }

  // Show empty state if filters produced no results but services exist
  if (filtered.length === 0 && allServices.length > 0) {
    grid.textContent = ''
    emptyState.hidden = false
    return
  }

  emptyState.hidden = true

  // Build cards via safe DOM fragment
  const fragment = document.createDocumentFragment()
  filtered.forEach(s => {
    const card = buildCard(s)

    // Flash new services (from Nostr or external sources)
    const key = s.pubkey + ':' + s.identifier
    const extKey = 'ext:' + s.source + ':' + s.identifier
    if (newlyAddedKeys.has(key) || newlyAddedKeys.has(extKey)) {
      card.classList.add('service-new')
      // Remove class after animation completes so hover styles work normally
      setTimeout(() => card.classList.remove('service-new'), 3000)
    }

    fragment.appendChild(card)
  })

  // Clear newly-added tracking after render
  newlyAddedKeys.clear()

  grid.textContent = ''
  grid.appendChild(fragment)

  // Attach clipboard handlers to "Copy" buttons
  grid.querySelectorAll('.copy-pubkey').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.pubkey).then(() => {
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.textContent = 'Copy' }, 1500)
      }).catch(() => {
        btn.textContent = 'Error'
        setTimeout(() => { btn.textContent = 'Copy' }, 1500)
      })
    })
  })

  // Kick off async health checks for all visible service cards
  updateHealthDots()

  // Update hero stat pills
  updateHeroStats()
}

/**
 * Builds a service card as a DOM element tree.
 * All untrusted strings are set via .textContent — never innerHTML.
 *
 * Layout: single-column flow
 *   1. Header row:  [icon] name  ···  source-badge  timestamp
 *   2. URL link (subtle)
 *   3. Description
 *   4. Pricing chips (horizontal)
 *   5. Meta row: payment badges · topic pills
 *   6. Footer: pubkey + copy
 *
 * @param {object} s - Parsed service object
 * @returns {HTMLElement} The constructed article element
 */
function buildCard(s) {
  const article = document.createElement('article')
  article.className = 'service-card'

  // --- Header row ---
  const header = document.createElement('div')
  header.className = 'card-header'

  const headerLeft = document.createElement('div')
  headerLeft.className = 'card-header-left'

  if (s.picture && isSafeHttpUrl(s.picture)) {
    const img = document.createElement('img')
    img.src = s.picture
    img.alt = s.name + ' icon'
    img.className = 'service-icon'
    img.width = 32
    img.height = 32
    img.loading = 'lazy'
    headerLeft.appendChild(img)
  }

  // Health status dot
  const healthDot = document.createElement('span')
  healthDot.className = 'health-dot health-unknown'
  healthDot.title = 'Checking...'
  headerLeft.appendChild(healthDot)

  const nameEl = document.createElement('a')
  nameEl.href = s.url
  nameEl.target = '_blank'
  nameEl.rel = 'noopener noreferrer'
  nameEl.className = 'service-name'
  // Strip "@ <url>" suffix from name if present (some announcers include it)
  const atIdx = s.name.indexOf(' @ ')
  nameEl.textContent = atIdx > 0 ? s.name.slice(0, atIdx) : s.name
  headerLeft.appendChild(nameEl)

  const headerRight = document.createElement('div')
  headerRight.className = 'card-header-right'

  const sourceBadge = document.createElement('span')
  sourceBadge.className = 'badge source source-' + (s.source === 'nostr' ? 'nostr' : 'indexed')
  sourceBadge.textContent = s.source === 'nostr' ? 'Self-announced' : 'Indexed via ' + s.source
  headerRight.appendChild(sourceBadge)

  const timestampSpan = document.createElement('span')
  timestampSpan.className = 'timestamp'
  timestampSpan.title = new Date(s.createdAt * 1000).toISOString()
  timestampSpan.textContent = getTimeAgo(s.createdAt)
  headerRight.appendChild(timestampSpan)

  header.appendChild(headerLeft)
  header.appendChild(headerRight)
  article.appendChild(header)

  // --- URL ---
  const urlLink = document.createElement('a')
  urlLink.href = s.url
  urlLink.target = '_blank'
  urlLink.rel = 'noopener noreferrer'
  urlLink.className = 'service-url'
  urlLink.textContent = s.url
  article.appendChild(urlLink)

  // --- About (expandable on click) ---
  if (s.about) {
    const about = document.createElement('p')
    about.className = 'service-about'
    about.textContent = s.about
    about.addEventListener('click', () => about.classList.toggle('expanded'))
    article.appendChild(about)
  }

  // --- Pricing chips (collapse to 3 visible, "+N more" overflow) ---
  if (s.pricing.length > 0) {
    const pricingRow = document.createElement('div')
    pricingRow.className = 'pricing-row'
    pricingRow.setAttribute('aria-label', 'Pricing')

    const MAX_VISIBLE = 3
    const visiblePricing = s.pricing.slice(0, MAX_VISIBLE)
    const hiddenPricing = s.pricing.slice(MAX_VISIBLE)

    const buildChip = (p) => {
      const chip = document.createElement('span')
      chip.className = 'pricing-chip'

      const capName = document.createElement('span')
      capName.className = 'cap-name'
      capName.textContent = formatCapability(p.capability)

      const sep = document.createElement('span')
      sep.className = 'cap-sep'
      sep.textContent = '—'

      const capPrice = document.createElement('span')
      capPrice.className = 'cap-price'
      capPrice.textContent = p.price + ' ' + p.currency

      chip.appendChild(capName)
      chip.appendChild(sep)
      chip.appendChild(capPrice)
      return chip
    }

    visiblePricing.forEach(p => pricingRow.appendChild(buildChip(p)))

    if (hiddenPricing.length > 0) {
      const overflow = document.createElement('span')
      overflow.className = 'pricing-overflow'
      overflow.textContent = '+' + hiddenPricing.length + ' more'
      overflow.addEventListener('click', () => {
        hiddenPricing.forEach(p => pricingRow.insertBefore(buildChip(p), overflow))
        overflow.remove()
      })
      pricingRow.appendChild(overflow)
    }

    article.appendChild(pricingRow)
  }

  // --- Meta row: payment methods + topics ---
  const hasPayments = s.paymentMethods.length > 0
  const hasTopics = s.topics.length > 0

  if (hasPayments || hasTopics) {
    const meta = document.createElement('div')
    meta.className = 'card-meta'

    if (hasPayments) {
      s.paymentMethods.forEach(m => {
        const badge = document.createElement('span')
        badge.className = 'badge payment'
        badge.textContent = formatPaymentMethod(m)
        meta.appendChild(badge)
      })
    }

    if (hasPayments && hasTopics) {
      const sep = document.createElement('span')
      sep.className = 'meta-sep'
      sep.setAttribute('aria-hidden', 'true')
      meta.appendChild(sep)
    }

    if (hasTopics) {
      s.topics.forEach(t => {
        const pill = document.createElement('span')
        pill.className = 'badge topic'
        pill.textContent = t
        meta.appendChild(pill)
      })
    }

    article.appendChild(meta)
  }

  // --- Action buttons ---
  const actions = document.createElement('div')
  actions.className = 'card-actions'

  const visitBtn = document.createElement('a')
  visitBtn.href = s.url
  visitBtn.target = '_blank'
  visitBtn.rel = 'noopener noreferrer'
  visitBtn.className = 'btn-action btn-visit'
  visitBtn.textContent = 'Visit API \u2197'
  actions.appendChild(visitBtn)

  const curlBtn = document.createElement('button')
  curlBtn.className = 'btn-action btn-curl'
  curlBtn.dataset.url = s.url
  curlBtn.textContent = 'Copy curl'
  actions.appendChild(curlBtn)

  article.appendChild(actions)

  // --- Footer: pubkey ---
  if (s.pubkey) {
    const footer = document.createElement('div')
    footer.className = 'card-footer'

    const pubkeySpan = document.createElement('span')
    pubkeySpan.className = 'pubkey'

    const code = document.createElement('code')
    code.title = s.pubkey
    code.textContent = s.pubkey.slice(0, 8) + '...' + s.pubkey.slice(-4)
    pubkeySpan.appendChild(code)

    const copyBtn = document.createElement('button')
    copyBtn.className = 'copy-pubkey'
    copyBtn.dataset.pubkey = s.pubkey
    copyBtn.setAttribute('aria-label', 'Copy full public key')
    copyBtn.textContent = 'Copy'
    pubkeySpan.appendChild(copyBtn)

    footer.appendChild(pubkeySpan)
    article.appendChild(footer)
  }

  return article
}

/**
 * Rebuilds payment method and topic filter pill rows based on the
 * full set of available services (not the filtered subset).
 * Pills are built with DOM methods to avoid any injection risk from
 * payment method strings sourced from Nostr events.
 *
 * @param {Array} allServices - All parsed service objects
 */
function renderFilterPills(allServices) {
  const allPayments = [...new Set(allServices.flatMap(s => s.paymentMethods))].sort()
  const allTopics   = [...new Set(allServices.flatMap(s => s.topics))].sort()

  buildPillGroup(
    document.getElementById('payment-filters'),
    allPayments,
    activePaymentFilters,
    'payment',
    formatPaymentMethod
  )

  buildPillGroup(
    document.getElementById('topic-filters'),
    allTopics,
    activeTopicFilters,
    'topic',
    t => t
  )
}

/**
 * Replaces the contents of a pill container with buttons built via DOM methods.
 *
 * @param {HTMLElement} container
 * @param {string[]} values
 * @param {Set<string>} activeSet
 * @param {string} filterType   - 'payment' or 'topic'
 * @param {function} labelFn    - Maps a value to its display label
 */
function buildPillGroup(container, values, activeSet, filterType, labelFn) {
  container.textContent = ''
  if (values.length === 0) return

  values.forEach(value => {
    const btn = document.createElement('button')
    btn.className = 'pill' + (activeSet.has(value) ? ' active' : '')
    btn.dataset.filter = filterType
    btn.dataset.value = value
    btn.setAttribute('aria-pressed', String(activeSet.has(value)))
    btn.textContent = labelFn(value)
    container.appendChild(btn)
  })
}

/* ============================================================
   Utility Functions
   ============================================================ */

/**
 * Maps a payment method identifier to a short human-readable label.
 *
 * @param {string} m - Raw payment method identifier (e.g. 'l402', 'x402', 'cashu', 'xcashu')
 * @returns {string} Short label (e.g. 'L402', 'x402', 'Cashu', 'xCashu')
 */
function formatPaymentMethod(m) {
  switch (m) {
    case 'l402':   return 'L402'
    case 'x402':   return 'x402'
    case 'cashu':  return 'Cashu'
    case 'xcashu': return 'xCashu'
    default:       return m
  }
}

/**
 * Shortens a capability string for display. Strips full URLs down
 * to just "METHOD /path", e.g. "GET https://example.com/foo" → "GET /foo".
 *
 * @param {string} cap - Raw capability string
 * @returns {string} Shortened display string
 */
function formatCapability(cap) {
  // Match "METHOD https://host/path" and extract just "METHOD /path"
  const match = cap.match(/^(GET|POST|PUT|DELETE|PATCH)\s+https?:\/\/[^/]+(\/\S*)$/i)
  if (match) return match[1] + ' ' + match[2]
  return cap
}

/**
 * Returns a human-friendly relative time string for a Unix timestamp.
 *
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} e.g. 'just now', '5m ago', '2h ago'
 */
function getTimeAgo(timestamp) {
  const seconds = Math.floor(Date.now() / 1000) - timestamp
  if (seconds < 60)     return 'just now'
  if (seconds < 3600)   return Math.floor(seconds / 60) + 'm ago'
  if (seconds < 86400)  return Math.floor(seconds / 3600) + 'h ago'
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago'
  return new Date(timestamp * 1000).toLocaleDateString()
}

/* ============================================================
   External Directory Sources
   ============================================================ */

/**
 * Fetches services from external L402 directories and merges them
 * into the service store. Each indexed service is marked with its
 * source so cards can display provenance badges.
 *
 * Nostr self-announced services always take precedence — if a service
 * exists in both Nostr and an external directory (matched by URL),
 * the Nostr version wins.
 */

const EXTERNAL_SOURCES = [
  // satring.com — disabled: CORS headers not set, browser fetch blocked.
  // Re-enable when they add Access-Control-Allow-Origin or use pre-seeded JSON.
  // { name: 'satring.com', url: 'https://satring.com/api/v1/services/bulk', parse: parseSatringServices },
  {
    name: 'l402.directory',
    url: 'https://l402.directory/api/services',
    parse: parseL402DirectoryServices,
  },
]

/**
 * Fetches all external sources in parallel. Failures are logged
 * but do not affect other sources or the Nostr subscription.
 */
async function fetchExternalSources() {
  await Promise.allSettled(
    EXTERNAL_SOURCES.map(async (src) => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)
        const res = await fetch(src.url, { signal: controller.signal })
        clearTimeout(timeout)
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const data = await res.json()
        const parsed = src.parse(data, src.name)
        let added = 0
        parsed.forEach(svc => {
          // Only add if no Nostr self-announced version exists for this URL
          const existingByUrl = [...services.values()].find(
            s => s.url === svc.url && s.source === 'nostr'
          )
          if (existingByUrl) return

          const key = 'ext:' + src.name + ':' + svc.identifier

          // Respect MAX_SERVICES cap (allow updates to existing entries)
          if (!services.has(key) && services.size >= MAX_SERVICES) return

          if (!services.has(key)) newlyAddedKeys.add(key)
          services.set(key, svc)
          added++
        })
        console.log(`[${src.name}] Indexed ${added} services (${parsed.length} total, ${parsed.length - added} skipped — already on Nostr)`)
      } catch (err) {
        console.warn(`[${src.name}] Fetch failed:`, err.message || err)
      }
    })
  )
  renderServices()
}

/**
 * Parses the satring.com bulk API response into service objects.
 * Response is an array of service objects with name, url, description,
 * category_ids, protocol, status, pricing, etc.
 *
 * @param {Array} data - Raw API response array
 * @param {string} sourceName - Source identifier for provenance
 * @returns {Array} Parsed service objects
 */
function parseSatringServices(data, sourceName) {
  const items = Array.isArray(data) ? data : []
  return items
    .filter(s => s.name && s.url && s.status !== 'dead' && isSafeHttpUrl(s.url))
    .map(s => ({
      id: 'satring-' + (s.slug || s.name),
      pubkey: '',
      identifier: s.slug || s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: s.name,
      url: s.url,
      about: s.description || '',
      picture: s.logo_url || undefined,
      pricing: (s.endpoints || [])
        .filter(e => e.pricing)
        .map(e => ({
          capability: e.method + ' ' + (e.url || '').split('?')[0],
          price: e.pricing?.amount || 0,
          currency: e.pricing?.currency || 'sats',
        }))
        .slice(0, 5),
      paymentMethods: s.protocol === 'X402'
        ? ['x402']
        : ['l402'],
      topics: (s.category_ids || []).map(String),
      capabilities: undefined,
      version: undefined,
      createdAt: s.listed_at ? Math.floor(new Date(s.listed_at).getTime() / 1000) : 0,
      source: sourceName,
    }))
}

/**
 * Parses the l402.directory API response into service objects.
 * Response is { services: [...], count: N }.
 *
 * @param {object} data - Raw API response
 * @param {string} sourceName - Source identifier for provenance
 * @returns {Array} Parsed service objects
 */
function parseL402DirectoryServices(data, sourceName) {
  const items = data?.services || []
  return items
    .filter(s => s.name)
    .map(s => {
      const endpoints = s.endpoints || []
      // Pick the first safe URL from endpoints, then fall back to provider URL
      const candidates = [...endpoints.map(e => e.url), s.provider?.url].filter(Boolean)
      const safeUrl = candidates.find(u => isSafeHttpUrl(u))
      if (!safeUrl) return null
      return {
        id: 'l402dir-' + (s.service_id || s.name),
        pubkey: s.destination_pubkey || '',
        identifier: (s.service_id || s.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: s.name,
        url: safeUrl,
        about: s.description || '',
        picture: undefined,
        pricing: endpoints
          .filter(e => e.pricing && e.pricing.amount > 0)
          .map(e => ({
            capability: (e.method || 'GET') + ' ' + (e.url || '').split('?')[0],
            price: e.pricing.amount,
            currency: e.pricing.currency || 'sats',
          }))
          .slice(0, 5),
        paymentMethods: ['l402'],
        topics: (s.categories || []).filter(c => typeof c === 'string'),
        capabilities: undefined,
        version: undefined,
        createdAt: s.listed_at ? Math.floor(new Date(s.listed_at).getTime() / 1000) : 0,
        source: sourceName,
      }
    })
    .filter(Boolean)
}

/* ============================================================
   Event Listeners
   ============================================================ */

// Live search — re-render on every keystroke
document.getElementById('search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim()
  renderServices()
})

// Mobile filter toggle — inject button before the filter pills
;(function injectFilterToggle() {
  const toolbar = document.querySelector('.toolbar-filters')
  if (!toolbar) return
  const btn = document.createElement('button')
  btn.className = 'filter-toggle'
  btn.textContent = 'Filters'
  btn.setAttribute('aria-expanded', 'false')
  btn.addEventListener('click', () => {
    const pills = toolbar.querySelectorAll('.filter-pills')
    const showing = pills[0] && pills[0].classList.contains('show-mobile')
    pills.forEach(p => p.classList.toggle('show-mobile', !showing))
    btn.classList.toggle('active', !showing)
    btn.setAttribute('aria-expanded', String(!showing))
    btn.textContent = showing ? 'Filters' : 'Hide filters'
  })
  toolbar.insertBefore(btn, toolbar.querySelector('.filter-pills'))
})()

// Delegated click handler for filter pills (payment + topic)
// Pills are matched by data-filter attribute, set during buildPillGroup.
document.addEventListener('click', (e) => {
  const pill = e.target.closest('[data-filter]')
  if (!pill) return

  const { filter, value } = pill.dataset
  const set = filter === 'payment' ? activePaymentFilters : activeTopicFilters

  if (set.has(value)) {
    set.delete(value)
  } else {
    set.add(value)
  }

  renderServices()
})

// Smooth scroll for hero CTA buttons (respects prefers-reduced-motion)
document.addEventListener('click', (e) => {
  const cta = e.target.closest('#cta-operator, #cta-agent')
  if (!cta) return
  e.preventDefault()
  const href = cta.getAttribute('href')
  if (!href || !href.startsWith('#')) return
  const target = document.getElementById(href.slice(1))
  if (!target) return
  const behaviour = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  target.scrollIntoView({ behavior: behaviour })
})

// Copy curl command to clipboard
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-curl')
  if (!btn) return

  const url = btn.dataset.url
  // Strip control characters and single-quote the URL to prevent shell injection
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, '').replace(/'/g, "'\\''")
  const cmd = "curl -i '" + safeUrl + "' -H 'Accept: application/json'"
  navigator.clipboard.writeText(cmd).then(() => {
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy curl' }, 1500)
  }).catch(() => {
    btn.textContent = 'Error'
    setTimeout(() => { btn.textContent = 'Copy curl' }, 1500)
  })
})

/* ============================================================
   Health Check — All Relays Down Banner
   ============================================================ */

/**
 * Periodically checks whether every relay is disconnected.
 * If so, and no services have been loaded yet, shows an error banner.
 */
function checkAllDown() {
  const allDown = [...relays.values()].every(r => r.status === 'disconnected')
  const loading = document.getElementById('loading')
  if (!loading) return

  if (allDown && services.size === 0) {
    loading.hidden = false
    loading.textContent = 'Unable to connect to any relays. Check your connection or try again later.'
    loading.classList.add('error')
  }
}

setInterval(checkAllDown, 5000)

/* ============================================================
   Service Health Checks — Async HEAD Requests
   ============================================================ */

/** Cache of health check results: url → { up: boolean, checkedAt: number } */
const healthCache = new Map()

/** Health check timeout in milliseconds */
const HEALTH_TIMEOUT = 8000

/** Re-check interval: 5 minutes */
const HEALTH_RECHECK = 300_000

/**
 * Checks whether a service URL responds. Uses a no-cors fetch
 * (opaque response) since most APIs won't have CORS headers.
 * An opaque response still confirms the server is listening.
 *
 * @param {string} url - Service URL to check
 * @returns {Promise<boolean>} Whether the service responded
 */
async function checkServiceHealth(url) {
  const cached = healthCache.get(url)
  if (cached && Date.now() - cached.checkedAt < HEALTH_RECHECK) {
    return cached.up
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT)
    await fetch(url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal })
    clearTimeout(timeout)
    healthCache.set(url, { up: true, checkedAt: Date.now() })
    return true
  } catch {
    healthCache.set(url, { up: false, checkedAt: Date.now() })
    return false
  }
}

/**
 * Updates all health dots currently in the DOM. Called after
 * services are rendered. Runs checks in parallel with a small
 * stagger to avoid thundering herd.
 */
function updateHealthDots() {
  const dots = document.querySelectorAll('.health-dot')
  dots.forEach((dot, i) => {
    const card = dot.closest('.service-card')
    if (!card) return
    const urlEl = card.querySelector('.service-url')
    if (!urlEl) return
    const url = urlEl.href

    setTimeout(async () => {
      const up = await checkServiceHealth(url)
      dot.className = 'health-dot ' + (up ? 'health-up' : 'health-down')
      dot.title = up ? 'Responding' : 'Not responding'
      // Dim the entire card when the service is down.
      if (up) {
        card.classList.remove('service-down')
      } else {
        card.classList.add('service-down')
      }
    }, i * 200) // Stagger by 200ms per service
  })
}

/**
 * Updates the hero stat pills with live counts from the service store.
 * Called after every renderServices() to keep hero stats in sync.
 */
function updateHeroStats() {
  const allServices = [...services.values()]

  // Service count
  const serviceCountEl = document.getElementById('hero-service-count')
  if (serviceCountEl) serviceCountEl.textContent = allServices.length

  // Unique payment rail count (distinct pmi values across all services)
  const railCountEl = document.getElementById('hero-rail-count')
  if (railCountEl) {
    const uniqueRails = new Set(allServices.flatMap(s => s.paymentMethods))
    railCountEl.textContent = uniqueRails.size
  }

  // Connected relay count
  const relayCountEl = document.getElementById('hero-relay-count')
  if (relayCountEl) {
    const connected = [...relays.values()].filter(r => r.status === 'connected').length
    relayCountEl.textContent = connected
  }
}

/* ============================================================
   Initialise
   ============================================================ */

connectAll()
fetchExternalSources()

/* ============================================================
   Particle Network — Ambient Background Animation
   ============================================================ */

;(function particleNetwork() {
  const canvas = document.getElementById('particle-canvas')
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  const PARTICLE_COUNT = 40
  const CONNECTION_DISTANCE = 150
  const PARTICLE_COLOUR = 'rgba(245, 158, 11, 0.15)'
  const LINE_COLOUR = 'rgba(245, 158, 11, 0.05)'
  const TARGET_FPS = 30
  const FRAME_INTERVAL = 1000 / TARGET_FPS

  let particles = []
  let lastFrame = 0
  let animId = null
  let paused = false

  function resize() {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
  }

  function createParticles() {
    particles = []
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        radius: Math.random() * 1.5 + 0.8,
      })
    }
  }

  function tick(timestamp) {
    animId = requestAnimationFrame(tick)

    if (paused) return

    // Throttle to ~30 fps
    const delta = timestamp - lastFrame
    if (delta < FRAME_INTERVAL) return
    lastFrame = timestamp - (delta % FRAME_INTERVAL)

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Update positions
    for (const p of particles) {
      p.x += p.vx
      p.y += p.vy

      // Wrap around edges
      if (p.x < 0) p.x = canvas.width
      if (p.x > canvas.width) p.x = 0
      if (p.y < 0) p.y = canvas.height
      if (p.y > canvas.height) p.y = 0
    }

    // Draw connection lines
    ctx.strokeStyle = LINE_COLOUR
    ctx.lineWidth = 1
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x
        const dy = particles[i].y - particles[j].y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < CONNECTION_DISTANCE) {
          ctx.globalAlpha = 1 - (dist / CONNECTION_DISTANCE)
          ctx.beginPath()
          ctx.moveTo(particles[i].x, particles[i].y)
          ctx.lineTo(particles[j].x, particles[j].y)
          ctx.stroke()
        }
      }
    }

    // Draw particles
    ctx.globalAlpha = 1
    ctx.fillStyle = PARTICLE_COLOUR
    for (const p of particles) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Pause when tab is not visible
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden
  })

  // Respect prefers-reduced-motion
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  function handleMotionPref() {
    if (motionQuery.matches) {
      paused = true
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    } else {
      paused = document.hidden
    }
  }
  motionQuery.addEventListener('change', handleMotionPref)
  handleMotionPref()

  window.addEventListener('resize', () => {
    resize()
    createParticles()
  })

  resize()
  createParticles()
  animId = requestAnimationFrame(tick)
})()
