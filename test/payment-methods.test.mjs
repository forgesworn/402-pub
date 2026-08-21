import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(dir, '..', 'app.js'), 'utf8')

/**
 * Pulls a top-level function declaration out of app.js by name.
 * app.js is a browser script with no exports, so the formatters are
 * lifted out on their own rather than loading the whole file, which
 * would need a DOM. Top-level functions there close with a brace in
 * the first column, which is what marks the end.
 */
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `function ${name} not found in app.js`)
  const end = src.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `end of function ${name} not found in app.js`)
  return src.slice(start, end + 3)
}

function loadFormatters() {
  const context = {}
  vm.createContext(context)
  for (const name of ['normalisePmi', 'formatPaymentMethod', 'formatPaymentMethodDetail']) {
    vm.runInContext(extractFunction(name), context)
  }
  return context
}

describe('formatPaymentMethod', () => {
  const { formatPaymentMethod } = loadFormatters()

  it('labels the known rails', () => {
    assert.equal(formatPaymentMethod('l402'), 'L402')
    assert.equal(formatPaymentMethod('x402'), 'x402')
    assert.equal(formatPaymentMethod('cashu'), 'Cashu')
    assert.equal(formatPaymentMethod('xcashu'), 'xCashu')
    assert.equal(formatPaymentMethod('lnurlcash'), 'LNURLcash')
    assert.equal(formatPaymentMethod('payment'), 'IETF Payment')
  })

  it('labels legacy identifiers the same way', () => {
    assert.equal(formatPaymentMethod('bitcoin-lightning-bolt11'), 'L402')
    assert.equal(formatPaymentMethod('bitcoin-cashu-xcashu'), 'xCashu')
    assert.equal(formatPaymentMethod('bitcoin-cashu'), 'Cashu')
  })

  it('shows an unknown rail as it arrived', () => {
    assert.equal(formatPaymentMethod('something-new'), 'something-new')
  })
})

describe('formatPaymentMethodDetail', () => {
  const { formatPaymentMethodDetail } = loadFormatters()

  it('lists the mints an lnurlcash service accepts', () => {
    assert.equal(
      formatPaymentMethodDetail(['lnurlcash', 'mint.example', 'mint2.example']),
      'LNURLcash (mint.example, mint2.example)'
    )
  })

  it('falls back to the bare label when no mint is named', () => {
    assert.equal(formatPaymentMethodDetail(['lnurlcash']), 'LNURLcash')
  })

  it('ignores empty mint entries', () => {
    assert.equal(formatPaymentMethodDetail(['lnurlcash', '', 'mint.example']), 'LNURLcash (mint.example)')
  })

  it('still describes the other rails', () => {
    assert.equal(formatPaymentMethodDetail(['l402', 'lightning']), 'L402 (Lightning)')
    assert.equal(formatPaymentMethodDetail(['x402', 'base', 'usdc', '0xabc']), 'x402 / Base / USDC')
    assert.equal(formatPaymentMethodDetail(['xcashu']), 'xCashu')
    assert.equal(formatPaymentMethodDetail(['payment', 'lightning']), 'IETF Payment (Lightning)')
  })

  it('handles a missing or empty pmi tag', () => {
    assert.equal(formatPaymentMethodDetail([]), 'Unknown')
    assert.equal(formatPaymentMethodDetail(null), 'Unknown')
  })
})
