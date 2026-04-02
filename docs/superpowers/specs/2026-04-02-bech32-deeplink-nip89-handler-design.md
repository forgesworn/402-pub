# 402.pub Bech32 Deep-Link + NIP-89 Handler

**Date:** 2026-04-02
**Status:** Approved
**Scope:** Add naddr deep-linking to 402.pub and register as NIP-89 handler for kind 31402

## Problem

402.pub is a live L402 service directory but has no deep-linking. You cannot share a link to a specific service. Nostr clients that encounter kind 31402 events have no NIP-89 handler to redirect users to. This limits discoverability of both 402.pub and the L402 ecosystem.

## Solution

Two changes:

1. **Bech32 deep-link route** -- hash-based URL scheme (`402.pub/#naddr1...`) that auto-opens the service detail modal for the linked service.
2. **NIP-89 handler registration** -- publish a kind 31990 event declaring 402.pub as the handler for kind 31402, making it discoverable on NostrHub and by any NIP-89-aware client.

## URL Scheme

Hash-based: `402.pub/#naddr1...`

- Plain hash with bech32 string directly, no path prefix
- Short URLs, compatible with GitHub Pages (no server config)
- Supports `naddr` only (correct NIP-19 entity for replaceable events like kind 31402)
- `nevent`, `npub`, and other NIP-19 types are out of scope

## Deep-Link Flow

1. Page loads, `app.js` checks `location.hash`
2. If hash starts with `naddr1`, decode to extract kind, pubkey, d-tag, relay hints
3. Validate kind === 31402; show error toast if wrong kind
4. Show detail modal immediately in loading state ("Connecting to relays...")
5. Add relay hints from naddr to connection pool (alongside default relays)
6. Normal relay connections proceed in parallel
7. When `handleEvent` receives matching `pubkey:d-tag`, populate the modal
8. If no match after 10s timeout, show "Service not found" state in modal
9. User can close modal at any time and browse the full directory

## Share Button

Add "Share" button to the existing service detail modal (alongside Copy Pubkey / Visit):

1. Encode service's kind + pubkey + d-tag into naddr bech32 string
2. Update `location.hash` (URL bar reflects the deep-link)
3. Copy full URL to clipboard with "Copied!" confirmation

## Bech32 Library

Vendor `@scure/bech32` as `bech32.js`:

- Inline ESM source, served alongside `app.js`
- ~2KB, audited, MIT licensed, by the noble crypto author
- Consistent with noble ecosystem used across ForgeSworn repos

Write `nip19.js` -- thin wrapper exposing:

- `decodeNaddr(bech32str)` -- returns `{ kind, pubkey, dTag, relays }`
- `encodeNaddr({ kind, pubkey, dTag, relays })` -- returns bech32 string
- Uses NIP-19 TLV format: type 0 = d-tag (UTF-8), type 1 = relay (UTF-8), type 2 = pubkey (32 bytes), type 3 = kind (32-bit BE)

## NIP-89 Handler Event

Publish kind 31990 via nostr-bray after code ships:

```json
{
  "kind": 31990,
  "content": "{\"name\":\"402.pub\",\"about\":\"L402 service directory with live health checks\"}",
  "tags": [
    ["d", "402-pub-l402"],
    ["k", "31402"],
    ["web", "https://402.pub/#<bech32>", "naddr"]
  ]
}
```

This registers 402.pub on NostrHub and enables NIP-89 handler discovery in any supporting client.

## Files Changed

| File | Change |
|------|--------|
| `bech32.js` (new) | Vendored @scure/bech32 ESM source |
| `nip19.js` (new) | NIP-19 naddr encode/decode wrapper |
| `app.js` | Hash routing on load, modal loading state, share button, relay hint injection |
| `index.html` | Script tags for bech32.js and nip19.js |

## Out of Scope

- Query param routing or filter persistence in URL
- Support for nevent, npub, or other NIP-19 entities
- Changes to card grid or filtering logic
- SEO/OG tags for deep-linked services (not possible on GitHub Pages static hosting)
- Other NIP-89 handler registrations (TROTT kinds, MCP platform tags)
