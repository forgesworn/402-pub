import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

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
