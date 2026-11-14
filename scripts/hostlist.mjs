#!/usr/bin/env node
/**
 * 权威判定：用 dsh 自带的 persistence 模块（在 app.asar 内）列出会话。
 *
 * 为什么需要它：doctor 的其他子命令都是「字节层」检查，和 host 的真实解析逻辑
 * 是两套实现。这个脚本直接加载 host 用的同一份代码，所以它的结果就是 host 的答案。
 *
 * 用法（必须用 Electron 跑，普通 node 无法解析 asar 内模块）：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" hostlist.mjs --asar <app.asar> --root <sessions 根目录>
 *
 * 输出一行 JSON：{ ok, count, items: [{ id, formatStatus, sizeBytes, path }] }
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const asar = arg('--asar', '')
const root = arg('--root', '')
if (!asar || !root || !existsSync(asar)) {
  console.log(JSON.stringify({ ok: false, error: `bad args: asar=${asar} root=${root}` }))
  process.exit(0)
}

const NM = join(asar, 'dsh', 'node_modules', '@deepseek-ai')
const imp = (p) => import(pathToFileURL(p).href)

const result = { ok: false, count: 0, items: [], errors: [] }
try {
  const pmod = await imp(join(NM, 'dsh-session-persistence-jsonl', 'lib', 'index.js'))
  const cordis = await imp(join(NM, 'cordis', 'lib', 'index.js'))
  const Context = cordis.Context ?? cordis.default?.Context
  const ctx = new Context()
  await ctx.plugin(pmod.default ?? pmod, { root, compression: 'zstd' })
  const svc = ctx.sessionPersistence
  const list = await svc.list()
  result.ok = true
  result.count = list.length
  result.items = list.map((s) => ({
    id: s.header?.id,
    cwd: s.header?.cwd,
    createdAt: s.header?.createdAt,
    formatStatus: s.formatStatus,
    sizeBytes: s.sizeBytes,
    path: s.location?.path,
  }))
  await ctx.dispose?.()
} catch (e) {
  result.error = String(e?.stack ?? e).slice(0, 1200)
}
console.log(JSON.stringify(result))
