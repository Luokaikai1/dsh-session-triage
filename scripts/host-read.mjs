#!/usr/bin/env node
// 用 dsh 自己的 persistence 模块完整读取某个会话（不是只读首帧），
// 得到的错误就是 dsh resume 时的错误。
// 用法：ELECTRON_RUN_AS_NODE=1 "<exe>" host-read.mjs --asar <app.asar> --root <sessions> --id <sessionId>
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const asar = arg('--asar', '')
const root = arg('--root', '')
const id = arg('--id', '')
const out = { ok: false, tried: [] }

if (!asar || !root || !existsSync(asar)) {
  console.log(JSON.stringify({ ok: false, error: 'bad args' }))
  process.exit(0)
}

const NM = join(asar, 'dsh', 'node_modules', '@deepseek-ai')
const imp = (p) => import(pathToFileURL(p).href)

try {
  const pmod = await imp(join(NM, 'dsh-session-persistence-jsonl', 'lib', 'index.js'))
  const cordis = await imp(join(NM, 'cordis', 'lib', 'index.js'))
  const Context = cordis.Context ?? cordis.default?.Context
  const ctx = new Context()
  await ctx.plugin(pmod.default ?? pmod, { root, compression: 'zstd' })
  const svc = ctx.sessionPersistence

  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(svc))
  out.methods = proto.filter((m) => m !== 'constructor')

  const list = await svc.list()
  const meta = list.find((s) => s.header?.id === id || (s.location?.path || '').includes(id))
  out.meta = meta
    ? {
        id: meta.header?.id,
        formatStatus: meta.formatStatus,
        sizeBytes: meta.sizeBytes,
        path: meta.location?.path,
        headerSeqs: meta.header?.seq,
      }
    : null

  // 依次尝试常见的完整读取入口
  const candidates = ['open', 'load', 'read', 'resume', 'loadSession', 'openSession', 'readSession', 'events', 'replay']
  for (const name of candidates) {
    if (typeof svc[name] !== 'function') continue
    try {
      const r = await svc[name](id)
      let count = null
      if (Array.isArray(r)) count = r.length
      else if (r && Array.isArray(r.events)) count = r.events.length
      else if (r && typeof r[Symbol.asyncIterator] === 'function') {
        let n = 0
        for await (const _ of r) n++
        count = n
      }
      out.tried.push({ m: name, ok: true, events: count, kind: Array.isArray(r) ? 'array' : typeof r })
      if (count !== null) break
    } catch (e) {
      out.tried.push({ m: name, ok: false, error: String(e?.message ?? e).slice(0, 400) })
    }
  }

  await ctx.dispose?.()
  out.ok = true
} catch (e) {
  out.error = String(e?.stack ?? e).slice(0, 1500)
}
console.log(JSON.stringify(out))
