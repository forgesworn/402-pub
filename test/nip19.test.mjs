import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const dir = dirname(fileURLToPath(import.meta.url))

function loadNip19() {
  const context = { window: { Array } }
  vm.createContext(context)
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
