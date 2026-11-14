// 防复发补丁：让 dsh 不写 reason:null，且读 reason 的地方都容错。
// 用法：node guard.mjs [--apply] [--asar <path>]
// 默认 dry-run，只打印将要改的字节数与差异。
import { openSync, readSync, closeSync, writeSync, copyFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const asar = argv[argv.indexOf('--asar') + 1]?.startsWith('--') ? undefined : argv[argv.indexOf('--asar') + 1]
function resolveAsar() {
  const cands = [
    process.env.DSH_ASAR,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  ].filter(Boolean)
  return cands.find(p => existsSync(p))
}
const ASAR = asar || resolveAsar()
if (!ASAR) {
  console.error('找不到 app.asar：请用 --asar <path> 或设置 DSH_ASAR 环境变量')
  process.exit(2)
}

// entry 精确路径 → 替换列表（from 必须唯一或指定次数）
const TARGETS = [
  {
    entry: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    label: '写入端：null → completed',
    edits: [
      { from: 'reason: turnEnds', to: 'reason: turnEnds ?? { kind: "completed" }', why: 'turn 正常退出但 turnEnds 仍为 null 时，写 completed 而不是 null' },
    ],
  },
  {
    entry: 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js',
    label: '投影端：reason 容错',
    edits: [
      { from: 'event.data.reason.kind === "error"', to: 'event.data.reason?.kind === "error"', why: 'reason 为 null 时不要抛 TypeError' },
      { from: 'event.data.reason.error.code', to: 'event.data.reason?.error?.code', why: '同上，error 也可能缺' },
    ],
  },
  {
    entry: 'dsh/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js',
    label: '目标循环：reason 容错',
    edits: [
      { from: 'event.data.reason.kind', to: 'event.data.reason?.kind', why: 'goal 监听器裸读 reason.kind' },
      { from: 'event.data.reason.reason.kind', to: 'event.data.reason?.reason?.kind', why: 'aborted 的 reason.reason 也可能缺' },
    ],
  },
]

function readHeader(fd) {
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const jsonSize = head.readUInt32LE(12)
  const jb = Buffer.alloc(jsonSize)
  readSync(fd, jb, 0, jsonSize, 16)
  return { json: JSON.parse(jb.toString('utf8')), base: 8 + head.readUInt32LE(4) }
}

function findEntry(node, want, prefix = '') {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + k : k
    if (v.files) { const r = findEntry(v, want, p); if (r) return r }
    else if (p === want) return v
  }
  return null
}

// 从注释里安全裁掉 n 字节（只裁注释正文，保留分隔符）
function shrinkComments(code, need) {
  if (need <= 0) return { code, left: 0 }
  let left = need
  // 优先裁块注释（JSDoc），从每个注释正文尾部裁
  code = code.replace(/\/\*[\s\S]{0,4000}?\*\//g, (m) => {
    if (left <= 0) return m
    const inner = m.slice(2, -2)
    const take = Math.min(left, Math.max(0, inner.length - 16))
    if (take <= 0) return m
    left -= take
    return '/*' + inner.slice(0, inner.length - take) + '*/'
  })
  if (left > 0) {
    code = code.replace(/\/\/[^\n]+/g, (m) => {
      if (left <= 0) return m
      const take = Math.min(left, Math.max(0, m.length - 4))
      if (take <= 0) return m
      left -= take
      return m.slice(0, m.length - take)
    })
  }
  return { code, left }
}

const fd = openSync(ASAR, 'r')
const { json, base } = readHeader(fd)
const plans = []
for (const t of TARGETS) {
  const ent = findEntry(json, t.entry)
  if (!ent) { console.log(`✗ 找不到 entry: ${t.entry}`); process.exitCode = 1; continue }
  const size = Number(ent.size)
  const buf = Buffer.alloc(size)
  readSync(fd, buf, 0, size, base + Number(ent.offset))
  const src = buf.toString('utf8')
  let out = src
  const applied = []
  for (const e of t.edits) {
    const n = out.split(e.from).length - 1
    if (n === 0) { applied.push({ ...e, n: 0, note: '已打过或不存在' }); continue }
    out = out.split(e.from).join(e.to)
    applied.push({ ...e, n })
  }
  const delta = out.length - src.length
  let shrunk = { code: out, left: 0 }
  if (delta > 0) shrunk = shrinkComments(out, delta)
  if (shrunk.left > 0) { console.log(`✗ ${t.entry}: 注释空间不足，仍差 ${shrunk.left} 字节`); process.exitCode = 1; continue }
  const final = shrunk.code
  plans.push({ ...t, abs: base + Number(ent.offset), size, src, final, delta, applied })
}
closeSync(fd)

let ok = true
for (const p of plans) {
  const changed = p.applied.filter(a => a.n > 0).length
  console.log(`\n=== ${p.entry}`)
  console.log(`  ${p.label}  改动 ${changed} 类 / 长度 ${p.size} → ${Buffer.byteLength(p.final, 'utf8')}`)
  for (const a of p.applied) console.log(`   ${a.n > 0 ? `×${a.n}` : '—'} ${a.why}`)
  if (Buffer.byteLength(p.final, 'utf8') !== p.size) { console.log('  ✗ 长度不等于原长，拒绝'); ok = false; continue }
  const tmp = join(tmpdir(), 'guard-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.js')
  writeFileSync(tmp, p.final)
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
  if (r.status !== 0) { console.log('  ✗ 语法不通过：' + (r.stderr || '').slice(0, 300)); ok = false; continue }
  console.log('  ✓ 等长 + 语法通过')
}
if (!ok) { console.log('\n有检查未通过，未写入。'); process.exit(1) }
if (!APPLY) { console.log('\n[dry] 未写入。加 --apply 生效（需先完全退出 dsh）。'); process.exit(0) }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bak = ASAR + '.bak-reasonguard-' + stamp
if (!existsSync(bak)) copyFileSync(ASAR, bak)
const wfd = openSync(ASAR, 'r+')
try {
  for (const p of plans) {
    if (p.applied.every(a => a.n === 0)) continue
    writeSync(wfd, Buffer.from(p.final, 'utf8'), 0, p.size, p.abs)
    console.log(`写入 ${p.entry} @${p.abs}`)
  }
} finally { closeSync(wfd) }
console.log('备份：' + bak)
console.log('完成。重开 dsh 生效。')
