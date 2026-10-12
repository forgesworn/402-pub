import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
const source = readFileSync(new URL('../app.js',import.meta.url),'utf8')
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}\n',start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start,end+3)
}
function fixture(name) { return JSON.parse(readFileSync(new URL(`../scripts/storage-vendor/node_modules/402-announce/fixtures/storage-v1/${name}.json`,import.meta.url),'utf8')) }
function context() {
  const c = {window:{},TextEncoder,TextDecoder,URL,console,Date:class extends Date {},Map,Set,L402_KIND:31402,MAX_SERVICES:2000,TIER_STALE:'stale',TIER_SELF:'self',TIER_DISCOVERED:'discovered',INDEXER_PUBKEY:'other',pendingDeepLink:null,deepLinkTimeout:null,
    services:new Map(),newlyAddedKeys:new Set(),isSafeHttpUrl:() => true,detectTransports:() => [],renderServices:() => {},document:{getElementById:() => null}}
  vm.createContext(c)
  vm.runInContext(readFileSync(new URL('../vendor/storage-v1.js',import.meta.url),'utf8'),c)
  vm.runInContext(readFileSync(new URL('../storage-services.js',import.meta.url),'utf8'),c)
  for (const name of ['normalisePmi','handleEvent','updateHealthDots','invalidateServiceDetail']) vm.runInContext(functionSource(name),c)
  // Fixtures carry a fixed future clock, independent of the test runner's date.
  vm.runInContext('Date.now = () => 1800000300000',c)
  return c
}
test('local browser validator accepts paid/free/combined and rejects all signed hostile fixtures',() => {
  const c = context()
  for (const name of ['paid','free','combined','full','free-onion']) {
    const f = fixture(name)
    assert.equal(c.window.StorageServices.parse(f.signed_event).description.profile,'forgesworn-storage-service-v1')
  }
  const cases = JSON.parse(readFileSync(new URL('../scripts/storage-vendor/node_modules/402-announce/fixtures/storage-v1/manifest.json',import.meta.url),'utf8')).cases
  for (const file of cases.filter(f => f.startsWith('reject-'))) {
    const f = fixture(file.slice(0,-5)); c.handleEvent(f.signed_event)
    assert.equal(c.services.size,0,file)
  }
})
test('free mirror terms, real checkout rail and full status are displayed as operator claims',() => {
  const c = context(); c.handleEvent(fixture('combined').signed_event)
  const s = [...c.services.values()][0]
  assert.ok(s.paymentMethods.includes('wildbloom-checkout'))
  const terms = c.window.StorageServices.summary(s.storage)
  assert.match(terms,/Authorised mirrors only/); assert.match(terms,/best-effort, evictable/)
  assert.match(terms,/Separate private quote and payment/)
  assert.ok(c.window.StorageServices.visible(s))
  c.handleEvent(fixture('full').signed_event)
  assert.ok(c.window.StorageServices.visible([...c.services.values()][0]))
  assert.match(c.window.StorageServices.summary([...c.services.values()][0].storage),/full/)
})
test('latest withdrawal/expiry blocks old replay and is re-evaluated as time passes',() => {
  for (const name of ['withdrawn','expired']) {
    const c = context(); c.handleEvent(fixture('paid').signed_event); c.handleEvent(fixture(name).signed_event)
    c.handleEvent(fixture('paid').signed_event)
    const s = [...c.services.values()][0]
    assert.equal(s.id,fixture(name).signed_event.id)
    assert.equal(c.window.StorageServices.visible(s),false)
  }
  const c = context(); c.handleEvent(fixture('paid').signed_event)
  const s = [...c.services.values()][0]
  assert.equal(c.window.StorageServices.visible(s,s.storage.description.expires_at),false)
  // A forged generic event cannot erase a signed watermark.
  c.handleEvent({...fixture('paid').signed_event,content:'{}',tags:[['d',s.identifier],['name','Forged'],['url',s.url],['about','Forged']],created_at:1800000300})
  assert.equal([...c.services.values()][0].id,s.id)
})
test('storage cards never enter automatic HTTP health checks',() => {
  const c = context(); let scheduled = 0
  c.setTimeout = () => scheduled++
  c.document = {querySelectorAll:() => [{closest:() => ({dataset:{storageService:'true'}})}]}
  c.updateHealthDots(); assert.equal(scheduled,0)
})
