/* Signature/schema validation is local and version-pinned; no network or signing here. */
;(function () {
  /** Refuse generic fallback for any claimed storage profile. */
  function claims(event) {
    if (event.tags.some(t => (t[0] === 't' && t[1] === 'forgesworn-storage-service-v1') || (t[0] === 'pmi' && t[1] === 'wildbloom-checkout'))) return true
    try { return Object.hasOwn(JSON.parse(event.content),'storage') } catch { return false }
  }
  /** Keep latest valid signed claims, including withdrawals and expired records, in session memory. */
  function parse(event, now = Math.floor(Date.now()/1000)) {
    return StorageContract.parseStorageAnnouncement(event,{now})
  }
  /** Remove verification-cache symbols before checking bounded relay metadata. */
  function verify(event) {
    try {
      const json = JSON.stringify(event)
      if (new TextEncoder().encode(json).length > 65536) return false
      return StorageContract.verifyEvent(JSON.parse(json))
    } catch { return false }
  }
  /** Visibility is evaluated after replacement. Full/paused services remain clearly described. */
  function visible(service, now = Math.floor(Date.now()/1000)) {
    const s = service.storage
    return s ? (s.description.state === 'published' && s.description.expires_at > now && s.event.created_at >= now-7200)
      : (service.expiresAt === undefined || service.expiresAt > now)
  }
  /** Plain operator terms; free mirror shelter never means an unknown-user upload allowance. */
  function summary(storage) {
    const d = storage.description
    return `Public storage claim; expires ${new Date(d.expires_at*1000).toISOString()}. ` +
      (d.checkout ? `Wildbloom checkout (${d.checkout.network}; ${d.checkout.rails.join(', ')}). Separate private quote and payment required. ` : '') +
      d.services.map(s => s.type === 'free-mirror'
        ? `Free mirror shelter: ${s.availability}. Authorised mirrors only, not direct unknown-user uploads; best-effort, evictable retention. ${s.eviction_policy}`
        : `${s.id}: ${s.availability}; ${s.capacity_bytes} ciphertext bytes for ${s.duration_seconds} seconds, ${s.price_msat/1000} sats; grace ${s.grace_seconds} seconds. Delivery: ${s.delivery_bytes} bytes, ${s.delivery_policy}. Retention: ${s.retention_policy}. Refunds: ${s.refund_policy}.`).join('\n') +
      '\nSignature verified; operator claims do not prove uptime, trust or durable retention. Review current /services/v1 separately before using Wildbloom checkout. This directory does not probe this node or buy storage.'
  }
  window.StorageServices = {claims,parse,verify,visible,summary}
})()
