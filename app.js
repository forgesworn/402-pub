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
  'wss://relay.nostr.band',
  'wss://purplepag.es',
]

/** localStorage key for user-added relay URLs */
const STORAGE_KEY = 'l402-dashboard-relays'

/** Maximum reconnect backoff in milliseconds (30 s) */
const RECONNECT_MAX = 30_000

/** Maximum number of services to store (prevents memory exhaustion from relay flood) */
const MAX_SERVICES = 2000

/** 402.pub indexer pubkey — events from this key are "discovered", not self-announced */
const INDEXER_PUBKEY = '7ff69c072127407d7b56712c407e6a95cababdb8c934e49aef869f08b238d898'

/**
 * Trust tier constants.
 * Services are classified by origin into three tiers that control
 * display prominence, sort order, and filtering.
 */
const TIER_SELF = 'self'
const TIER_DISCOVERED = 'discovered'
const TIER_STALE = 'stale'

/* ============================================================
   PMI Normalisation (backward compatibility)
   ============================================================ */

/**
 * Normalises legacy payment method identifiers to the current format.
 * Old Nostr events on relays still use the long-form identifiers;
 * this maps them to the short identifiers the UI expects.
 *
 * @param {string} raw - Raw pmi tag value
 * @returns {string} Normalised identifier
 */
