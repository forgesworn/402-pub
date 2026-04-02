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
