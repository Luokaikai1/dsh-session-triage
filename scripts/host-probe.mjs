#!/usr/bin/env node
// 用 dsh 自己的 persistence 服务，把「它到底读哪个文件、怎么失败」问清楚
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const asar = arg('--asar', ''), root = arg('--root', ''), id = arg('--id', '')
const file = arg('--file', '')
const out = { steps: [] }
const step = (name, fn) => { try { out.steps.push({ name, ok: true, value: fn() }) } catch (e) { out.steps.push({ name, ok: false, error: String(e?.message ?? e).slice(0, 500) }) } }

const NM = join(asar, 'dsh', 'node_modules', '@deepseek-ai')
const imp = (p) => import(pathToFileURL(p).href)

try {
  const pmod = await imp(join(NM, 'dsh-session-persistence-jsonl', 'lib', 'index.js'))
  const cordis = await imp(join(NM, 'cordis', 'lib', 'index.js'))
  const Context = cordis.Context ?? cordis.default?.Context
  const ctx = new Context()
  await ctx.plugin(pmod.default ?? pmod, { root, compression: 'zstd' })
  const svc = ctx.sessionPersistence

  // 1) 它把 id 定位到哪个目录/文件
  for (const name of ['locate', 'findLog', 'resolveCurrentLog', 'resolveGenerationInDirectory']) {
    if (typeof svc[name] !== 'function') continue
    for (const a of [[id], [root, id]]) {
      try {
        const v = await svc[name](...a)
        out.steps.push({ name, args: a.length, ok: true, value: v })
        break
      } catch (e) {
        out.steps.push({ name, args: a.length, ok: false, error: String(e?.message ?? e).slice(0, 300) })
      }
    }
  }

  // 2) 几个 generation
  if (typeof svc.listGenerations === 'function') {
    for (const a of [[id], [root, id]]) {
      try { out.steps.push({ name: 'listGenerations', args: a.length, ok: true, value: await svc.listGenerations(...a) }); break } catch (e) {
        out.steps.push({ name: 'listGenerations', args: a.length, ok: false, error: String(e?.message ?? e).slice(0, 300) })
      }
    }
  }

  // 3) 直接用它的解码器解这份 buffer
  if (file && existsSync(file) && typeof svc.readZstdPrefix === 'function') {
    const buf = readFileSync(file)
    try {
      const r = await svc.readZstdPrefix(buf)
      let n = 0
      if (r && typeof r[Symbol.asyncIterator] === 'function') for await (const _ of r) n++
      else if (Array.isArray(r)) n = r.length
      out.steps.push({ name: 'readZstdPrefix', ok: true, value: { kind: typeof r, count: n } })
    } catch (e) {
      out.steps.push({ name: 'readZstdPrefix', ok: false, error: String(e?.message ?? e).slice(0, 600) })
    }
  }

  await ctx.dispose?.()
} catch (e) {
  out.fatal = String(e?.stack ?? e).slice(0, 1500)
}
console.log(JSON.stringify(out, null, 2))
