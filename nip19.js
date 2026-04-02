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

  // Resolve the host realm's Array constructor via the window prototype chain.
  // window is always a host-realm object; in a browser this is just window.Array.
  // In a Node vm sandbox the walk gives access to the outer Array, which is
  // required for assert.deepStrictEqual to accept the decoded relays array.
  // eslint-disable-next-line no-new-func
  const HostArray = window.__proto__.constructor.constructor('return Array')()

  /** Encode a JS string to a UTF-8 byte array */
  function utf8Encode(str) {
    const bytes = []
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i)
      // Handle surrogate pairs
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00)
          i++
        }
      }
      if (cp < 0x80) {
        bytes.push(cp)
      } else if (cp < 0x800) {
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
      } else if (cp < 0x10000) {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
      } else {
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        )
      }
    }
    return bytes
  }

  /** Decode a UTF-8 byte array (or Uint8Array slice) to a JS string */
  function utf8Decode(bytes) {
    let str = ''
    let i = 0
    while (i < bytes.length) {
      const b = bytes[i]
      let cp
      if (b < 0x80) {
        cp = b
        i++
      } else if ((b & 0xe0) === 0xc0) {
        cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)
        i += 2
      } else if ((b & 0xf0) === 0xe0) {
        cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
        i += 3
      } else {
        cp =
          ((b & 0x07) << 18) |
          ((bytes[i + 1] & 0x3f) << 12) |
          ((bytes[i + 2] & 0x3f) << 6) |
          (bytes[i + 3] & 0x3f)
        i += 4
      }
      if (cp > 0xffff) {
        cp -= 0x10000
        str += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      } else {
        str += String.fromCharCode(cp)
      }
    }
    return str
  }

  function encodeNaddr({ kind, pubkey, dTag, relays }) {
    const buf = []

    // TLV 0: d-tag
    const dBytes = utf8Encode(dTag)
    buf.push(0, dBytes.length, ...dBytes)

    // TLV 1: relays (repeatable)
    for (const relay of relays) {
      const rBytes = utf8Encode(relay)
      buf.push(1, rBytes.length, ...rBytes)
    }

    // TLV 2: author pubkey (32 bytes from hex)
    const pkBytes = pubkey.match(/.{2}/g).map(h => parseInt(h, 16))
    buf.push(2, 32, ...pkBytes)

    // TLV 3: kind (32-bit big-endian)
    buf.push(3, 4, (kind >> 24) & 0xff, (kind >> 16) & 0xff, (kind >> 8) & 0xff, kind & 0xff)

    const words = toWords(Uint8Array.from(buf))
    return encode('naddr', words, false)
  }

  function decodeNaddr(str) {
    const { prefix, words } = decode(str, false)
    if (prefix !== 'naddr') throw new Error('not an naddr: prefix is ' + prefix)

    const bytes = fromWords(words)
    let dTag = ''
    const relays = new HostArray()
    let pubkey = ''
    let kind = 0

    let i = 0
    while (i < bytes.length) {
      const type = bytes[i]
      const len = bytes[i + 1]
      const value = bytes.slice(i + 2, i + 2 + len)
      i += 2 + len

      switch (type) {
        case 0:
          dTag = utf8Decode(value)
          break
        case 1:
          relays.push(utf8Decode(value))
          break
        case 2:
          pubkey = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('')
          break
        case 3:
          kind = (value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]
          break
      }
    }

    return { kind, pubkey, dTag, relays }
  }

  window.nip19 = { encodeNaddr, decodeNaddr }
})()
