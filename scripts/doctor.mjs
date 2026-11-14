#!/usr/bin/env node
/**
 * dsh-session-triage —— DeepSeek Harness（dsh）会话体检 / 修复 / 客户端补丁 三合一工具
 *
 * 根因（2026-11-13 实测定论，见 references/root-cause.md）：
 *   1. 用户在审批框点「取消 / 拒绝」时，host 收尾会把该轮写成 turn/end: {"reason": null}
 *   2. 客户端 dsh-client-ui-chat 裸读 turn.end?.data.reason.kind，遇 null 抛
 *      TypeError: Cannot read properties of null (reading 'kind')
 *   3. React 错误边界把整块对话区渲染成空 div —— 用户看到的就是「会话突然全白」
 *   4. 附带伤害：该会话打不开后，工作区注册表会把它的 id 从 sessionIds 里漏掉，
 *      于是侧栏只剩更早的会话，用户以为「今天的记录丢了」
 *
 * 三层处置：
 *   数据层  fix      把非法 reason 改写成 {"kind":"aborted","reason":{"kind":"user"}}
 *   注册表  registry 把磁盘存在但漏登记的会话按 mtime 挂回工作区
 *   客户端  patch    把 9 处 .kind 裸读改成 ?.kind（等长原地改写，升级后需重打）
 *
 * 用法（脚本自带安装路径探测，无需手工改路径）：
 *   node doctor.mjs status              总览：会话/注册表/补丁/崩溃日志 一次看完（先跑这个）
 *   node doctor.mjs scan                只体检，不写任何文件
 *   node doctor.mjs fix                 修复非法 turn/end reason（带备份）
 *   node doctor.mjs registry [--dry]    补登被注册表漏掉的会话
 *   node doctor.mjs all                 数据层 + 注册表层
 *   node doctor.mjs patch [--apply]     客户端空值防护补丁（默认 dry-run，先试后写）
 *   node doctor.mjs reasonguard [--apply] 写入端不再写 reason:null + 读取端容错（升级后必重打）
 *   node doctor.mjs logs                解析最近崩溃日志里的 kind 报错与触发时间
 *   node doctor.mjs restore <会话文件>   从 .bak-reasonfix-* 备份还原
 *   node doctor.mjs restore-asar        从 app.asar.bak-reasonfix 还原客户端
 *
 * 约定：改数据前先退出 DeepSeek Harness，否则会被内存状态覆盖回去。
 */
import {
  readFileSync, writeFileSync, readdirSync, statSync, existsSync,
  copyFileSync, renameSync, openSync, readSync, writeSync, closeSync, unlinkSync, appendFileSync, fsyncSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir, tmpdir, platform } from 'node:os'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const FIXED_REASON = { kind: 'aborted', reason: { kind: 'user' } }

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESS_ROOT = join(DSH_HOME, 'sessions')
const REG_PATH = join(DSH_HOME, 'storages', 'workspace.json')


// 应用是否在跑：改名/改数据前必须为 0，否则会被内存状态覆盖
function appRunning() {
  try {
    if (platform() === 'win32') {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' })
      return ((r.stdout || '').match(/DeepSeek Harness\.exe/g) || []).length
    }
    const r = spawnSync('pgrep', ['-fc', 'DeepSeek Harness'], { encoding: 'utf8' })
    return Number((r.stdout || '0').trim()) || 0
  } catch { return 0 }
}

// ---------------------------------------------------------------- 路径探测

function asarCandidates() {
  const out = []
  if (process.env.DSH_ASAR) out.push(process.env.DSH_ASAR)
  const p = platform()
  if (p === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    const pf = process.env.ProgramFiles || 'C:/Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'
    for (const root of [
      join(local, 'Programs', 'DeepSeek Harness'),
      join(local, 'DeepSeek Harness'),
      join(local, 'Programs', 'deepseek-harness'),
      join(roaming, 'DeepSeek Harness'),
      join(pf, 'DeepSeek Harness'),
      join(pf86, 'DeepSeek Harness'),
    ]) out.push(join(root, 'resources', 'app.asar'))
  } else if (p === 'darwin') {
    out.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
    out.push(join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'))
  } else {
    out.push('/opt/DeepSeek Harness/resources/app.asar')
    out.push('/usr/lib/deepseek-harness/resources/app.asar')
  }
  return out
}

function findAsar() {
  for (const c of asarCandidates()) { try { if (statSync(c).isFile()) return c } catch { } }
  return null
}

function crashLogDirs() {
  const out = []
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  if (platform() === 'win32') out.push(join(roaming, '@deepseek-ai', 'dsh-desktop', 'logs'))
  else if (platform() === 'darwin') out.push(join(homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'logs'))
  else out.push(join(homedir(), '.config', '@deepseek-ai', 'dsh-desktop', 'logs'))
  return out.filter(existsSync)
}

// ---------------------------------------------------------------- 会话解码

function decodeBuf(buf) {
  const offs = []
  for (let from = 0; ;) { const i = buf.indexOf(MAGIC, from); if (i < 0) break; offs.push(i); from = i + 1 }
  const parts = []
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k], e = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { parts.push({ ok: true, text: zstdDecompressSync(buf.subarray(s, e)).toString('utf8'), raw: buf.subarray(s, e) }) }
    catch (err) { parts.push({ ok: false, raw: buf.subarray(s, e), err: err.code }) }
  }
  return parts
}

const isBadReason = r => !r || typeof r !== 'object' || typeof r.kind !== 'string'

function inspectSession(file) {
  const frames = decodeBuf(readFileSync(file))
  let lines = 0, turnEnds = 0, bad = 0
  const firstBad = []
  // torn：dsh 的读取器要求每个完整帧的明文以换行结尾、且帧内不含纯空行
  // （它按 committedBytes === inputBytes 校验）。任何一处不符都会让整个会话
  // 报 "complete frame contains a torn JSONL record"，比 reason:null 更致命。
  const tornFrames = []
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k]
    if (!f.ok) continue
    const endsNL = f.text.endsWith('\n')
    const all = f.text.split('\n')
    const bodyLines = endsNL ? all.slice(0, -1) : all
    const blanks = bodyLines.filter(l => l.trim() === '').length
    if (blanks > 0 || !endsNL) {
      if (tornFrames.length < 5) tornFrames.push({ frame: k, blanks, endsNL })
    }
    for (const l of all) {
      if (!l.trim()) continue
      lines++
      let o; try { o = JSON.parse(l) } catch { continue }
      if (o.type === 'turn/end') {
        turnEnds++
        if (isBadReason(o.data && o.data.reason)) { bad++; if (firstBad.length < 3) firstBad.push(o.seq) }
      }
    }
  }
  return {
    frames, lines, turnEnds, bad,
    undecodable: frames.filter(f => !f.ok).length,
    torn: tornFrames.length ? frames.filter((f, k) => tornFrames.some(t => t.frame === k)).length : 0,
    tornFrames,
    firstBad,
  }
}

