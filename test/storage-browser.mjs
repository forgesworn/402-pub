import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {resolve,extname} from 'node:path'
import {once} from 'node:events'
import {chromium,firefox,webkit} from '../scripts/storage-vendor/node_modules/playwright-core/index.mjs'
import {finalizeEvent} from '../scripts/storage-vendor/node_modules/nostr-tools/lib/esm/pure.js'
import {buildStorageAnnouncement} from '../scripts/storage-vendor/node_modules/402-announce/build/storage.js'
const root = resolve('.')
const now = Math.floor(Date.now()/1000)
const base = JSON.parse(readFileSync('scripts/storage-vendor/node_modules/402-announce/fixtures/storage-v1/combined.json','utf8')).description
const description = {...base,name:'Synthetic <img src=x onerror=alert(1)> node',observed_at:now-5,expires_at:now+7200}
const signed = d => finalizeEvent(buildStorageAnnouncement(d),new Uint8Array(32).fill(1))
const event = signed(description)
const withdrawn = signed({...description,observed_at:now-4,expires_at:now+7201,state:'withdrawn',services:description.services.map(s => ({...s,availability:'paused'}))})
const server = createServer(async (req,res) => {
  try {
    const path = resolve(root,`.${new URL(req.url,'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url,'http://localhost').pathname}`)
    if (!path.startsWith(root+'/')) throw Error('unsafe')
    const body = await readFile(path)
    res.setHeader('Content-Type',{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)] ?? 'application/octet-stream')
    res.end(body)
  } catch {res.statusCode=404;res.end('not found')}
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const selected = process.argv[2] ?? 'system-chromium'
const engine = {firefox,webkit,'system-chromium':chromium}[selected]
let browser
try {
  browser = await engine.launch({headless:true,...(selected === 'system-chromium' ? {executablePath:process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'} : {})})
  const page = await browser.newPage({viewport:{width:1280,height:900}})
  const external = [],faults = []
  page.on('pageerror',e => faults.push(e.message))
  await page.route('**/*',route => {
    if (route.request().url().startsWith(origin+'/')) return route.continue()
    external.push(route.request().url());return route.abort()
  })
  await page.addInitScript(({event,now}) => {
    window.__clock = now*1000;Date.now = () => window.__clock
    window.__ticks = [];const interval = window.setInterval
    window.setInterval = (fn,ms,...args) => {window.__ticks.push({fn,ms});return interval(fn,ms,...args)}
    window.__sockets = []
    window.WebSocket = class {
      constructor() {window.__sockets.push(this);queueMicrotask(() => this.onopen?.())}
      send(raw) {const value=JSON.parse(raw);if(value[0] !== 'REQ') return;this.sub=value[1];this.emit(event);this.onmessage?.({data:JSON.stringify(['EOSE',this.sub])})}
      emit(event) {this.onmessage?.({data:JSON.stringify(['EVENT',this.sub,event])})}
      close() {}
    }
  },{event,now})
  await page.goto(origin,{waitUntil:'networkidle'})
  await page.locator('.service-card[data-storage-service=true]').waitFor()
  const text = await page.locator('.service-card[data-storage-service=true]').textContent()
  assert.match(text,/Wildbloom checkout/);assert.match(text,/Free mirror shelter/);assert.match(text,/Authorised mirrors only/)
  assert.match(text,/<img src=x/);assert.equal(await page.locator('.service-card img').count(),0)
  assert.equal(external.filter(url => url.startsWith('https://storage.example')).length,0,'Storage card caused an HTTP probe')
  await page.locator('.service-card[data-storage-service=true] .btn-detail').click()
  assert.match(await page.locator('#service-modal').textContent(),/Separate private quote and payment/)
  // Relay replacement and omission cannot resurrect older terms.
  await page.evaluate(withdrawn => window.__sockets[0].emit(withdrawn),withdrawn)
  assert.equal(await page.locator('.service-card[data-storage-service=true]').count(),0)
  assert.equal(await page.locator('#service-modal').count(),0,'Withdrawal left stale accepting detail terms open')
  await page.evaluate(event => window.__sockets[0].emit(event),event)
  assert.equal(await page.locator('.service-card[data-storage-service=true]').count(),0)
  await page.reload({waitUntil:'networkidle'})
  await page.locator('.service-card[data-storage-service=true]').waitFor()
  await page.evaluate(expires => {window.__clock = expires*1000;window.__ticks.filter(t => t.ms === 30000).forEach(t => t.fn())},description.expires_at)
  assert.equal(await page.locator('.service-card[data-storage-service=true]').count(),0)
  assert.equal(external.filter(url => url.startsWith('https://storage.example')).length,0)
  assert.deepEqual(faults,[])
  console.log(`402.pub storage browser acceptance passed (${selected}): real signed parser, plain text, free/paid terms, no operator probes, withdrawal replay and live expiry.`)
} finally {await browser?.close();await new Promise(r => server.close(r))}
