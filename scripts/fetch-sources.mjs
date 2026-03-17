#!/usr/bin/env node

/**
 * fetch-sources.mjs — Pre-seeds external directory data as local JSON files.
 *
 * CORS-blocked APIs cannot be fetched from the browser, so this script
 * fetches them server-side and writes snapshots to data/*.json.
 * The static site loads these local files instead of the remote APIs.
 *
 * Usage:
 *   node scripts/fetch-sources.mjs
 *
 * Run periodically (e.g. daily via cron or GitHub Actions) to keep data fresh.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')

mkdirSync(DATA_DIR, { recursive: true })

const SOURCES = [
  {
    name: 'satring',
    url: 'https://satring.com/api/v1/services',
    file: 'satring.json',
    // satring paginates — fetch multiple pages
    async fetch() {
      const allServices = []
      let page = 1
      const maxPages = 20
      while (page <= maxPages) {
        const res = await fetchWithTimeout(`${this.url}?page=${page}&per_page=50`, 15_000)
        if (!res.ok) break
        const data = await res.json()
        const items = data.services || data.data || (Array.isArray(data) ? data : [])
        if (items.length === 0) break
        allServices.push(...items)
        page++
      }
      return allServices
    },
  },
  {
    name: 'x402-bazaar',
    url: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources',
    file: 'x402-bazaar.json',
    async fetch() {
      // Paginate through the CDP discovery API
      const allItems = []
      let offset = 0
      const limit = 200
      const maxItems = 1000 // Cap to keep file size reasonable
      while (offset < maxItems) {
        const res = await fetchWithTimeout(
          `${this.url}?type=http&limit=${limit}&offset=${offset}`,
          30_000
        )
        if (!res.ok) break
        const data = await res.json()
        const items = data.items || []
        if (items.length === 0) break
        allItems.push(...items)
        offset += items.length
        if (items.length < limit) break // Last page
      }
      // Wrap in the expected envelope
      return { x402Version: 1, items: allItems, pagination: { total: allItems.length } }
    },
  },
  {
    name: 'agent-commerce',
    url: 'https://agent-commerce.store/.well-known/l402-manifest.json',
    file: 'agent-commerce.json',
    async fetch() {
      const res = await fetchWithTimeout(this.url, 15_000)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.json()
    },
  },
]

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log('Fetching external sources...\n')

  for (const src of SOURCES) {
    try {
      console.log(`[${src.name}] Fetching from ${src.url}`)
      const data = await src.fetch()

      const filePath = join(DATA_DIR, src.file)
      const json = JSON.stringify(data, null, 2)
      writeFileSync(filePath, json, 'utf8')

      const count = Array.isArray(data) ? data.length
        : data?.items?.length ?? data?.services?.length ?? data?.endpoints?.length ?? '?'
      console.log(`[${src.name}] Wrote ${filePath} (${count} items, ${(json.length / 1024).toFixed(1)} KB)\n`)
    } catch (err) {
      console.error(`[${src.name}] FAILED: ${err.message}\n`)
    }
  }

  console.log('Done.')
}

main()