function listSessions() {
  const rows = []
  if (!existsSync(SESS_ROOT)) return rows
  for (const wsDir of readdirSync(SESS_ROOT)) {
    const wsPath = join(SESS_ROOT, wsDir)
    try { if (!statSync(wsPath).isDirectory()) continue } catch { continue }
    for (const sid of readdirSync(wsPath)) {
      const dir = join(wsPath, sid)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const file = join(dir, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const st = statSync(file)
      rows.push({ wsDir, sid, file, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  return rows
}

function scanAll() {
  const rows = listSessions()
  const bad = []
  for (const r of rows) {
    try {
      const info = inspectSession(r.file)
      if (info.bad > 0 || info.undecodable > 0 || info.torn > 0) bad.push({ ...r, ...info })
    } catch (e) { bad.push({ ...r, error: e.message }) }
  }
  return { total: rows.length, bad, rows }
}

// ---------------------------------------------------------------- 数据层

function repairSession(file) {
  const { frames, bad, tornFrames } = inspectSession(file)
  const tornSet = new Set(tornFrames.map(t => t.frame))
  if (bad === 0 && tornSet.size === 0) return { changed: false }
  const out = []
  let patched = 0
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k]
    if (!f.ok) { out.push(f.raw); continue }
    const hasNL = f.text.endsWith('\n')
    const lines = f.text.split('\n')
    // 结构性 torn 的帧即便 reason 正常也要重写（规范尾部换行 / 剔除空行）
    let changed = tornSet.has(k)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      let o; try { o = JSON.parse(lines[i]) } catch { continue }
      if (o.type !== 'turn/end' || !isBadReason(o.data && o.data.reason)) continue
      o.data = { ...(o.data || {}), reason: FIXED_REASON }
      lines[i] = JSON.stringify(o)
      changed = true
      patched++
    }
    // 尾部换行必须规范化成「恰好一个」。
    // split('\n') 对 "...}\n" 会得到末尾一个空串，join 后本身已带结尾 \n，
    // 若再拼一个就变成 \n\n —— dsh 的读取器按 committedBytes === inputBytes 校验，
    // 多这一个字节就会被判定为 "complete frame contains a torn JSONL record"，
    // 整个会话直接打不开（比修复前的 reason:null 更严重）。空行一并剔除。
    const kept = lines.filter(l => l.trim() !== '')
    const joined = kept.join('\n')
    const body = hasNL ? joined + '\n' : joined
    out.push(changed ? zstdCompressSync(Buffer.from(body, 'utf8')) : f.raw)
  }
  const merged = Buffer.concat(out)
  let remaining = 0
  for (const f of decodeBuf(merged)) {
    if (!f.ok) continue
    for (const l of f.text.split('\n')) {
      if (!l.trim()) continue
      let o; try { o = JSON.parse(l) } catch { continue }
      if (o.type === 'turn/end' && isBadReason(o.data && o.data.reason)) remaining++
    }
  }
  if (remaining > 0) throw new Error(`校验失败：仍有 ${remaining} 处非法 reason，已放弃写入`)
  const bak = `${file}.bak-reasonfix-${STAMP}`
  copyFileSync(file, bak)
  writeFileSync(file, merged)
  return { changed: true, patched, backup: bak }
}

function cmdScan(quiet = false) {
  const { total, bad } = scanAll()
  if (quiet) return bad
  console.log(`会话总数: ${total}`)
  if (bad.length === 0) { console.log('✓ 没有非法 turn/end reason，没有坏帧，也没有 torn 帧'); return bad }
  console.log(`✗ ${bad.length} 个问题会话：`)
  for (const b of bad) {
    console.log(`  - ${b.sid}`)
    if (b.error) console.log(`      error: ${b.error}`)
    if (b.bad) console.log(`      非法 reason: ${b.bad} 处（seq ${b.firstBad.join(', ')}）`)
    if (b.undecodable) console.log(`      无法解码的帧: ${b.undecodable} 个`)
    if (b.torn) {
      const detail = b.tornFrames.map(t => `帧${t.frame}(空行${t.blanks}${t.endsNL ? '' : ',结尾无换行'})`).join(' ')
      console.log(`      torn 帧: ${b.torn} 个 → ${detail}`)
      console.log(`      表现：会话打不开，报 "complete frame contains a torn JSONL record"`)
    }
  }
  return bad
}

function cmdFix() {
  const bad = cmdScan(true)
  const targets = bad.filter(b => b.bad > 0 || b.torn > 0)
  if (targets.length === 0) { console.log('✓ 数据层无需修复'); return }
  let n = 0
  for (const t of targets) {
    try {
      const r = repairSession(t.file)
      if (r.changed) { n++; console.log(`✓ ${t.sid}: 修复 ${r.patched} 处，备份 ${basename(r.backup)}`) }
    } catch (e) { console.log(`✗ ${t.sid}: ${e.message}`) }
  }
  console.log(`数据层完成：修复 ${n} 个会话`)
}

// ---------------------------------------------------------------- 注册表层

const wsDirForPath = p => '--' + p.replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '') + '--'

function cmdRegistry(apply = true) {
  if (!existsSync(REG_PATH)) { console.log('找不到 workspace.json：' + REG_PATH); return }
  const reg = JSON.parse(readFileSync(REG_PATH, 'utf8'))
  const archived = new Set(reg.global?.archivedSessionIds || [])
  let totalAdded = 0

  for (const [wsId, rec] of Object.entries(reg.tables?.workspaces || {})) {
    if (!rec.path) continue
    const wsDir = wsDirForPath(rec.path)
    const dir = join(SESS_ROOT, wsDir)
    if (!existsSync(dir)) continue
    const registered = new Set(rec.sessionIds)
    const missing = []
    for (const sid of readdirSync(dir)) {
      if (!sid.startsWith('session-') && !sid.startsWith('onebot-')) continue
      const file = join(dir, sid, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      if (registered.has(sid) || archived.has(sid)) continue
      missing.push({ sid, mtimeMs: statSync(file).mtimeMs })
    }
    if (missing.length === 0) continue
    missing.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const m of missing) {
      let idx = rec.sessionIds.length
      for (let i = 0; i < rec.sessionIds.length; i++) {
        const f = join(SESS_ROOT, wsDir, rec.sessionIds[i], 'session.v4.jsonl.zstd')
        if (existsSync(f) && statSync(f).mtimeMs < m.mtimeMs) { idx = i; break }
      }
      rec.sessionIds.splice(idx, 0, m.sid)
      console.log(`  + ${rec.title || wsId}: ${m.sid}`)
      totalAdded++
    }
    rec.updatedAt = new Date().toISOString()
  }

  if (totalAdded === 0) { console.log('✓ 注册表没有遗漏的会话'); return }
  if (!apply) { console.log(`[dry] 将补登 ${totalAdded} 个会话`); return }
  const bak = `${REG_PATH}.bak-doctor-${STAMP}`
  copyFileSync(REG_PATH, bak)
  const tmp = `${REG_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8')
  JSON.parse(readFileSync(tmp, 'utf8'))
  renameSync(tmp, REG_PATH)
  console.log(`注册表层完成：补登 ${totalAdded} 个会话，备份 ${basename(bak)}`)
}

// ---------------------------------------------------------------- 写入端（reason:null 防复发）

// 2026-11-14 定论：空响应（assistant/attempt stream:[]）时 agent-loop 的 turnEnds
// 从未赋值，finally 把初始 null 原样写成 turn/end.reason —— 投影层读 reason.error.code 就炸。
// 三处等长补丁由 scripts/reasonguard.mjs 施加，这里只做状态判定。
const GUARD_ENTRIES = [
  ['dsh-agent-loop/lib/index.js', 'reason: turnEnds ?? { kind: "completed" }', '写入端'],
  ['dsh-api-session-controller/lib/index.js', 'event.data.reason?.error?.code', '投影端'],
  ['dsh-goal-round-driver/lib/index.js', 'event.data.reason?.kind', '目标循环'],
]

function asarEntryAt(header, path) {
  let node = header
  for (const seg of path.split('/')) {
    if (!node.files || !node.files[seg]) return null
    node = node.files[seg]
  }
  return node.files ? null : node
}

function reasonGuardStatus() {
  const asar = findAsar()
  if (!asar) return null
  const h = openAsarHeader(asar)
  return GUARD_ENTRIES.map(([suffix, needle, label]) => {
    const ent = asarEntryAt(h, 'dsh/node_modules/@deepseek-ai/' + suffix)
    if (!ent) return { label, state: 'missing' }
    const { buf } = readAsarEntry(asar, ent)
    return { label, state: buf.toString('utf8').includes(needle) ? 'on' : 'off' }
  })
}

function cmdReasonGuard(apply) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'reasonguard.mjs')
  if (!existsSync(script)) { console.log('✗ 缺少 reasonguard.mjs'); return }
  const r = spawnSync(process.execPath, [script, ...(apply ? ['--apply'] : [])], { encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
  if (r.stderr) process.stderr.write(r.stderr)
}

// ---------------------------------------------------------------- 客户端层

const TARGET_SUFFIX = 'dsh-client-ui-chat/lib/client.js'
const PATCHES = [
  ['data.reason.kind', 'data.reason?.kind'],
  ['reason.reason.kind', 'reason.reason?.kind'],
  ['(reason.kind)', '(reason?.kind)'],
]

function findInAsar(node, prefix = '') {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + k : k
    if (v.files) { const r = findInAsar(v, p); if (r) return r }
    else if (p.endsWith(TARGET_SUFFIX)) return v
  }
  return null
}

function readAsarEntry(asar, entry) {
  const fd = openSync(asar, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonSize = head.readUInt32LE(12)
    const jb = Buffer.alloc(jsonSize)
    readSync(fd, jb, 0, jsonSize, 16)
    const headerPickle = head.readUInt32LE(4)
    const base = 8 + headerPickle
    const size = Number(entry.size)
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, base + Number(entry.offset))
    return { buf, base, abs: base + Number(entry.offset) }
  } finally { closeSync(fd) }
}

function openAsarHeader(asar) {
  const fd = openSync(asar, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const jsonSize = head.readUInt32LE(12)
  const jb = Buffer.alloc(jsonSize)
  readSync(fd, jb, 0, jsonSize, 16)
  closeSync(fd)
  return JSON.parse(jb.toString('utf8'))
}

function buildPatched(src) {
  const edits = []
  for (const [from, to] of PATCHES) {
    let i = -1
    while ((i = src.indexOf(from, i + 1)) >= 0) { edits.push({ at: i, from, to }); i += from.length - 1 }
  }
  edits.sort((a, b) => a.at - b.at)
  if (edits.length === 0) return { count: 0, out: src }
  const added = edits.reduce((a, e) => a + (e.to.length - e.from.length), 0)
  let out = '', cursor = 0
  for (const e of edits) { out += src.slice(cursor, e.at) + e.to; cursor = e.at + e.from.length }
  out += src.slice(cursor)

  if (added > 0) {
    // asar 里文件长度写死在头部，改完必须等长。两种腾字节的办法，都是往注释里删字符（注释内容不参与语义）
    const need = added
    let done = false

    // 策略一：块注释里裁掉一整段文字
    const blockRe = /\/\*[\s\S]{0,4000}?\*\//g
    let m, chosen = null
    while ((m = blockRe.exec(out)) && !chosen) {
      const lines = m[0].slice(2, -2).split('\n')
      for (let li = 0; li < lines.length; li++) {
        const core = lines[li].replace(/\s+$/, '')
        const lead = core.length - core.replace(/^[\s*]+/, '').length
        const text = core.slice(lead)
        if (text.length >= need + 15 && /^[A-Za-z]/.test(text)) { chosen = { m, li, need }; break }
      }
    }
    if (chosen) {
      const lines = chosen.m[0].slice(2, -2).split('\n')
      const core = lines[chosen.li].replace(/\s+$/, '')
      const newCore = core.slice(0, core.length - need)
      if (newCore.slice(-1) === '*') throw new Error('裁剪位置不安全，拒绝改写')
      lines[chosen.li] = newCore + lines[chosen.li].slice(core.length)
      out = out.slice(0, chosen.m.index) + '/*' + lines.join('\n') + '*/' + out.slice(chosen.m.index + chosen.m[0].length)
      done = true
    }

    // 策略二：生产包里通常没有块注释，只有 sourceMappingURL 之类的 // 行注释，正文可任意截短
    if (!done) {
      const lineRe = /(^|\n)([ \t]*)\/\/([^\n{}'"`]*)$/g
      let hit = null
      while ((m = lineRe.exec(out))) {
        const body = m[3]
        if (body.length >= need + 8 && !body.includes('*/')) hit = { m, body }
      }
      if (!hit) throw new Error('找不到可裁剪的注释，拒绝改写（避免长度不一致损坏 asar）')
      const trimmed = hit.body.slice(0, hit.body.length - need)
      out = out.slice(0, hit.m.index) + hit.m[0].slice(0, hit.m[0].length - need) + out.slice(hit.m.index + hit.m[0].length)
      if (!out.includes(trimmed)) throw new Error('行注释裁剪校验失败')
    }
  }
  return { count: edits.length, out, added }
}