function normalisePmi(raw) {
  if (raw === 'bitcoin-lightning-bolt11') return 'l402'
  if (raw === 'bitcoin-cashu-xcashu') return 'xcashu'
  if (raw === 'bitcoin-cashu') return 'cashu'
  return raw
}

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
  // Normalise legacy identifiers (e.g. 'bitcoin-lightning-bolt11' → 'l402')
  // so stats, filters, and display all work consistently.
  const pmiTags = getTags('pmi')
  const paymentMethods = pmiTags.map(t => normalisePmi(t[1])).filter(Boolean)
  // Store full pmi tag arrays for detail view (rail-specific fields),
  // with the rail identifier (first element) normalised.
  const paymentMethodDetails = pmiTags
    .map(t => t.slice(1))
    .filter(a => a.length > 0)
    .map(parts => [normalisePmi(parts[0]), ...parts.slice(1)])

  // Parse topic tags
  const topics = getTags('t').map(t => t[1]).filter(Boolean)

  // Parse trust/discovery tags
  const eventSource = getTag('source')       // 'crawl', 'github', 'submit', 'self'
  const verified = getTag('verified')         // ISO timestamp of last health check
  const status = getTag('status')             // 'active', 'stale', 'unreachable'

  // Determine trust tier
  let trustTier
  if (status === 'stale' || status === 'unreachable') {
    trustTier = TIER_STALE
  } else if (event.pubkey === INDEXER_PUBKEY) {
    trustTier = TIER_DISCOVERED
  } else {
    trustTier = TIER_SELF
  }

  // Optionally parse JSON content for capabilities, version, and project links
  let capabilities, version, website, docs, repository
  try {
    if (event.content) {
      const content = JSON.parse(event.content)
      capabilities = content.capabilities
      version = content.version
      website = content.website
      docs = content.docs
      repository = content.repository
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
    paymentMethodDetails,
    topics,
    capabilities,
    version,
    website: website && isSafeHttpUrl(website) ? website : undefined,
    docs: docs && isSafeHttpUrl(docs) ? docs : undefined,
    repository: repository && isSafeHttpUrl(repository) ? repository : undefined,
    createdAt: event.created_at,
    source: 'nostr',
    trustTier,
    eventSource,
    verified,
    status: status || 'active',
    transports: detectTransports(url),
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
let activeRailFilter = 'all'   // 'all', 'l402', 'x402', 'cashu'
let activeTierFilter = 'all'   // 'all', 'self', 'discovered'
let activeTransportFilter = 'all' // 'all', 'https', 'http', 'onion', 'hns'

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

  // Apply payment rail filter (top-level rail buttons)
  if (activeRailFilter !== 'all') {
    filtered = filtered.filter(s => s.paymentMethods.includes(activeRailFilter))
  }

  // Apply trust tier filter
  if (activeTierFilter !== 'all') {
    filtered = filtered.filter(s => (s.trustTier || TIER_SELF) === activeTierFilter)
  }

  // Apply transport filter
  if (activeTransportFilter !== 'all') {
    filtered = filtered.filter(s =>
      s.transports && s.transports.includes(activeTransportFilter)
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

  // Sort: self-announced first, then discovered, then stale. Within each tier, by recency.
  const tierOrder = { [TIER_SELF]: 0, [TIER_DISCOVERED]: 1, [TIER_STALE]: 2 }
  filtered.sort((a, b) => {
    const ta = tierOrder[a.trustTier || TIER_SELF] ?? 1
    const tb = tierOrder[b.trustTier || TIER_SELF] ?? 1
    if (ta !== tb) return ta - tb
    return b.createdAt - a.createdAt
  })

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
  const tier = s.trustTier || TIER_SELF
  const article = document.createElement('article')
  article.className = 'service-card' + (tier === TIER_STALE ? ' service-stale' : '')
  article.dataset.serviceKey = s.pubkey + ':' + s.identifier

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

  // Trust tier badge
  const tierBadge = document.createElement('span')
  if (tier === TIER_DISCOVERED) {
    tierBadge.className = 'badge source source-discovered'
    const label = 'Discovered by 402.pub'
    if (s.verified) {
      tierBadge.textContent = label
      tierBadge.title = 'Last verified: ' + s.verified
    } else {
      tierBadge.textContent = label
    }
    headerRight.appendChild(tierBadge)

    if (s.verified) {
      const verifiedSpan = document.createElement('span')
      verifiedSpan.className = 'verified-time'
      verifiedSpan.textContent = 'Verified ' + getTimeAgoISO(s.verified)
      verifiedSpan.title = s.verified
      headerRight.appendChild(verifiedSpan)
    }
  } else if (tier === TIER_STALE) {
    tierBadge.className = 'badge source source-stale'
    tierBadge.textContent = s.status === 'unreachable' ? 'Unreachable' : 'Stale'
    headerRight.appendChild(tierBadge)

    if (s.verified) {
      const lastSeen = document.createElement('span')
      lastSeen.className = 'verified-time stale-time'
      lastSeen.textContent = 'Last seen ' + getTimeAgoISO(s.verified)
      lastSeen.title = s.verified
      headerRight.appendChild(lastSeen)
    }
  } else if (s.source !== 'nostr') {
    // External directory source
    tierBadge.className = 'badge source source-indexed'
    tierBadge.textContent = 'Indexed via ' + s.source
    headerRight.appendChild(tierBadge)
  }
  // Self-announced services: no qualifier badge (they are first-class)

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

  // --- Project links (website, docs, repository) ---
  const projectLinks = [
    s.website && { label: 'Website', url: s.website },
    s.docs && { label: 'Docs', url: s.docs },
    s.repository && { label: 'Source', url: s.repository },
  ].filter(Boolean)

  if (projectLinks.length > 0) {
    const linkRow = document.createElement('div')
    linkRow.className = 'project-links'
    projectLinks.forEach((link, i) => {
      if (i > 0) {
        const sep = document.createElement('span')
        sep.className = 'project-link-sep'
        sep.textContent = '\u00b7'
        linkRow.appendChild(sep)
      }
      const a = document.createElement('a')
      a.href = link.url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.className = 'project-link'
      a.textContent = link.label
      linkRow.appendChild(a)
    })
    article.appendChild(linkRow)
  }

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

  // --- Meta row: payment methods + transport badges + topics ---
  const hasPayments = s.paymentMethods.length > 0
  const hasTopics = s.topics.length > 0
  const hasTransports = s.transports && s.transports.length > 0

  if (hasPayments || hasTopics || hasTransports) {
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

    if (hasTransports) {
      s.transports.forEach(t => {
        const badge = document.createElement('span')
        badge.className = 'badge transport transport-' + t
        badge.textContent = formatTransport(t)
        meta.appendChild(badge)
      })
    }

    if ((hasPayments || hasTransports) && hasTopics) {
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

  const detailBtn = document.createElement('button')
  detailBtn.className = 'btn-action btn-detail'
  detailBtn.textContent = 'Details'
  detailBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    showServiceDetail(s)
  })
  actions.appendChild(detailBtn)

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
 * Also rebuilds the rail filter and trust tier filter rows.
 * Pills are built with DOM methods to avoid any injection risk from
 * payment method strings sourced from Nostr events.
 *
 * @param {Array} allServices - All parsed service objects
 */
function renderFilterPills(allServices) {
  const allPayments = [...new Set(allServices.flatMap(s => s.paymentMethods))].sort()
  const allTopics   = [...new Set(allServices.flatMap(s => s.topics))].sort()

  // Rail filter row
  buildExclusivePillGroup(
    document.getElementById('rail-filters'),
    [
      { value: 'all', label: 'All Rails' },
      { value: 'l402', label: 'L402' },
      { value: 'x402', label: 'x402' },
      { value: 'cashu', label: 'Cashu' },
    ],
    activeRailFilter,
    'rail'
  )

  // Trust tier filter row
  buildExclusivePillGroup(
    document.getElementById('tier-filters'),
    [
      { value: 'all', label: 'All Sources' },
      { value: TIER_SELF, label: 'Self-announced' },
      { value: TIER_DISCOVERED, label: 'Discovered' },
    ],
    activeTierFilter,
    'tier'
  )

  // Transport filter row — only show options that have at least one service
  const allTransports = [...new Set(allServices.flatMap(s => s.transports || []))]
  const transportOptions = [{ value: 'all', label: 'All Transports' }]
  ;['https', 'http', 'onion', 'hns'].forEach(t => {
    if (allTransports.includes(t)) {
      transportOptions.push({ value: t, label: formatTransport(t) })
    }
  })
  // Only render transport filter if there are at least 2 distinct transports
  if (allTransports.length >= 2) {
    buildExclusivePillGroup(
      document.getElementById('transport-filters'),
      transportOptions,
      activeTransportFilter,
      'transport'
    )
  } else {
    const transportContainer = document.getElementById('transport-filters')
    if (transportContainer) transportContainer.textContent = ''
  }

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
 * Builds an exclusive (radio-style) pill group where only one can be active.
 *
 * @param {HTMLElement} container
 * @param {Array<{value: string, label: string}>} options
 * @param {string} activeValue
 * @param {string} filterType
 */
function buildExclusivePillGroup(container, options, activeValue, filterType) {
  if (!container) return
  container.textContent = ''

  options.forEach(opt => {
    const btn = document.createElement('button')
    btn.className = 'pill' + (activeValue === opt.value ? ' active' : '')
    btn.dataset.filter = filterType
    btn.dataset.value = opt.value
    btn.setAttribute('aria-pressed', String(activeValue === opt.value))
    btn.textContent = opt.label
    container.appendChild(btn)
  })
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
  const n = normalisePmi(m)
  switch (n) {
    case 'l402':   return 'L402'
    case 'x402':   return 'x402'
    case 'cashu':  return 'Cashu'
    case 'xcashu': return 'xCashu'
    default:       return n
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
   Transport Detection
   ============================================================ */

/**
 * Known Handshake TLDs — non-ICANN top-level domains used on the
 * Handshake naming system. This list covers the most common ones.
 */
const HNS_TLDS = new Set([
  'hns', 'c', 'd', 'nb', 'p', 'ix', 'forever', 'x', 'badass',
])

/**
 * Detects the transport type(s) for a service URL.
 * Returns an array of transport identifiers.
 *
 * @param {string} urlStr - Service URL
 * @returns {string[]} Transport identifiers: 'https', 'http', 'onion', 'hns'
 */
function detectTransports(urlStr) {
  const transports = []
  try {
    const parsed = new URL(urlStr)
    const hostname = parsed.hostname.toLowerCase()

    // Onion check first — .onion domains may use http or https
    if (hostname.endsWith('.onion')) {
      transports.push('onion')
      return transports
    }

    // Handshake check — non-ICANN TLDs
    const parts = hostname.split('.')
    const tld = parts[parts.length - 1]
    if (tld && HNS_TLDS.has(tld)) {
      transports.push('hns')
      return transports
    }

    // Standard HTTP/HTTPS
    if (parsed.protocol === 'https:') {
      transports.push('https')
    } else if (parsed.protocol === 'http:') {
      transports.push('http')
    }
  } catch {
    // Invalid URL — no transports
  }
  return transports
}

/**
 * Maps a transport identifier to a short display label.
 *
 * @param {string} transport - Transport identifier
 * @returns {string} Human-readable label
 */
function formatTransport(transport) {
  switch (transport) {
    case 'https': return 'HTTPS'
    case 'http':  return 'HTTP'
    case 'onion': return 'Tor'
    case 'hns':   return 'HNS'
    default:      return transport
  }
}

/* ============================================================
   Trust Tier & Rail Filter UI
   ============================================================ */

/**
 * Returns a human-friendly relative time string for an ISO timestamp string.
 *
 * @param {string} isoStr - ISO 8601 timestamp
 * @returns {string} e.g. 'just now', '5m ago', '2h ago', '3d ago'
 */
function getTimeAgoISO(isoStr) {
  try {
    const ts = Math.floor(new Date(isoStr).getTime() / 1000)
    if (!Number.isFinite(ts)) return isoStr
    return getTimeAgo(ts)
  } catch {
    return isoStr
  }
}

/**
 * Maps a payment method identifier to a human-readable label with
 * additional detail for the service detail modal.
 *
 * @param {string[]} pmiParts - pmi tag elements (e.g. ['l402', 'lightning'] or ['x402', 'base', 'usdc', '0x...'])
 * @returns {string} Human-readable description
 */
function formatPaymentMethodDetail(pmiParts) {
  if (!pmiParts || pmiParts.length === 0) return 'Unknown'
  // Normalise the rail identifier (first element) for backward compatibility
  const rail = normalisePmi(pmiParts[0])
  switch (rail) {
    case 'l402':
      return 'L402 (Lightning)'
    case 'x402': {
      const network = pmiParts[1] || ''
      const asset = pmiParts[2] || ''
      const parts = ['x402']
      if (network) parts.push(network.charAt(0).toUpperCase() + network.slice(1))
      if (asset) parts.push(asset.toUpperCase())
      return parts.join(' / ')
    }
    case 'cashu':
      return 'Cashu'
    case 'xcashu':
      return 'xCashu'
    default:
      return rail
  }
}

/**
 * Returns a trust tier label for display.
 *
 * @param {object} s - Service object
 * @returns {string}
 */
function getTierLabel(s) {
  const tier = s.trustTier || TIER_SELF
  if (tier === TIER_STALE) return s.status === 'unreachable' ? 'Unreachable' : 'Stale'
  if (tier === TIER_DISCOVERED) return 'Discovered by 402.pub'
  if (s.source !== 'nostr') return 'Indexed via ' + s.source
  return 'Self-announced'
}

/* ============================================================
   Service Detail Modal
   ============================================================ */

/**
 * Shows a modal with full service details.
 * Built entirely with DOM methods (no innerHTML) for XSS safety.
 *
 * @param {object} s - Service object
 */
function showServiceDetail(s) {
  // Remove any existing modal
  const existing = document.getElementById('service-modal')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'service-modal'
  overlay.className = 'modal-overlay'
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  const modal = document.createElement('div')
  modal.className = 'modal-content'

  // Close button
  const closeBtn = document.createElement('button')
  closeBtn.className = 'modal-close'
  closeBtn.textContent = '\u00d7'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.addEventListener('click', () => overlay.remove())
  modal.appendChild(closeBtn)

  // Service name
  const title = document.createElement('h2')
  title.className = 'modal-title'
  const atIdx = s.name.indexOf(' @ ')
  title.textContent = atIdx > 0 ? s.name.slice(0, atIdx) : s.name
  modal.appendChild(title)

  // URL
  if (s.url) {
    const urlLink = document.createElement('a')
    urlLink.href = s.url
    urlLink.target = '_blank'
    urlLink.rel = 'noopener noreferrer'
    urlLink.className = 'modal-url'
    urlLink.textContent = s.url
    modal.appendChild(urlLink)
  }

  // Description
  if (s.about) {
    const desc = document.createElement('p')
    desc.className = 'modal-desc'
    desc.textContent = s.about
    modal.appendChild(desc)
  }

  // --- Discovery info section ---
  const discoverySection = document.createElement('div')
  discoverySection.className = 'modal-section'

  const discoveryTitle = document.createElement('h3')
  discoveryTitle.textContent = 'Discovery'
  discoverySection.appendChild(discoveryTitle)

  const discoveryGrid = document.createElement('div')
  discoveryGrid.className = 'modal-info-grid'

  const addInfoRow = (label, value, container) => {
    const row = document.createElement('div')
    row.className = 'modal-info-row'
    const labelEl = document.createElement('span')
    labelEl.className = 'modal-info-label'
    labelEl.textContent = label
    const valueEl = document.createElement('span')
    valueEl.className = 'modal-info-value'
    valueEl.textContent = value
    row.appendChild(labelEl)
    row.appendChild(valueEl)
    container.appendChild(row)
  }

  addInfoRow('Trust tier', getTierLabel(s), discoveryGrid)
  if (s.eventSource) addInfoRow('Source', s.eventSource, discoveryGrid)
  if (s.verified) addInfoRow('Last verified', s.verified, discoveryGrid)
  if (s.status && s.status !== 'active') addInfoRow('Status', s.status, discoveryGrid)
  addInfoRow('Announced', new Date(s.createdAt * 1000).toISOString(), discoveryGrid)
  if (s.pubkey) addInfoRow('Pubkey', s.pubkey, discoveryGrid)
  if (s.version) addInfoRow('Version', s.version, discoveryGrid)

  discoverySection.appendChild(discoveryGrid)
  modal.appendChild(discoverySection)

  // --- Project links section ---
  const modalProjectLinks = [
    s.website && { label: 'Website', url: s.website },
    s.docs && { label: 'Documentation', url: s.docs },
    s.repository && { label: 'Source code', url: s.repository },
  ].filter(Boolean)

  if (modalProjectLinks.length > 0) {
    const linkSection = document.createElement('div')
    linkSection.className = 'modal-section'

    const linkTitle = document.createElement('h3')
    linkTitle.textContent = 'Project'
    linkSection.appendChild(linkTitle)

    const linkList = document.createElement('div')
    linkList.className = 'modal-project-links'
    modalProjectLinks.forEach(link => {
      const a = document.createElement('a')
      a.href = link.url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.className = 'modal-project-link'
      a.textContent = link.label + ' \u2197'
      linkList.appendChild(a)
    })
    linkSection.appendChild(linkList)
    modal.appendChild(linkSection)
  }

  // --- Capabilities / Pricing section ---
  if (s.pricing && s.pricing.length > 0) {
    const pricingSection = document.createElement('div')
    pricingSection.className = 'modal-section'

    const pricingTitle = document.createElement('h3')
    pricingTitle.textContent = 'Capabilities & Pricing'
    pricingSection.appendChild(pricingTitle)

    const table = document.createElement('table')
    table.className = 'modal-pricing-table'

    const thead = document.createElement('thead')
    const headerRow = document.createElement('tr')
    ;['Capability', 'Price', 'Currency'].forEach(h => {
      const th = document.createElement('th')
      th.textContent = h
      headerRow.appendChild(th)
    })
    thead.appendChild(headerRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    s.pricing.forEach(p => {
      const tr = document.createElement('tr')
      const tdCap = document.createElement('td')
      tdCap.textContent = formatCapability(p.capability)
      const tdPrice = document.createElement('td')
      tdPrice.className = 'price-cell'
      tdPrice.textContent = p.price
      const tdCurrency = document.createElement('td')
      tdCurrency.textContent = p.currency
      tr.appendChild(tdCap)
      tr.appendChild(tdPrice)
      tr.appendChild(tdCurrency)
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    pricingSection.appendChild(table)
    modal.appendChild(pricingSection)
  }

  // Expanded capabilities from content JSON
  if (s.capabilities && typeof s.capabilities === 'object') {
    const capsSection = document.createElement('div')
    capsSection.className = 'modal-section'

    const capsTitle = document.createElement('h3')
    capsTitle.textContent = 'Capability Details'
    capsSection.appendChild(capsTitle)

    const capsCode = document.createElement('pre')
    capsCode.className = 'modal-caps-json'
    const codeEl = document.createElement('code')
    codeEl.textContent = JSON.stringify(s.capabilities, null, 2)
    capsCode.appendChild(codeEl)
    capsSection.appendChild(capsCode)
    modal.appendChild(capsSection)
  }

  // --- Payment methods section ---
  if ((s.paymentMethodDetails && s.paymentMethodDetails.length > 0) || s.paymentMethods.length > 0) {
    const paySection = document.createElement('div')
    paySection.className = 'modal-section'

    const payTitle = document.createElement('h3')
    payTitle.textContent = 'Payment Methods'
    paySection.appendChild(payTitle)

    const payList = document.createElement('div')
    payList.className = 'modal-payment-list'

    const details = s.paymentMethodDetails && s.paymentMethodDetails.length > 0
      ? s.paymentMethodDetails
      : s.paymentMethods.map(m => [m])

    details.forEach(parts => {
      const badge = document.createElement('span')
      badge.className = 'badge payment modal-payment-badge'
      badge.textContent = formatPaymentMethodDetail(parts)
      payList.appendChild(badge)
    })

    paySection.appendChild(payList)
    modal.appendChild(paySection)
  }

  // --- Topics ---
  if (s.topics && s.topics.length > 0) {
    const topicSection = document.createElement('div')
    topicSection.className = 'modal-section'

    const topicTitle = document.createElement('h3')
    topicTitle.textContent = 'Topics'
    topicSection.appendChild(topicTitle)

    const topicList = document.createElement('div')
    topicList.className = 'modal-topic-list'
    s.topics.forEach(t => {
      const badge = document.createElement('span')
      badge.className = 'badge topic'
      badge.textContent = t
      topicList.appendChild(badge)
    })
    topicSection.appendChild(topicList)
    modal.appendChild(topicSection)
  }

  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  // Focus the close button for keyboard users
  closeBtn.focus()

  // Close on Escape
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      overlay.remove()
      document.removeEventListener('keydown', handleEsc)
    }
  }
  document.addEventListener('keydown', handleEsc)
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
  {
    name: 'l402.directory',
    url: 'https://l402.directory/api/services',
    parse: parseL402DirectoryServices,
  },
  // Pre-seeded sources — CORS-blocked for browser fetch, so we load local JSON
  // snapshots generated by: node scripts/fetch-sources.mjs
  // Remote URLs kept in comments for reference:
  //   satring.com:      https://satring.com/api/v1/services
  //   x402 Bazaar:      https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=200
  //   agent-commerce:   https://agent-commerce.store/.well-known/l402-manifest.json
  {
    name: 'satring.com',
    url: 'data/satring.json',
    parse: parseSatringServices,
  },
  {
    name: 'x402-bazaar',
    url: 'data/x402-bazaar.json',
    parse: parseX402BazaarServices,
  },
  {
    name: 'agent-commerce',
    url: 'data/agent-commerce.json',
    parse: parseAgentCommerceServices,
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
        console.log(`[${src.name}] Indexed ${added} services (${parsed.length} total, ${parsed.length - added} skipped — duplicates or cap)`)
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
  const items = Array.isArray(data) ? data : (data?.services || data?.data || [])
  return items
    .filter(s => s.name && s.url && isSafeHttpUrl(s.url))
    .map(s => {
      const proto = (s.protocol || '').toLowerCase()
      const pm = proto === 'x402' ? ['x402'] : ['l402']

      // Categories can be objects {id, name, slug} or plain strings
      const topics = (s.categories || [])
        .map(c => typeof c === 'object' ? (c.name || c.slug || '') : String(c))
        .filter(Boolean)

      // Pricing: satring uses top-level pricing_sats, not per-endpoint
      const pricing = []
      if (s.pricing_sats > 0) {
        pricing.push({
          capability: s.pricing_model || 'request',
          price: s.pricing_sats,
          currency: 'sats',
        })
      }
      if (s.pricing_usd && parseFloat(s.pricing_usd) > 0) {
        pricing.push({
          capability: s.pricing_model || 'request',
          price: parseFloat(s.pricing_usd),
          currency: 'USD',
        })
      }

      return {
        id: 'satring-' + (s.slug || s.id || s.name),
        pubkey: '',
        identifier: s.slug || s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: s.name,
        url: s.url,
        about: s.description || '',
        picture: s.logo_url || undefined,
        pricing,
        paymentMethods: pm,
        paymentMethodDetails: proto === 'x402' && s.x402_network
          ? [['x402', s.x402_network]]
          : pm.map(m => [m]),
        topics,
        capabilities: undefined,
        version: undefined,
        website: undefined,
        docs: undefined,
        repository: undefined,
        createdAt: s.created_at ? Math.floor(new Date(s.created_at).getTime() / 1000) : 0,
        source: sourceName,
        trustTier: TIER_DISCOVERED,
        eventSource: 'directory',
        verified: undefined,
        status: 'active',
        transports: detectTransports(s.url),
      }
    })
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
        paymentMethodDetails: [['l402']],
        topics: (s.categories || []).filter(c => typeof c === 'string'),
        capabilities: undefined,
        version: undefined,
        website: s.provider?.url && isSafeHttpUrl(s.provider.url) ? s.provider.url : undefined,
        docs: s.docs_url && isSafeHttpUrl(s.docs_url) ? s.docs_url : undefined,
        repository: undefined,
        createdAt: s.listed_at ? Math.floor(new Date(s.listed_at).getTime() / 1000) : 0,
        source: sourceName,
        trustTier: TIER_DISCOVERED,
        eventSource: 'directory',
        verified: undefined,
        status: 'active',
        transports: detectTransports(safeUrl),
      }
    })
    .filter(Boolean)
}

/**
 * Parses the x402 Bazaar (Coinbase CDP) discovery response into service objects.
 * Response is { x402Version, items: [...], pagination: {...} }.
 * Filters for items with meaningful metadata (description or name).
 *
 * @param {object} data - Raw API response
 * @param {string} sourceName - Source identifier for provenance
 * @returns {Array} Parsed service objects
 */
function parseX402BazaarServices(data, sourceName) {
  const items = data?.items || []
  return items
    .filter(item => {
      if (!item.resource || !isSafeHttpUrl(item.resource)) return false
      // Require a description — skip bare URL-only entries
      const accept = (item.accepts || [])[0] || {}
      return !!accept.description
    })
    .map(item => {
      const accept = (item.accepts || [])[0] || {}
      const resourceUrl = item.resource

      // Extract a human-readable name from the URL or description
      let name
      try {
        const parsed = new URL(resourceUrl)
        // Use last meaningful path segment as name prefix
        const segments = parsed.pathname.split('/').filter(Boolean)
        const lastSeg = segments[segments.length - 1] || ''
        name = parsed.hostname + (lastSeg ? ' / ' + lastSeg : '')
      } catch {
        name = resourceUrl
      }

      // Parse price from maxAmountRequired (USDC has 6 decimals)
      let pricing = []
      if (accept.maxAmountRequired) {
        const raw = parseInt(accept.maxAmountRequired, 10)
        if (Number.isFinite(raw) && raw > 0) {
          const usdcAmount = raw / 1_000_000
          pricing = [{
            capability: 'request',
            price: usdcAmount,
            currency: 'USDC',
          }]
        }
      }

      // Network label — CDP uses plain names like "base", "ethereum", "solana"
      const network = accept.network || ''

      return {
        id: 'x402-' + resourceUrl,
        pubkey: accept.payTo || '',
        identifier: resourceUrl.replace(/[^a-z0-9]+/gi, '-').slice(0, 80),
        name,
        url: resourceUrl,
        about: accept.description || '',
        picture: undefined,
        pricing,
        paymentMethods: ['x402'],
        paymentMethodDetails: [['x402', network].filter(Boolean)],
        topics: [],
        capabilities: accept.outputSchema ? { outputSchema: accept.outputSchema } : undefined,
        version: undefined,
        website: undefined,
        docs: undefined,
        repository: undefined,
        createdAt: item.lastUpdated ? Math.floor(new Date(item.lastUpdated).getTime() / 1000) : 0,
        source: sourceName,
        trustTier: TIER_DISCOVERED,
        eventSource: 'directory',
        verified: undefined,
        status: 'active',
        transports: detectTransports(resourceUrl),
      }
    })
}

/**
 * Parses the agent-commerce.store L402 manifest into service objects.
 * Response is a JSON manifest with base_url and per-endpoint details.
 *
 * @param {object} data - Raw manifest JSON
 * @param {string} sourceName - Source identifier for provenance
 * @returns {Array} Parsed service objects
 */
function parseAgentCommerceServices(data, sourceName) {
  const svc = data?.service || {}
  const baseUrl = svc.base_url || data?.base_url
  if (!baseUrl) return []

  const endpoints = data.endpoints || []
  const serviceName = svc.name || data?.name || 'Agent Commerce Store'
  const docsUrl = svc.documentation_url || data?.documentation_url
  const categories = svc.categories || data?.categories || []

  // Group endpoints by their tags for cleaner cards
  const groups = new Map()
  endpoints.forEach(ep => {
    if (!ep.full_url && !ep.path) return
    // Use first tag as group key, fallback to proxy_id prefix
    const tag = (ep.tags || [])[0] || (ep.proxy_id || '').split('-')[0] || 'api'
    if (!groups.has(tag)) groups.set(tag, [])
    groups.get(tag).push(ep)
  })

  return [...groups.entries()].map(([group, eps]) => {
    // Use the first endpoint's full_url as the card URL
    const firstUrl = eps[0]?.full_url || (baseUrl.replace(/\/$/, '') + '/' + group)
    const pricing = eps
      .filter(ep => ep.pricing?.base_price_sats > 0 || ep.price_sats > 0)
      .map(ep => ({
        capability: (ep.method || 'GET') + ' ' + (ep.path || ''),
        price: ep.pricing?.base_price_sats || ep.price_sats || 0,
        currency: 'sats',
      }))
      .slice(0, 5)

    const about = eps.map(ep => ep.summary || ep.description).filter(Boolean)[0]
      || group + ' API endpoints'

    return {
      id: 'ac-' + group,
      pubkey: '',
      identifier: 'agent-commerce-' + group,
      name: serviceName + ' — ' + group,
      url: isSafeHttpUrl(firstUrl) ? firstUrl : baseUrl,
      about,
      picture: undefined,
      pricing,
      paymentMethods: ['l402'],
      paymentMethodDetails: [['l402', 'lightning']],
      topics: categories.filter(c => typeof c === 'string'),
      capabilities: undefined,
      version: undefined,
      website: isSafeHttpUrl('https://agent-commerce.store') ? 'https://agent-commerce.store' : undefined,
      docs: docsUrl && isSafeHttpUrl(docsUrl) ? docsUrl : undefined,
      repository: undefined,
      createdAt: 0,
      source: sourceName,
      trustTier: TIER_DISCOVERED,
      eventSource: 'directory',
      verified: undefined,
      status: 'active',
      transports: detectTransports(firstUrl),
    }
  })
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
    const filterRows = toolbar.querySelectorAll('.filter-row')
    const showing = pills[0] && pills[0].classList.contains('show-mobile')
    pills.forEach(p => p.classList.toggle('show-mobile', !showing))
    filterRows.forEach(r => r.classList.toggle('show-mobile', !showing))
    btn.classList.toggle('active', !showing)
    btn.setAttribute('aria-expanded', String(!showing))
    btn.textContent = showing ? 'Filters' : 'Hide filters'
  })
  toolbar.insertBefore(btn, toolbar.querySelector('.filter-row') || toolbar.querySelector('.filter-pills'))
})()

// Delegated click handler for filter pills (payment, topic, rail, tier)
// Pills are matched by data-filter attribute, set during buildPillGroup.
document.addEventListener('click', (e) => {
  const pill = e.target.closest('[data-filter]')
  if (!pill) return

  const { filter, value } = pill.dataset

  // Exclusive (radio) filters
  if (filter === 'rail') {
    activeRailFilter = value
    renderServices()
    return
  }
  if (filter === 'tier') {
    activeTierFilter = value
    renderServices()
    return
  }
  if (filter === 'transport') {
    activeTransportFilter = value
    renderServices()
    return
  }

  // Toggle (checkbox) filters
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
 * Also syncs the active/inactive visual state for clickable rail stats.
 */
function updateHeroStats() {
  const allServices = [...services.values()]

  // Service count
  const serviceCountEl = document.getElementById('hero-service-count')
  if (serviceCountEl) serviceCountEl.textContent = allServices.length

  // Payment rails breakdown (pmi values are already normalised at parse time)
  const l402Count = allServices.filter(s => s.paymentMethods.includes('l402')).length
  const x402Count = allServices.filter(s => s.paymentMethods.includes('x402')).length
  const cashuCount = allServices.filter(s => s.paymentMethods.includes('cashu') || s.paymentMethods.includes('xcashu')).length

  const l402CountEl = document.getElementById('hero-l402-count')
  if (l402CountEl) l402CountEl.textContent = l402Count

  const x402CountEl = document.getElementById('hero-x402-count')
  if (x402CountEl) x402CountEl.textContent = x402Count

  const cashuCountEl = document.getElementById('hero-cashu-count')
  if (cashuCountEl) cashuCountEl.textContent = cashuCount

  // Connected relay count
  const relayCountEl = document.getElementById('hero-relay-count')
  if (relayCountEl) {
    const connected = [...relays.values()].filter(r => r.status === 'connected').length
    relayCountEl.textContent = connected
  }

  // Last updated timestamp
  const lastUpdatedEl = document.getElementById('hero-last-updated')
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    lastUpdatedEl.title = new Date().toISOString()
  }

  // Sync active state on clickable hero stat pills
  const railStatMap = {
    'hero-stat-l402': 'l402',
    'hero-stat-x402': 'x402',
    'hero-stat-cashu': 'cashu',
  }
  Object.entries(railStatMap).forEach(([id, rail]) => {
    const el = document.getElementById(id)
    if (!el) return
    if (activeRailFilter === rail) {
      el.classList.add('hero-stat-active')
      el.setAttribute('aria-pressed', 'true')
    } else {
      el.classList.remove('hero-stat-active')
      el.setAttribute('aria-pressed', 'false')
    }
  })
}

/* ============================================================
   Hero Stat Click Handlers — Clickable Rail Filters
   ============================================================ */

/**
 * Makes the L402, x402, and Cashu hero stat pills clickable.
 * Clicking a stat toggles the rail filter to show only services
 * using that payment rail. Clicking again deselects (shows all).
 * Syncs with the existing rail filter pills in the toolbar.
 */
;(function initHeroStatClicks() {
  const railStatMap = {
    'hero-stat-l402': 'l402',
    'hero-stat-x402': 'x402',
    'hero-stat-cashu': 'cashu',
  }

  Object.entries(railStatMap).forEach(([id, rail]) => {
    const el = document.getElementById(id)
    if (!el) return
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-pressed', 'false')

    const activate = () => {
      // Toggle: if already selected, deselect (show all)
      activeRailFilter = activeRailFilter === rail ? 'all' : rail
      renderServices()
    }

    el.addEventListener('click', activate)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        activate()
      }
    })
  })
})()

/* ============================================================
   Service Export — Machine-readable feeds for other directories
   ============================================================ */

/**
 * Generates a JSON export of all currently loaded services.
 * Other discovery pages can fetch this programmatically via
 * window.get402Services() or download it as a file.
 *
 * @returns {object} Export payload with metadata and services array
 */
function exportServicesJSON() {
  const allServices = [...services.values()]
  return {
    name: '402.pub',
    description: 'Aggregated directory of paid APIs discovered via Nostr kind 31402 events and external directories',
    url: 'https://402.pub',
    exportedAt: new Date().toISOString(),
    count: allServices.length,
    sources: {
      nostr: allServices.filter(s => s.source === 'nostr').length,
      external: allServices.filter(s => s.source !== 'nostr').length,
    },
    services: allServices.map(s => ({
      name: s.name,
      url: s.url,
      about: s.about,
      website: s.website || undefined,
      docs: s.docs || undefined,
      repository: s.repository || undefined,
      pricing: s.pricing,
      paymentMethods: s.paymentMethods,
      topics: s.topics,
      trustTier: s.trustTier,
      source: s.source,
      createdAt: s.createdAt,
      transports: s.transports,
    })),
  }
}

/** Public API for programmatic access by other pages/scripts */
window.get402Services = exportServicesJSON

/**
 * Triggers a JSON file download of the current service directory.
 */
function downloadServicesJSON() {
  const data = exportServicesJSON()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'services.json'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Inject export button into footer
;(function injectExportButton() {
  const footer = document.querySelector('footer')
  if (!footer) return
  const exportRow = document.createElement('p')
  exportRow.className = 'export-row'

  const exportBtn = document.createElement('button')
  exportBtn.className = 'btn-export'
  exportBtn.textContent = 'Download services.json'
  exportBtn.addEventListener('click', downloadServicesJSON)
  exportRow.appendChild(exportBtn)

  const apiNote = document.createElement('span')
  apiNote.className = 'export-note'
  apiNote.textContent = 'or call window.get402Services() from your code'
  exportRow.appendChild(apiNote)

  footer.appendChild(exportRow)
})()

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