function verifySyntax(code) {
  const tmp = join(tmpdir(), `dsh-chat-check-${process.pid}.mjs`)
  writeFileSync(tmp, code, 'utf8')
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
  try { unlinkSync(tmp) } catch { }
  return { ok: r.status === 0, msg: (r.stderr || '').split('\n').slice(0, 4).join(' ') }
}

function patchStatus() {
  const asar = findAsar()
  if (!asar) return { found: false }
  const h = openAsarHeader(asar)
  const entry = findInAsar(h)
  if (!entry) return { found: true, asar, entry: false }
  const { buf } = readAsarEntry(asar, entry)
  const s = buf.toString('utf8')
  const bare = PATCHES.reduce((n, [from]) => n + (s.split(from).length - 1), 0)
  return { found: true, asar, entry: true, bare, patched: s.includes('data.reason?.kind') }
}

function cmdPatch(apply) {
  const asar = findAsar()
  if (!asar) {
    console.log('✗ 找不到 app.asar。可用 DSH_ASAR=<完整路径> 手工指定。')
    console.log('  已尝试：\n    ' + asarCandidates().join('\n    '))
    return
  }
  console.log('目标:', asar)
  const h = openAsarHeader(asar)
  const entry = findInAsar(h)
  if (!entry) { console.log('✗ asar 里没找到 ' + TARGET_SUFFIX + '（版本结构可能变了，需要人工排查）'); return }
  const { buf, abs } = readAsarEntry(asar, entry)
  const src = buf.toString('utf8')
  const st = patchStatus()
  console.log(`裸读 .kind：${st.bare} 处 | 已有 ?. 防护：${st.patched ? '是' : '否'}`)
  if (st.bare === 0) { console.log('✓ 已是打过补丁的状态，无需重复'); return }

  const { count, out } = buildPatched(src)
  const outBuf = Buffer.from(out, 'utf8')
  console.log(`待改写 ${count} 处，长度校验 ${buf.length} -> ${outBuf.length} ${buf.length === outBuf.length ? 'OK' : 'MISMATCH'}`)
  if (buf.length !== outBuf.length) { console.log('✗ 长度不一致，已中止'); return }
  const syn = verifySyntax(out)
  console.log('语法校验:', syn.ok ? 'OK' : '✗ ' + syn.msg)
  if (!syn.ok) { console.log('✗ 补丁后语法不通过，已中止'); return }

  if (!apply) { console.log('\n[dry] 未写入。加 --apply 生效（需先退出应用）。'); return }
  const bak = asar + '.bak-reasonfix'
  if (!existsSync(bak)) copyFileSync(asar, bak)
  else console.log('备份已存在，保留最早的原始字节:', bak)
  const fd = openSync(asar, 'r+')
  try { writeSync(fd, outBuf, 0, outBuf.length, abs) } finally { closeSync(fd) }
  console.log(`✓ 已写入（${abs}）。重启 DeepSeek Harness 生效。`)
}

function cmdRestoreAsar() {
  const asar = findAsar()
  if (!asar) { console.log('✗ 找不到 app.asar'); return }
  const bak = asar + '.bak-reasonfix'
  if (!existsSync(bak)) { console.log('没有找到备份 ' + bak); return }
  copyFileSync(bak, asar)
  console.log('✓ 已从备份还原客户端，重启生效')
}

// ---------------------------------------------------------------- 原地改名

/**
 * dsh 的标题就是一条事件：session/title {title, messageSeqs:[], source:{kind:"user"}}，
 * 投影规则是「最后一条生效」（dsh-session-title 的 titleProjectionDefinition.apply）。
 * 所以改名 = 追加一条同 schema 事件，不动任何历史事件，可随时再追加一条覆盖回来。
 */
function findSessionByPrefix(prefix) {
  const rows = listSessions().filter(r => r.sid.includes(prefix))
  if (rows.length === 0) return { err: `没有匹配 "${prefix}" 的会话` }
  if (rows.length > 1) return { err: `"${prefix}" 匹配到 ${rows.length} 个会话，请给更长的前缀`, rows }
  return { row: rows[0] }
}


// 侧栏列表读投影缓存（storages/session_projcache），改完事件要同步标题行，否则要打开会话才刷新
function syncCacheTitle(sid, title, seq) {
  const f = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', sid + '.json')
  if (!existsSync(f)) return 'no-cache'
  let j
  try { j = JSON.parse(readFileSync(f, 'utf8')) } catch { return 'unreadable' }
  const row = j.record?.rows?.title
  if (!row) return 'no-row'
  if (typeof row.seq === 'number' && row.seq >= seq && row.val === title) return 'up-to-date'
  row.seq = seq
  row.val = title
  const bak = f + '.bak-rename-' + STAMP
  copyFileSync(f, bak)
  const tmp = f + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(j), 'utf8')
  JSON.parse(readFileSync(tmp, 'utf8'))
  renameSync(tmp, f)
  return 'synced'
}

function cmdRename(prefix, title, apply) {
  if (!prefix || !title) { console.log('用法: node doctor.mjs rename <会话id前缀> "<新标题>" [--apply]'); return }
  const { row, err } = findSessionByPrefix(prefix)
  if (err) { console.log('✗ ' + err); return }
  if (title.length > 60) { console.log('✗ 标题过长（>60 字符），dsh 侧有字节上限，请缩短'); return }

  const frames = decodeBuf(readFileSync(row.file))
  let maxSeq = -1, last = null, count = 0, curTitle = null
  for (const f of frames) {
    if (!f.ok) continue
    for (const l of f.text.split('\n')) {
      if (!l.trim()) continue
      count++
      let o; try { o = JSON.parse(l) } catch { continue }
      if (typeof o.seq === 'number' && o.seq > maxSeq) { maxSeq = o.seq; last = o }
      if (o.type === 'session/title' && o.data?.title) curTitle = o.data.title
    }
  }
  const ev = { type: 'session/title', seq: maxSeq + 1, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } }
  console.log(`会话      ${row.sid}`)
  console.log(`当前标题  ${curTitle || '(无)'}`)
  console.log(`新标题    ${title}`)
  console.log(`事件数    ${count}（末条 seq=${maxSeq} ${last?.type}）→ 追加 seq=${ev.seq}`)

  if (curTitle === title) {
    console.log('\n标题已是目标值，无需追加事件')
    if (apply) console.log('缓存同步：' + syncCacheTitle(row.sid, title, maxSeq))
    return
  }

  if (!apply) { console.log('\n[dry] 未写入。加 --apply 生效（需先退出应用）。'); return }

  const running = appRunning()
  if (running > 0) { console.log(`\n✗ 检测到 ${running} 个 DeepSeek Harness 进程在运行，请先完全退出（含托盘），否则会被内存状态覆盖。`); return }

  const bak = `${row.file}.bak-rename-${STAMP}`
  copyFileSync(row.file, bak)
  const payload = zstdCompressSync(Buffer.from(JSON.stringify(ev) + '\n', 'utf8'))
  appendFileSync(row.file, payload)

  // 校验：重新解码，末条必须是我们写的事件，事件数 +1
  const after = decodeBuf(readFileSync(row.file))
  const lines = after.filter(f => f.ok).flatMap(f => f.text.split('\n').filter(l => l.trim()))
  let ok = false, tail = null
  try { tail = JSON.parse(lines[lines.length - 1]); ok = tail.type === 'session/title' && tail.seq === ev.seq && tail.data?.title === title } catch { }
  console.log(`\n${ok ? '✓' : '✗'} 写入${ok ? '成功' : '校验失败'}：事件 ${count} -> ${lines.length}，末条 ${tail?.type} seq=${tail?.seq}`)
  const sync = ok ? syncCacheTitle(row.sid, title, ev.seq) : 'skipped'
  console.log(`  备份 ${basename(bak)}`)
  console.log(`  列表缓存 ${sync}`)
  if (ok) console.log('  重新打开应用即可看到新标题。')
}

function cmdRestoreTitle(prefix) {
  const { row, err } = findSessionByPrefix(prefix || '')
  if (err) { console.log('✗ ' + err); return }
  const dir = dirname(row.file), base = basename(row.file)
  const baks = readdirSync(dir).filter(f => f.startsWith(base + '.bak-rename-')).sort().reverse()
  if (baks.length === 0) { console.log('没有找到该会话的改名备份'); return }
  copyFileSync(join(dir, baks[0]), row.file)
  console.log(`✓ 已从 ${baks[0]} 还原（改了名的会话回到原状）`)
}

// ---------------------------------------------------------------- 目标盘点

function cmdGoals() {
  const rows = listSessions()
  const out = []
  for (const r of rows) {
    let text = ''
    try { text = decodeBuf(readFileSync(r.file)).filter(f => f.ok).map(f => f.text).join('') } catch { continue }
    const goals = []
    let title = null
    for (const l of text.split('\n')) {
      if (!l.trim()) continue
      let o; try { o = JSON.parse(l) } catch { continue }
      if (o.type === 'goal/change') goals.push(o)
      if (o.type === 'session/title' && o.data?.title) title = o.data.title
    }
    if (goals.length === 0) continue
    const last = goals[goals.length - 1]
    const g = last.data?.goal || {}
    out.push({ sid: r.sid, ws: r.wsDir, title, mtime: r.mtimeMs, obj: g.objective || '', phase: g.phase, rev: g.revision, rounds: last.data?.roundsStarted ?? 0, max: g.maxGoalRounds, lastAt: last.time })
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  if (out.length === 0) { console.log('磁盘上没有任何会话带目标'); return }
  const iso = t => (t ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '-')
  console.log(`带目标的会话：${out.length} 个\n`)
  for (const r of out) {
    console.log(`${iso(r.lastAt)}  ${String(r.phase || '?').padEnd(9)} rev${r.rev}  ${r.rounds}/${r.max} 轮   会话文件更新 ${iso(r.mtime)}`)
    console.log(`  ${r.sid}`)
    console.log(`  标题：${r.title || '(无)'}`)
    console.log(`  目标：${r.obj.slice(0, 120)}`)
    console.log('')
  }
  const active = out.filter(r => r.phase === 'active' && r.rounds > 0)
  if (active.length) {
    const newest = Math.max(...active.map(r => r.lastAt || 0))
    const quietMin = Math.round((Date.now() - newest) / 60000)
    if (quietMin > 30) console.log(`注意：有 ${active.length} 个 active 目标已 ${Math.round(quietMin / 60)} 小时没有推进（最后 ${iso(newest)}）。目标轮次由应用在会话打开时驱动，应用未运行就不会自走。`)
  }
}

// ---------------------------------------------------------------- 日志诊断

function cmdLogs() {
  const dirs = crashLogDirs()
  if (dirs.length === 0) { console.log('没有找到崩溃日志目录'); return }
  const files = []
  for (const d of dirs) {
    for (const f of readdirSync(d).filter(x => /^crash-.*\.log$/.test(x))) {
      files.push({ d, f, m: statSync(join(d, f)).mtimeMs })
    }
  }
  files.sort((a, b) => b.m - a.m)
  const hit = []
  for (const f of files.slice(0, 8)) {
    const txt = readFileSync(join(f.d, f.f), 'utf8')
    const n = (txt.match(/reading 'kind'/g) || []).length
    if (n > 0) hit.push({ ...f, n })
  }
  if (hit.length === 0) { console.log(`✓ 最近 ${Math.min(8, files.length)} 个崩溃日志里没有 kind 报错`); return }
  const asar = findAsar()
  const asarM = asar ? statSync(asar).mtimeMs : 0
  const patched = patchStatus()
  console.log('✗ 命中「Cannot read properties of null (reading \'kind\')」的日志：')
  let active = 0
  for (const h of hit) {
    const after = !asarM || h.m > asarM
    if (after) active++
    console.log(`  ${h.f}  ${new Date(h.m).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}  ${h.n} 次  ${after ? '【补丁后仍在发生】' : '（早于当前客户端，历史记录）'}`)
  }
  if (active > 0) {
    console.log('\n⚠ 有日志晚于当前 app.asar，说明补丁未生效或已被升级覆盖：')
    console.log('  node doctor.mjs patch --apply   （需先退出应用）')
  } else if (patched.found && patched.patched && patched.bare === 0) {
    console.log('\n✓ 这些报错都早于当前客户端，防护已生效，属于历史日志，无需处理。')
  } else {
    console.log('\n补丁当前未生效：node doctor.mjs patch --apply')
  }
}

// ---------------------------------------------------------------- 总览

function cmdStatus() {
  console.log('=== 环境 ===')
  console.log('DSH_HOME :', DSH_HOME, existsSync(DSH_HOME) ? '' : '(不存在)')
  console.log('平台     :', platform())

  const { total, bad } = scanAll()
  console.log('\n=== 数据层 ===')
  console.log(`会话总数 ${total}，问题会话 ${bad.length}`)
  for (const b of bad.slice(0, 10)) {
    const why = [b.bad ? `非法 reason ${b.bad} 处` : '', b.undecodable ? `坏帧 ${b.undecodable}` : '', b.error || ''].filter(Boolean).join(' / ')
    console.log(`  - ${b.sid}: ${why}`)
  }

  console.log('\n=== 首帧不变量（列表里看不到/打不开的真正原因）===')
  {
    const rows = listSessions()
    const off = []
    for (const r of rows) {
      let res
      try { res = headerFrameCheck(r.file) } catch (e) { res = { ok: false, why: e.message } }
      if (!res.ok) off.push({ sid: r.sid, why: res.why })
    }
    console.log(`违规 ${off.length} / ${rows.length} 个会话`)
    for (const o of off.slice(0, 10)) console.log(`  - ${o.sid.slice(0, 30)}: ${o.why}`)
    if (off.length) console.log('  → node doctor.mjs frames --apply 可原地重排（只改分帧，内容不变）')
  }

  console.log('\n=== 投影层（turn/end 结构）===')
  {
    let badFiles = 0, badEvents = 0, sample = null
    for (const r of listSessions()) {
      let s
      try { s = scanBadEnds(r.file) } catch { continue }
      if (s.bad.length) {
        badFiles++
        badEvents += s.bad.length
        if (!sample) sample = r.sid
      }
    }
    if (badFiles === 0) console.log('✓ 无畸形 turn/end')
    else {
      console.log(`畸形 turn/end ${badEvents} 条 / ${badFiles} 个会话（如 ${sample}）`)
      console.log("  → 这些会话会报「历史加载失败：failed to project session …」（缺 error.code → reading 'code'；reason 为 null → reading 'kind'，gateway/internal）")
      console.log('  → node doctor.mjs endcheck --apply')
    }
  }

  console.log('\n=== 注册表层 ===')
  if (existsSync(REG_PATH)) {
    const reg = JSON.parse(readFileSync(REG_PATH, 'utf8'))
    let regCount = 0, orphan = 0
    for (const [wsId, rec] of Object.entries(reg.tables?.workspaces || {})) {
      if (!rec.path) continue
      regCount += (rec.sessionIds || []).length
      const dir = join(SESS_ROOT, wsDirForPath(rec.path))
      if (!existsSync(dir)) continue
      const set = new Set(rec.sessionIds)
      for (const sid of readdirSync(dir)) {
        if (!/^(session|onebot)-/.test(sid)) continue
        if (!existsSync(join(dir, sid, 'session.v4.jsonl.zstd'))) continue
        if (!set.has(sid)) orphan++
      }
    }
    console.log(`已登记 ${regCount} 个会话，磁盘上未登记的 ${orphan} 个`)
    if (orphan) console.log('  → node doctor.mjs registry 可挂回')
  } else console.log('workspace.json 不存在')

  console.log('\n=== 客户端层 ===')
  const st = patchStatus()
  if (!st.found) console.log('✗ 未找到 app.asar（可用 DSH_ASAR 指定）')
  else if (!st.entry) console.log('? asar 内未找到 ' + TARGET_SUFFIX)
  else console.log(`裸读 .kind ${st.bare} 处 | ?. 防护 ${st.patched ? '已生效' : '未生效'}`)

  console.log('\n=== 写入端（reason:null 防复发）===')
  const g = reasonGuardStatus()
  if (!g) console.log('? 未找到 app.asar')
  else {
    const on = g.filter(x => x.state === 'on').length
    console.log(g.map(x => `${x.label} ${x.state === 'on' ? '✓' : x.state === 'missing' ? '?' : '✗'}`).join('  ') + `   ${on}/${g.length}`)
    if (on < g.length) console.log('  → node scripts/reasonguard.mjs --apply（先退出应用；dsh 每次升级后必重打）')
  }

  console.log('\n=== 崩溃日志 ===')
  const dirs = crashLogDirs()
  if (dirs.length === 0) console.log('无日志目录')
  else {
    const files = []
    for (const d of dirs) for (const f of readdirSync(d).filter(x => /^crash-.*\.log$/.test(x))) files.push({ d, f, m: statSync(join(d, f)).mtimeMs })
    files.sort((a, b) => b.m - a.m)
    const latest = files[0]
    if (!latest) console.log('暂无崩溃日志')
    else {
      const n = (readFileSync(join(latest.d, latest.f), 'utf8').match(/reading 'kind'/g) || []).length
      const asarM = st.found ? statSync(st.asar).mtimeMs : 0
      const after = n > 0 && (!asarM || latest.m > asarM)
      console.log(`最新 ${latest.f}（${new Date(latest.m).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}） kind 报错 ${n} 次`)
      if (n > 0) console.log(after ? '  ⚠ 该日志晚于当前客户端：补丁未生效/被覆盖 → patch --apply' : '  · 早于当前客户端，属历史日志')
    }
  }

  console.log('\n=== 第三方改写者（"修好又坏"的复发根源）===')
  {
    const hits = appMutators()
    if (hits.length === 0) console.log('✓ 未发现自动改写会话文件的脚本或计划任务')
    else {
      for (const h of hits.slice(0, 6)) console.log(`  ⚠ ${h.where} —— ${h.what}`)
      console.log('  → node doctor.mjs guards 看详情与处置')
    }
  }
}

function cmdRestore(file) {
  if (!file) { console.log('用法: node doctor.mjs restore <会话文件完整路径>'); return }
  const dir = dirname(file)
  const base = basename(file)
  const baks = readdirSync(dir).filter(f => f.startsWith(base + '.bak-reasonfix-')).sort().reverse()
  if (baks.length === 0) { console.log('没有找到该文件的 .bak-reasonfix-* 备份'); return }
  copyFileSync(join(dir, baks[0]), file)
  console.log(`✓ 已从 ${baks[0]} 还原`)
}

// ---------------------------------------------------------------- 首帧不变量

/*
 * host 的 readFirstZstdLine 里有一句断言，注释写得很直白：
 *   "Assert that the independently decodable first frame contains only the header record."
 * 也就是「第一个 zstd 帧必须只装会话头那一行」。
 * 一旦不满足就抛 SessionPersistenceCorruptionError，而 listArtifacts 捕获它之后
 * 返回 metadata: undefined 并 continue —— 会话被静默跳过：不进侧栏、点开打不开，
 * 但磁盘上的数据一条不少。任何「整份重压成一帧」的工具都会踩这个坑。
 */
function headerFrameCheck(file) {
  const buf = readFileSync(file)
  const next = buf.indexOf(MAGIC, 1)
  const end = next > 0 ? next : buf.length
  let text
  try { text = zstdDecompressSync(buf.subarray(0, end)).toString('utf8') } catch (e) {
    return { ok: false, why: `首帧解不开: ${e.message}` }
  }
  if (!text.endsWith('\n')) return { ok: false, why: '首帧没有结尾换行' }
  if (text.indexOf('\n') !== text.length - 1) {
    return { ok: false, why: `首帧装了 ${text.split('\n').length - 1} 行（应只有会话头 1 行）` }
  }
  return { ok: true }
}

// 按行边界切块，避免把一行 JSON 拆到两个帧里
function chunkByLines(buf, target) {
  const out = []
  let start = 0, last = 0
  while (last < buf.length) {
    const nl = buf.indexOf(10, last)
    if (nl < 0) { last = buf.length; break }
    last = nl + 1
    if (last - start >= target) { out.push(buf.subarray(start, last)); start = last }
  }
  if (start < buf.length) out.push(buf.subarray(start))
  return out
}

function reframeFile(file, apply) {
  const buf = readFileSync(file)
  const frames = decodeBuf(buf)
  const broken = frames.filter(f => !f.ok)
  if (broken.length > 0) return { ok: false, why: `${broken.length} 个帧解不开，先修数据再重排` }
  const plain = Buffer.concat(frames.map(f => zstdDecompressSync(f.raw)))
  const nl = plain.indexOf(10)
  if (nl < 0) return { ok: false, why: '明文没有换行，分不出会话头' }
  const header = plain.subarray(0, nl + 1)
  let head
  try { head = JSON.parse(header.toString('utf8')) } catch { return { ok: false, why: '首行不是合法 JSON' } }
  if (head.type !== 'session') return { ok: false, why: `首行 type=${head.type}，不是会话头` }

  const chunks = [header, ...chunkByLines(plain.subarray(nl + 1), 1 << 20)]
  const out = Buffer.concat(chunks.map(c => zstdCompressSync(c)))
  const round = Buffer.concat(decodeBuf(out).map(f => zstdDecompressSync(f.raw)))
  if (!round.equals(plain)) return { ok: false, why: '回读内容与原文件不一致，已放弃写入' }

  if (!apply) return { ok: true, dirty: true, frames: frames.length, newFrames: chunks.length, before: buf.length, after: out.length }

  const bak = `${file}.bak-reframe-${STAMP}`
  copyFileSync(file, bak)
  const tmp = `${file}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  writeFileSync(fd, out)
  fsyncSync(fd)
  closeSync(fd)
  renameSync(tmp, file)
  return { ok: true, dirty: true, frames: frames.length, newFrames: chunks.length, before: buf.length, after: out.length, backup: basename(bak) }
}

function cmdFrames(apply) {
  const rows = listSessions()
  const bad = []
  for (const r of rows) {
    let res
    try { res = headerFrameCheck(r.file) } catch (e) { res = { ok: false, why: e.message } }
    if (!res.ok) bad.push({ ...r, why: res.why })
  }
  console.log(`扫描 ${rows.length} 个会话，首帧不变量异常 ${bad.length} 个`)
  if (bad.length === 0) { console.log('✓ 全部合规：每个会话的首帧都只装会话头'); return }
  if (appRunning() > 0 && apply) { console.log('✗ 应用正在运行，请先完全退出再修（避免写入冲突）'); return }
  let done = 0
  for (const b of bad) {
    console.log(`\n# ${b.sid}`)
    console.log(`  工作区 ${b.wsDir}`)
    console.log(`  原因 ${b.why}`)
    console.log(`  时间 ${new Date(b.mtimeMs).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}  ${Math.round(b.size / 1024)}KB`)
    let r
    try { r = reframeFile(b.file, apply) } catch (e) { r = { ok: false, why: e.message } }
    if (!r.ok) { console.log(`  ✗ ${r.why}`); continue }
    console.log(`  帧 ${r.frames} → ${r.newFrames}   ${r.before} → ${r.after} 字节`)
    if (apply) { console.log(`  ✓ 已重排，备份 ${r.backup}`); done++ }
  }
  if (apply) console.log(`\n完成：修复 ${done} 个。重新打开应用，这些会话就会回到列表。`)
  else console.log('\n[dry] 未写入。加 --apply 修复（需先退出应用）。')
}

// ---------------------------------------------------------------- turn/end 投影损坏

/**
 * 第二类「历史加载失败」，和 reason:null 同一家族但不是同一个 bug：
 *
 *   { "kind": "error", "message": "turn aborted (...)" }        ← 缺 error 对象
 *
 * dsh 的 continuation 投影里有这一行：
 *   CONTINUABLE_FAILURES.has(event.data.reason.error.code)
 * kind 是 "error" 但 error 不存在 → TypeError: Cannot read properties of undefined (reading 'code')
 * → preparedProjections 抛错 → 整个会话投影失败 → 前端报
 *   「历史加载失败：failed to project session "<id>": Cannot read properties of undefined (reading 'code')（gateway/internal）」
 *
 * 这类事件不是 dsh 自己写的，是外部「桥接救援工具」在限流后补的收尾事件（message 里带 repaired by bridge tooling）。
 * 修复 = 补出 schema 要求的 error 对象，语义不变（限流仍是限流）。
 */
const END_MESSAGE_KEY = 'repaired by bridge tooling'

function classifyEndReason(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'reason 不是对象'
  if (typeof r.kind !== 'string') return 'reason.kind 缺失'
  if (r.kind === 'error') {
    if (!r.error || typeof r.error !== 'object' || typeof r.error.code !== 'string') return 'kind=error 但 error.code 缺失'
  }
  return null
}

function guessFailureCode(msg) {
  const m = String(msg || '').toLowerCase()
  if (/rate limit|429|too many requests|concurrency limit/.test(m)) return 'RATE_LIMIT'
  if (/timeout|timed out/.test(m)) return 'TIMEOUT'
  if (/connection|transport|socket|terminated/.test(m)) return 'TRANSPORT'
  if (/closed|stream ended/.test(m)) return 'STREAM_CLOSED'
  if (/server|502|503|500/.test(m)) return 'SERVER'
  if (/empty response/.test(m)) return 'EMPTY_RESPONSE'
  return 'UNKNOWN'
}

function fixEndReason(r) {
  if (r && typeof r === 'object' && typeof r.kind === 'string') {
    if (r.kind !== 'error') return r
    const msg = typeof r.message === 'string' && r.message
      ? r.message
      : (typeof r.error?.message === 'string' ? r.error.message : 'turn failed')
    return { kind: 'error', error: { message: msg, code: guessFailureCode(msg) } }
  }
  // 连 kind 都没有的（历史上有过 reason:null）：按「用户中止」收尾，不假装成功
  return { kind: 'aborted', reason: { kind: 'user' } }
}

function scanBadEnds(file) {
  const parts = decodeBuf(readFileSync(file))
  const bad = []
  let ends = 0, decodeFail = 0
  for (const p of parts) {
    if (!p.ok) { decodeFail++; continue }
    if (!p.text.includes('"turn/end"')) continue
    for (const l of p.text.split('\n')) {
      if (!l.trim() || !l.includes('"turn/end"')) continue
      let o; try { o = JSON.parse(l) } catch { continue }
      if (o.type !== 'turn/end') continue
      ends++
      const why = classifyEndReason(o.data?.reason)
      if (why) bad.push({ seq: o.seq, why, reason: o.data?.reason, raw: l })
    }
  }
  return { bad, ends, decodeFail, frames: parts.length }
}

function repairEnds(file, apply) {
  const buf = readFileSync(file)
  const parts = decodeBuf(buf)
  let changed = 0
  const outParts = []
  const beforeLines = []

  for (const p of parts) {
    if (!p.ok) { outParts.push(p.raw); continue }
    if (!p.text.includes('"turn/end"')) {
      beforeLines.push(...p.text.split('\n'))
      outParts.push(p.raw)
      continue
    }
    const lines = p.text.split('\n')
    let touched = false
    const next = lines.map(l => {
      if (!l.trim() || !l.includes('"turn/end"')) return l
      let o; try { o = JSON.parse(l) } catch { return l }
      if (o.type !== 'turn/end' || !classifyEndReason(o.data?.reason)) return l
      o.data.reason = fixEndReason(o.data.reason)
      touched = true
      changed++
      return JSON.stringify(o)
    })
    beforeLines.push(...lines)
    outParts.push(touched ? zstdCompressSync(Buffer.from(next.join('\n'), 'utf8')) : p.raw)
  }

  const out = Buffer.concat(outParts)
  const after = decodeBuf(out).filter(p => p.ok).flatMap(p => p.text.split('\n'))
  const okShape = after.length === beforeLines.length

  return { changed, before: buf.length, after: out.length, bytes: out, okShape, lines: after.length }
}

function cmdEndcheck(apply) {
  const rows = listSessions()
  const dirty = []
  for (const r of rows) {
    let res
    try { res = scanBadEnds(r.file) } catch (e) { dirty.push({ ...r, err: e.message }); continue }
    if (res.bad.length) dirty.push({ ...r, ...res })
  }
  const totalBad = dirty.reduce((n, d) => n + (d.bad?.length || 0), 0)
  console.log(`扫描 ${rows.length} 个会话，畸形 turn/end ${totalBad} 条，涉及 ${dirty.length} 个会话`)
  if (dirty.length === 0) { console.log('✓ 全部合规：没有「kind=error 但缺 error.code」的收尾事件'); return }

  for (const d of dirty) {
    console.log(`\n# ${d.sid}  ${(d.bad?.length ?? '?')}/${d.ends ?? '?'} 条`)
    console.log(`  ${d.file}`)
    if (d.err) { console.log('  ERROR ' + d.err); continue }
    for (const b of d.bad.slice(0, 5)) console.log(`   seq=${b.seq} ${b.why} :: ${JSON.stringify(b.reason).slice(0, 120)}`)
    if (d.bad.length > 5) console.log(`   … 另 ${d.bad.length - 5} 条`)
  }

  if (!apply) {
    console.log('\n[dry] 未写入。加 --apply 修复（需先完全退出应用）。')
    console.log('修复方式：给这些 turn/end 补出 schema 要求的 error 对象，消息原样保留，code 按内容推断（限流→RATE_LIMIT 等）。其余事件与帧逐字节不变。')
    return
  }
  const running = appRunning()
  if (running > 0) { console.log(`\n✗ 检测到 ${running} 个进程在运行，请先完全退出（含托盘），否则改动会被内存状态覆盖。`); return }

  let fixedFiles = 0, fixedEvents = 0
  for (const d of dirty) {
    if (d.err) continue
    let r
    try { r = repairEnds(d.file, true) } catch (e) { console.log(`\n✗ ${d.sid}: ${e.message}`); continue }
    if (r.changed === 0) continue
    if (!r.okShape) { console.log(`\n✗ ${d.sid}: 行数校验失败（${r.lines}），放弃写入`); continue }
    const bak = `${d.file}.bak-endfix-${STAMP}`
    copyFileSync(d.file, bak)
    const tmp = `${d.file}.tmp-${process.pid}`
    writeFileSync(tmp, r.bytes)
    renameSync(tmp, d.file)
    console.log(`✓ ${d.sid}: 修 ${r.changed} 条，${Math.round(r.before / 1024)}KB → ${Math.round(r.after / 1024)}KB，备份 ${basename(bak)}`)
    fixedFiles++
    fixedEvents += r.changed
  }
  console.log(`\n完成：${fixedFiles} 个会话 / ${fixedEvents} 条事件。重新打开应用，这些会话的历史就能加载了。`)
  console.log('还原：把 *.bak-endfix-* 覆盖回 session.v4.jsonl.zstd 即可。')
}

// ---------------------------------------------------------------- 血缘（分支）

/**
 * dsh 的「分支」不是给原会话挂个标签，而是**新建一个普通会话**：
 * 把源会话 seq 0..boundary 的事件原样复制过去，并追加一条
 * `session/end-seed {inherited:true}` 标出切点（见 dsh-session/lib/types/fork.js 的 buildForkSeed）。
 *
 * 副作用非常反直觉：**分支出来的新会话继承原名，原会话被改名成「名字 (1)」**。
 * 所以「我明明在原来那个会话里接着做，怎么历史变短了 / 怎么换了个会话」
 * 十有八九是这一条 —— 你看到的名字属于子会话，你继续的那条才是父。
 *
 * 判定不依赖任何索引：两会话共享一段逐事件完全相同的长前缀（type + time + data 长度一致），
 * 且切点正好落在一条 inherited 的 end-seed 上，就是父子关系。
 */

function readEventSigs(file) {
  const buf = readFileSync(file)
  const frames = decodeBuf(buf)
  let text = ''
  for (const f of frames) if (f.ok) text += f.text
  const sigs = [], times = [], seeds = []
  let turns = new Set(), users = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    sigs.push(`${o.type}|${o.time ?? ''}|${JSON.stringify(o.data ?? '').length}`)
    if (typeof o.time === 'number') times.push(o.time)
    if (o.type === 'session/end-seed' && o.data?.inherited === true) seeds.push(sigs.length - 1)
    if (o.type === 'turn/start' && typeof o.data?.turn === 'number') turns.add(o.data.turn)
    if (o.type === 'user/message') users++
  }
  return { sigs, times, seeds, turns: turns.size, users, count: sigs.length }
}

function cachedTitleOf(sid) {
  const f = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', sid + '.json')
  if (!existsSync(f)) return ''
  try { return JSON.parse(readFileSync(f, 'utf8')).record?.rows?.title?.val ?? '' } catch { return '' }
}

const fmtStamp = (ms) => (typeof ms === 'number' && isFinite(ms) ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') : '?')

function findForkPairs() {
  const rows = listSessions()
  const dict = []
  for (const r of rows) {
    let info
    try { info = readEventSigs(r.file) } catch { info = { sigs: [], times: [], seeds: [], turns: 0, users: 0, count: 0 } }
    dict.push({ ...r, ...info, title: cachedTitleOf(r.sid) })
  }
  const buckets = new Map()
  for (const d of dict) {
    if (d.count < 40) continue
    const key = d.sigs.slice(0, 30).join('\u0001')
    const a = buckets.get(key) ?? []
    a.push(d)
    buckets.set(key, a)
  }
  const pairs = []
  for (const g of buckets.values()) {
    if (g.length < 2) continue
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const A = g[i], B = g[j]
        let n = 0
        while (n < A.count && n < B.count && A.sigs[n] === B.sigs[n]) n++
        if (n < 40) continue
        let parent, child, sure
        // 注意索引偏移：明文里第 0 行是会话头（没有 seq），所以「行索引 = seq + 1」。
        // 父在切点后追加的 inherited end-seed 落在共享前缀的下一行，即索引 n。
        const marked = (d) => d.seeds.includes(n) || d.seeds.includes(n - 1)
        if (marked(A)) { parent = A; child = B; sure = true }
        else if (marked(B)) { parent = B; child = A; sure = true }
        else if (A.count > B.count) { parent = A; child = B; sure = false }
        else { parent = B; child = A; sure = false }
        pairs.push({ n, parent, child, sure })
      }
    }
  }
  return { dict, pairs }
}

function cmdLineage(focus) {
  const { dict, pairs } = findForkPairs()
  const line = (d, prefix) => {
    const end = d.times[d.times.length - 1]
    console.log(`${prefix}${d.sid.slice(0, 44)}  ${d.title || '(无标题)'}`)
    console.log(`   ${d.count} 事件 · ${d.turns} turn · ${d.users} 用户消息 · ${fmtStamp(d.times[0])} → ${fmtStamp(end)}`)
  }

  if (focus) {
    const hits = dict.filter((d) => d.sid.includes(focus))
    if (hits.length === 0) { console.log(`没有匹配 "${focus}" 的会话`); return }
    for (const d of hits) {
      console.log(`\n=== ${d.sid}`)
      line(d, '')
      const asParent = pairs.filter((p) => p.parent.sid === d.sid)
      const asChild = pairs.filter((p) => p.child.sid === d.sid)
      if (asChild.length) {
        for (const p of asChild) {
          console.log(`\n  ⬆ 它是分支出来的：源会话 ${p.parent.sid.slice(0, 44)}（${p.parent.title || '无标题'}）`)
          console.log(`     分叉于 seq ${p.n - 1}（${fmtStamp(p.parent.times[p.n - 1])}），继承 ${p.n} 条，自己写了 ${d.count - p.n} 条`)
          console.log(`     名字归属：分支继承了原名，源会话被改名成「${(p.parent.title || '').replace(/ \(1\)$/, '')} (1)」`)
        }
      }
      if (asParent.length) {
        for (const p of asParent) {
          console.log(`\n  ⬇ 它分出了分支：${p.child.sid.slice(0, 44)}（${p.child.title || '无标题'}）`)
          console.log(`     分叉于 seq ${p.n - 1}（${fmtStamp(p.times[p.n - 1])}），子继承 ${p.n} 条，之后这条自己又写了 ${d.count - p.n} 条`)
        }
      }
      if (!asParent.length && !asChild.length) console.log('\n  没有分支关系（独立会话）')
    }
    return
  }

  if (pairs.length === 0) {
    console.log(`扫描 ${dict.length} 个会话，没有发现分支（fork）关系。`)
    console.log('历史"变少"就是真的少了 —— 用 goals / endcheck / frames 继续查。')
    return
  }
  console.log(`扫描 ${dict.length} 个会话，发现 ${pairs.length} 组分支关系\n`)
  console.log('=== 父 → 子 ===')
  for (const p of pairs.sort((a, b) => b.n - a.n)) {
    line(p.parent, '父 ')
    console.log(`   └─ 分叉于 seq ${p.n - 1}（${fmtStamp(p.parent.times[p.n - 1])}）${p.sure ? '' : '  ⚠ 无 inherited 标记，按体量推断'}`)
    line(p.child, '子 ')
    console.log(`      继承 ${p.n} 条 / 自有 ${p.child.count - p.n} 条\n`)
  }
  console.log('提醒：分支继承原名，源会话被改名成「名字 (1)」。侧栏里看起来"换了个会话"，其实你继续用的很可能是带 (1) 的那条。')
}

// ---------------------------------------------------------------- 第三方改写者（复发根源）

// 会话文件是 dsh 的私有存储。任何第三方脚本在 app 运行时整文件重写它，都会造成
// 「首帧不变量被破坏 / 补齐的事件 schema 不合法 / 与 app 抢句柄丢事件」——
// 表现就是「刚修好，过一会儿又白了 / 又不见了」。这里把这些改写者找出来。
const BRIDGE_DIR = process.env.DSH_BRIDGE_DIR || ''

function stripCodeComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

function appMutators() {
  const hits = []
  const read = p => { try { return readFileSync(p, 'utf8') } catch { return null } }

  const scanFile = p => {
    const s = read(p)
    if (!s) return
    const code = stripCodeComments(s)
    if (/nullfix/.test(code)) hits.push({ where: p, what: '代码里仍会调用 nullfix（自动改写会话文件）' })
    if (/session\.v4\.jsonl\.zstd/.test(code)) hits.push({ where: p, what: '代码里直接读写会话文件' })
  }
  if (BRIDGE_DIR) for (const n of ['watcher.mjs', 'auth-proxy.mjs', 'fix-startup.js', 'fix-keyscript.js']) scanFile(join(BRIDGE_DIR, n))

  // 一次性 / 定时任务里残留的修复任务
  try {
    const r = spawnSync('schtasks', ['/query', '/fo', 'CSV', '/nh'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    for (const line of out.split('\n')) {
      if (/SessionFix|nullfix|session-fix/i.test(line)) {
        hits.push({ where: '计划任务', what: line.trim().replace(/^"|"$/g, '').slice(0, 150) })
      }
    }
  } catch { /* 权限/沙箱不允许时静默跳过 */ }

  const nf = BRIDGE_DIR ? read(join(BRIDGE_DIR, 'nullfix.py')) : null
  if (nf && (!/--apply/.test(nf) || !/REFUSED/.test(nf))) {
    hits.push({ where: join(BRIDGE_DIR, 'nullfix.py'), what: '缺护栏：应默认 dry-run，且检测到 app 在跑就拒绝写' })
  }
  return hits
}

function cmdGuards() {
  console.log('=== 第三方改写者体检 ===')
  console.log('会话文件是 dsh 私有存储；第三方在 app 运行时整文件重写，会导致')
  console.log('① 首帧不是单行 → host 静默跳过该会话  ② 补出的事件 schema 不合法 →')
  console.log('③ 与 app 抢句柄 → 之后的追加写丢事件。三者表现都是「修好又坏」。\n')

  const hits = appMutators()
  if (hits.length === 0) {
    console.log('✓ 没有发现自动改写会话文件的脚本或计划任务')
  } else {
    for (const h of hits) console.log(`  ⚠ ${h.where}\n      ${h.what}`)
    console.log('\n处置：把自动调用删掉（watcher 里的 30min sweep 之类），改为')
    console.log('  1) 完全退出 dsh  2) python -I nullfix.py --scan-all --apply')
    console.log('  3) node doctor.mjs status 复检')
  }
  console.log('\n提醒：dsh 自身写出的 turn/end reason:null 用 `doctor.mjs fix` 修，')
  console.log('      那是一次性的离线修复，不需要任何常驻进程。')
}

// ---------------------------------------------------------------- host 视角（权威判定）

/**
 * 为什么需要这一层：
 * 前面所有子命令都是「按 zstd 帧自己解一遍」，和 host 的真实读取是两套实现。
 * 用户说「会话不见了」时，第一个要回答的问题不是「字节对不对」，而是
 * 「dsh 自己认不认这个会话」。这里直接加载 app.asar 里 host 用的那份 persistence
 * 模块（必须用 Electron 跑，普通 node 进不去 asar），得到的就是 host 的答案。
 *
 * 判定链（从下往上，断在哪层就修哪层）：
 *   磁盘文件 → host listArtifacts（首帧不变量/格式）→ 工作区注册表 → 侧栏可见性（置顶/归档/摘要）
 */
function findElectron(asar) {
  const install = dirname(dirname(asar))
  if (platform() === 'win32') {
    for (const n of ['DeepSeek Harness.exe', 'deepseek-harness.exe']) {
      const p = join(install, n)
      if (existsSync(p)) return p
    }
    return null
  }
  if (platform() === 'darwin') {
    const macos = join(install, 'MacOS')
    if (existsSync(macos)) {
      const f = readdirSync(macos)[0]
      if (f) return join(macos, f)
    }
    return null
  }
  for (const n of ['deepseek-harness', 'DeepSeek Harness']) {
    const p = join(install, n)
    if (existsSync(p)) return p
  }
  return null
}

function hostList() {
  const asar = findAsar()
  if (!asar) return { ok: false, error: '未找到 app.asar（可用 DSH_ASAR 指定）' }
  const exe = findElectron(asar)
  if (!exe) return { ok: false, error: '未找到 dsh 可执行文件（和 app.asar 同级的 exe）' }
  const script = join(dirname(fileURLToPath(import.meta.url)), 'hostlist.mjs')
  if (!existsSync(script)) return { ok: false, error: '缺少 hostlist.mjs（应和 doctor.mjs 同目录）' }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_OPTIONS
  const r = spawnSync(exe, [script, '--asar', asar, '--root', SESS_ROOT], {
    env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 180000,
  })
  const out = (r.stdout || '').trim().split('\n').filter(Boolean)
  const line = out.reverse().find(l => l.startsWith('{'))
  if (!line) return { ok: false, error: `host 模块无输出（exit ${r.status}）${(r.stderr || '').slice(0, 300)}` }
  try { return JSON.parse(line) } catch (e) { return { ok: false, error: 'host 输出无法解析: ' + e.message } }
}

function readRegistry() {
  if (!existsSync(REG_PATH)) return null
  let reg
  try { reg = JSON.parse(readFileSync(REG_PATH, 'utf8')) } catch { return null }
  const member = new Map()
  const wsOrder = []
  for (const [wsId, rec] of Object.entries(reg.tables?.workspaces || {})) {
    wsOrder.push({ wsId, title: rec.title || rec.path || wsId, ids: rec.sessionIds || [] })
    for (const sid of rec.sessionIds || []) if (!member.has(sid)) member.set(sid, rec.title || wsId)
  }
  return {
    raw: reg,
    member,
    workspaces: wsOrder,
    pinned: new Set(reg.global?.pinnedSessionIds || []),
    archived: new Set(reg.global?.archivedSessionIds || []),
  }
}

function cmdVerify(showAll, focus) {
  const reg = readRegistry()
  const host = hostList()

  console.log('=== host 视角（dsh 自己认不认这个会话）===')
  if (!host.ok) {
    console.log('✗ ' + host.error)
    console.log('  → 这一步失败通常是安装路径特殊，可用 DSH_ASAR=<app.asar 完整路径> 重试')
    return
  }
  console.log(`✓ 用 dsh 内置 persistence 列出 ${host.count} 个会话`)

  const rows = []
  for (const it of host.items) {
    const sid = String(it.id)
    const cacheFile = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', sid + '.json')
    const base = { sid, size: it.sizeBytes, formatStatus: it.formatStatus, cache: existsSync(cacheFile) }
    if (it.formatStatus !== 'current') rows.push({ ...base, state: 'FORMAT-' + it.formatStatus, note: '格式过旧/需迁移，会话会打不开' })
    else if (reg && !reg.member.has(sid)) rows.push({ ...base, state: 'UNREGISTERED', note: '磁盘有、工作区没登记 → 侧栏看不到，registry 可挂回' })
    else if (reg && reg.archived.has(sid)) rows.push({ ...base, state: 'ARCHIVED', note: '已归档，默认过滤下不显示（侧栏「已归档」里能看到）' })
    else if (reg && reg.pinned.has(sid)) rows.push({ ...base, state: 'PINNED', note: '已置顶，固定在侧栏顶部' })
    else rows.push({ ...base, state: 'VISIBLE', note: reg ? (reg.member.get(sid) || '') : '' })
  }

  // host 里没有、但磁盘上有的会话：这一层才是真正「dsh 发现不了」
  const hostIds = new Set(host.items.map(i => String(i.id)))
  for (const r of listSessions()) {
    if (hostIds.has(r.sid)) continue
    const cacheFile = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', r.sid + '.json')
    rows.push({ sid: r.sid, size: r.size, formatStatus: '?', cache: existsSync(cacheFile), state: 'HOST-MISSING', note: '磁盘上有，但 host 列不出来 → 首帧不变量/解码问题，先 frames' })
  }

  const order = { 'HOST-MISSING': 0, FORMAT: 1, UNREGISTERED: 2, ARCHIVED: 3, PINNED: 4, VISIBLE: 5 }
  const rank = s => (s.startsWith('FORMAT') ? order.FORMAT : (order[s] ?? 9))
  rows.sort((a, b) => rank(a.state) - rank(b.state))

  const summary = {}
  for (const r of rows) summary[r.state] = (summary[r.state] || 0) + 1
  console.log('\n=== 逐条判定 ===')

  if (focus) {
    const hit = rows.filter(r => r.sid.includes(focus))
    if (hit.length === 0) console.log(`  ✗ 没有匹配 "${focus}" 的会话`)
    for (const r of hit) {
      const kb = r.size ? Math.round(r.size / 1024) + 'KB' : '?'
      console.log(`  ${r.state.padEnd(13)} ${r.sid}  ${kb}  ${r.cache ? 'cache✓' : 'cache✗'}  ${r.note}`)
    }
    console.log('\n=== 结论 ===')
    for (const r of hit) {
      const verdict = {
        'HOST-MISSING': 'dsh 发现不了这个会话（数据层）→ node doctor.mjs frames --apply',
        UNREGISTERED: 'dsh 能读到，但工作区没登记 → node doctor.mjs registry',
        ARCHIVED: '被归档了，默认过滤不显示 → 侧栏切「已归档」取消归档',
        PINNED: '已置顶且状态正常 → 它一定在侧栏顶部；若仍看不到，是渲染层',
        VISIBLE: '数据在、host 认、注册表有、未归档 → 若侧栏仍看不到，是 UI 列表层（不是数据丢失）',
      }[r.state] || ('格式状态 ' + r.state + ' → 需要迁移/会打不开')
      console.log(`  ${r.sid.slice(0, 20)}…  ${verdict}`)
    }
    return
  }

  const unreg = rows.filter(r => r.state === 'UNREGISTERED')
  const shown = showAll
    ? rows
    : rows.filter(r => r.state !== 'VISIBLE' && r.state !== 'UNREGISTERED')
  for (const r of shown) {
    const kb = r.size ? Math.round(r.size / 1024) + 'KB' : '?'
    console.log(`  ${r.state.padEnd(13)} ${r.sid.slice(0, 42).padEnd(44)} ${kb.padStart(8)}  ${r.cache ? 'cache✓' : 'cache✗'}  ${r.note}`)
  }
  if (!showAll) {
    // 老格式 flat 会话（没有 session- 前缀）通常不属于任何工作区，逐条打印只会淹没有效信息
    for (const r of unreg.slice(0, 5)) {
      const kb = r.size ? Math.round(r.size / 1024) + 'KB' : '?'
      console.log(`  ${r.state.padEnd(13)} ${r.sid.slice(0, 42).padEnd(44)} ${kb.padStart(8)}  ${r.cache ? 'cache✓' : 'cache✗'}  ${r.note}`)
    }
    if (unreg.length > 5) console.log(`  UNREGISTERED  其余 ${unreg.length - 5} 个略（--all 看全部）`)
    if (shown.length === 0 && unreg.length === 0) console.log('  （全部为 VISIBLE，无异常）')
  }

  console.log('\n=== 汇总 ===')
  console.log('  ' + Object.entries(summary).map(([k, v]) => `${k} ${v}`).join('  |  '))
  console.log('\n判定含义：')
  console.log('  HOST-MISSING = dsh 真的发现不了 → 数据层，先 frames --apply')
  console.log('  UNREGISTERED = dsh 能发现，但工作区没挂 → 侧栏看不到 → registry')
  console.log('  ARCHIVED     = 归档了，默认过滤隐藏 → 侧栏「已归档」或取消归档')
  console.log('  VISIBLE      = 数据在、host 认、注册表有 → 侧栏仍看不到就是 UI 列表层，见 SKILL.md「侧栏不显示」一节')
  console.log('  cache✗      = 该会话没有标题投影缓存，冷启动时标题/摘要可能渲染不出来 → 打开一次即可重建')
  if (rows.some(r => r.state === 'VISIBLE' && !r.cache)) {
    const first = rows.find(r => r.state === 'VISIBLE' && !r.cache)
    console.log(`\n提示：${first.sid.slice(0, 24)} 属于「数据全对但没有投影缓存」，可先退出应用后 pin 它，再重开看是否出现：`)
    console.log(`  node doctor.mjs pin ${first.sid.slice(0, 8)} --apply`)
  }
}

function cmdPin(prefix, on, apply) {
  if (!prefix) { console.log('用法: node doctor.mjs pin <会话id前缀> [--unpin] [--apply]'); return }
  const { row, err, rows } = findSessionByPrefix(prefix)
  if (err) { console.log('✗ ' + err); if (rows) for (const r of rows) console.log('  ' + r.sid); return }
  if (!existsSync(REG_PATH)) { console.log('找不到 workspace.json'); return }
  const reg = JSON.parse(readFileSync(REG_PATH, 'utf8'))
  reg.global = reg.global || {}
  const cur = reg.global.pinnedSessionIds || []
  const has = cur.includes(row.sid)
  console.log(`会话   ${row.sid}`)
  console.log(`当前   ${has ? '已置顶' : '未置顶'}（置顶共 ${cur.length} 个）`)
  if (on ? has : !has) { console.log('已经是目标状态，无需改动'); return }
  console.log(`目标   ${on ? '置顶（固定显示在侧栏顶部）' : '取消置顶'}`)
  if (!apply) { console.log('\n[dry] 未写入。加 --apply 生效（需先退出应用）。'); return }
  const running = appRunning()
  if (running > 0) { console.log(`\n✗ 检测到 ${running} 个进程在运行，请先完全退出（含托盘），否则改动会被内存状态覆盖。`); return }
  reg.global.pinnedSessionIds = on ? [row.sid, ...cur] : cur.filter(x => x !== row.sid)
  const bak = `${REG_PATH}.bak-pin-${STAMP}`
  copyFileSync(REG_PATH, bak)
  const tmp = `${REG_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8')
  JSON.parse(readFileSync(tmp, 'utf8'))
  renameSync(tmp, REG_PATH)
  console.log(`\n✓ ${on ? '已置顶' : '已取消置顶'}，备份 ${basename(bak)}`)
  console.log('  重新打开应用即可。置顶是纯注册表状态，不碰会话文件。')
}

// ---------------------------------------------------------------- 入口

const argv = process.argv.slice(2)
const cmd = argv[0]
switch (cmd) {
  case 'status': cmdStatus(); break
  case 'scan': cmdScan(); break
  case 'fix': cmdFix(); break
  case 'registry': cmdRegistry(!argv.includes('--dry')); break
  case 'all': cmdFix(); console.log(''); cmdRegistry(true); break
  case 'patch': cmdPatch(argv.includes('--apply')); break
  case 'reasonguard': cmdReasonGuard(argv.includes('--apply')); break
  case 'restore-asar': cmdRestoreAsar(); break
  case 'logs': cmdLogs(); break
  case 'goals': cmdGoals(); break
  case 'rename': cmdRename(argv[1], argv[2], argv.includes('--apply')); break
  case 'restore-title': cmdRestoreTitle(argv[1]); break
  case 'frames': cmdFrames(argv.includes('--apply')); break
  case 'endcheck': cmdEndcheck(argv.includes('--apply')); break
  case 'lineage': cmdLineage(argv.slice(1).find(a => !a.startsWith('--'))); break
  case 'guards': cmdGuards(); break
  case 'verify': cmdVerify(argv.includes('--all'), argv.slice(1).find(a => !a.startsWith('--'))); break
  case 'pin': cmdPin(argv[1], !argv.includes('--unpin'), argv.includes('--apply')); break
  case 'restore': cmdRestore(argv[1]); break
  default:
    console.log(`dsh-session-triage

先跑 status 看全局，再按提示补哪一层。

  node doctor.mjs status              总览（会话/注册表/补丁/日志）
  node doctor.mjs scan                只体检
  node doctor.mjs fix                 修复非法 turn/end reason
  node doctor.mjs registry [--dry]    补登漏掉的会话
  node doctor.mjs all                 数据层 + 注册表层
  node doctor.mjs patch [--apply]     客户端空值防护（默认 dry-run）
  node doctor.mjs reasonguard [--apply] reason:null 防复发三补丁（写入端/投影端/目标循环）
  node doctor.mjs goals               盘点所有会话的目标（目标"消失"时先跑这个）
  node doctor.mjs frames [--apply]    检查首帧不变量（会话在列表里消失/打不开时先跑这个）
  node doctor.mjs endcheck [--apply]  "历史加载失败 / reading 'code'"：修畸形 turn/end（缺 error.code）
  node doctor.mjs lineage [<id前缀>]  查分支（fork）关系："我分支过吗""历史怎么少了"先跑这个
  node doctor.mjs verify [--all]      host 视角判定：dsh 到底认不认这个会话（最权威）
  node doctor.mjs guards              找「自动改写会话文件」的脚本/计划任务（修好又坏的复发根源）
  node doctor.mjs pin <id前缀> [--unpin] [--apply]     置顶/取消置顶（侧栏不显示的兜底手段）
  node doctor.mjs rename <id前缀> "新标题" [--apply]   原地改名（追加 session/title 事件）
  node doctor.mjs restore-title <id前缀>               撤销改名
  node doctor.mjs logs                查崩溃日志里的 kind 报错
  node doctor.mjs restore <file>      还原单个会话文件
  node doctor.mjs restore-asar        还原客户端

DSH_HOME = ${DSH_HOME}
app.asar = ${findAsar() || '(未找到，可用 DSH_ASAR 指定)'}`)
}
