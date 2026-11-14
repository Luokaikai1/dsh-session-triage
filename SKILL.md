---
name: dsh-session-triage
description: 诊断并修复 DeepSeek Harness（dsh）会话「突然全白 / 一片空白 / 白屏」、「历史加载失败 failed to project session … reading 'code'」、侧栏会话消失或不显示、历史记录打不开、会话文件损坏（session.v4.jsonl.zstd）、审批取消后对话区空白等问题；并可给客户端打空值防护补丁预防复发。内置 host 视角判定（verify）、两类 turn/end 损坏修复（fix / endcheck）与会话分支血缘分析（lineage），能区分「数据丢了」「dsh 发现不了」「注册表漏登记」「UI 没渲染」「其实你分支过」。触发词：dsh 全白、会话白了、会话空白、白屏、历史加载失败、failed to project session、reading 'code'、reading 'kind'、对话不见了、会话消失、侧栏不显示、会话找不到了、记录丢了、历史变少了、我是不是分支了、fork、分支会话、DeepSeek Harness 打不开会话、turn/end reason null、session.v4.jsonl.zstd 损坏。
agent_created: true
---

# DSH 会话白屏诊断与修复

> **独立编写声明**：本技能与 npm 包 / GitHub 仓库 `dsh-session-doctor`（作者 imtokenxinluo）**没有隶属关系**，也不是它的二创。两者解决的问题相邻，但载体不同：
> - 那个插件是**常驻库**：写时哨兵（watch）、无损修复（repair）、事故归因（blame）。
> - 本技能是**操作手册 + 命令行脚本**：先判层（数据 / 注册表 / 首帧 / 客户端 / UI），再动手，并附客户端防复发补丁。
> 二者可同时使用，互不冲突。

## 这个技能处理什么

DeepSeek Harness（下称 dsh）的对话区**整块变白**，通常不是数据全丢，而是三层问题叠加：

| 层 | 现象 | 本质 |
|---|---|---|
| 客户端 | 对话区白屏，侧栏和输入框正常，重启能好一会儿又白 | 渲染层抛 `TypeError: Cannot read properties of null (reading 'kind')`，React 错误边界把整块区域渲染成空 div |
| 数据 | 某个会话点开必白，或报「历史加载失败 … reading 'kind'（gateway/internal）」 | `turn/end` 事件的 `data.reason` 被写成 `null`（dsh 自己写：审批取消 / 空响应路径，详见「第三类」）；读取端未防护时客户端与投影层都会崩 |
| 数据（投影） | 打开会话报「历史加载失败 … reading 'code'」 | `turn/end` 写成 `{kind:"error"}` 却没有 `error.code`（外部桥接救援脚本补的收尾事件），continuation 投影崩 |
| 注册表 | 侧栏只剩更早的会话，今天的不见了 | 会话打不开后，`workspace.json` 把该 id 从 `sessionIds` 里漏掉 |
| 分帧 | 注册表里有、侧栏就是不显示 | 首帧不变量被破坏（整份日志被重压成一帧），host 静默跳过该会话 |
| UI 列表 | `verify` 说 VISIBLE，侧栏仍然没有 | 渲染层按 summary / 归档 / 折叠过滤，数据一个字节都没丢 |

前四层都能用 `verify` 一次性定位；先判层，再动手，别从「翻备份」开始。

**核心判断**：`reading 'kind'` 有两个崩溃面，按报错包装区分——①**客户端渲染层**裸读 `reason.kind`（崩进 crash-renderer 日志，白屏）；②**host 投影层** `dsh-api-session-controller` continuation 投影裸读 `event.data.reason.kind`（报「历史加载失败：failed to project session … Cannot read properties of null (reading 'kind')（gateway/internal）」，历史打不开）。两者同根：`turn/end` 的 reason 被写成 null。数据、客户端、host 三层都要防护（`fix`/`endcheck` + `patch` + `reasonguard`），只修一层必然复发。

## 工作流程

### 第 1 步：总览（必做，一条命令看清四层）

```bash
node "<skill-dir>/scripts/doctor.mjs" status
```

输出四段：环境 / 数据层 / 注册表层 / 客户端层 / 崩溃日志。按下面这张表决定动作：

| status 输出 | 含义 | 动作 |
|---|---|---|
| 数据层「问题会话 N」 | 有非法 `turn/end reason` | 第 2 步 `fix` |
| **投影层「畸形 turn/end N 条」** | **打开会话报「历史加载失败 …」：reading 'code'（缺 error.code）或 reading 'kind'（reason:null）** | **`endcheck --apply`** |
| **首帧不变量「违规 N」** | **会话在列表里消失、点开打不开** | **`frames --apply`（见下节）** |
| 注册表层「未登记的 N 个」 | 会话在磁盘但侧栏看不到 | 第 3 步 `registry` |
| 客户端层「裸读 .kind N 处」 | 客户端 bug 仍在 | 第 4 步 `patch --apply` |
| 崩溃日志「kind 报错 N 次」 | 佐证上述判断 | 结合上面三层一起处理 |
| **第三方改写者「⚠ N 处」** | **修好又坏、隔一阵又犯** | **`guards`，先掐掉自动改写源（见下节）** |
| 全部为 0 / 已生效 | 已健康 | 无需动作 |

**优先级**：先看首帧不变量。它不为 0 时，那个会话对 host 来说「不存在」，后面几层怎么修都不会显示出来。

### 第 0 步：如果是「修好又坏了 / 一天之内反复」

不要重复修数据，先抓谁在改文件：

```bash
node "<skill-dir>/scripts/doctor.mjs" guards
```

会话文件是 dsh 的私有存储，**任何第三方脚本在 app 运行时整文件重写它都会造成三种损坏**：

1. 整个文件被压成 1 帧 → 首帧塞了几千行 → 违反 `assertZstdHeaderFrame` → host 静默跳过该会话（侧栏消失）
2. 补出来的 `turn/end` 缺 `error` 对象 → 投影抛 `reading 'code'` → 历史加载失败
3. 与正在写入的 app 抢同一个句柄 → 替换后 app 的追加落到旧 inode → 静默丢事件

典型来源（本机实测过）：`~/.zcode/bridge/watcher.mjs` 里每 30 分钟跑一次的 `nullfix.py --scan-all` 自愈逻辑，以及计划任务里残留的 `DSH-SessionFix-*`。处置：

- 把自动调用删掉（脚本里的 sweep 段整段注释掉并写明原因）
- 手工修：**先完全退出 dsh**，再 `python -I nullfix.py --scan-all --apply`（默认 dry-run，检测到 app 在跑会直接拒绝）
- 计划任务残留：`Unregister-ScheduledTask -TaskName 'DSH-SessionFix-…' -Confirm:$false`

**判据**：`status` 里第三方改写者一栏必须是 0；否则修一次坏一次，永远修不完。

### 第 1.5 步：用户点名某个会话「还是不显示」时，先判它是哪一层断的

```bash
node "<skill-dir>/scripts/doctor.mjs" verify <id前缀>     # 只判这一个会话
node "<skill-dir>/scripts/doctor.mjs" verify              # 只看异常的
node "<skill-dir>/scripts/doctor.mjs" verify --all        # 全量
```

`verify` 会**加载 app.asar 里 host 自己用的那份 persistence 模块**（借 Electron 的 asar 支持，普通 node 进不去），所以它的结论就是 dsh 的结论，不是第二套猜测实现。一次给出五个状态之一：

| 状态 | 含义 | 下一步 |
|---|---|---|
| `HOST-MISSING` | 磁盘有、host 列不出来 | 数据层：`frames --apply` |
| `FORMAT-*` | 格式过旧/待迁移 | 会话会打不开，按 dsh 提示迁移 |
| `UNREGISTERED` | host 能读到、工作区没挂 | `registry` |
| `ARCHIVED` | 被归档，默认过滤隐藏 | 侧栏切「已归档」或取消归档 |
| `VISIBLE` | 数据在、host 认、注册表有、未归档 | **UI 列表层问题，不是数据丢失**（见下节） |

**这一步能立刻停止误判**。用户说「会话没了」时，最容易被带偏的方向是翻备份、重建会话；而 `VISIBLE` 说明一个字节都没丢、dsh 也完全认它，问题只在侧栏渲染。

### 第 2 步：修数据层

**先确认应用已退出**（`tasklist | grep -i deepseek` 无输出）。应用运行时改会话文件会被内存状态覆盖回去。

```bash
node "<skill-dir>/scripts/doctor.mjs" fix
```

脚本按 zstd 帧逐帧解压，只重写含坏事件的那一帧，其余帧原始字节不动；写入前做全量校验（仍有非法 reason 就放弃写入），并生成 `*.bak-reasonfix-<时间戳>` 备份。

### 第 3 步：修注册表层

```bash
node "<skill-dir>/scripts/doctor.mjs" registry --dry   # 先看要补谁
node "<skill-dir>/scripts/doctor.mjs" registry         # 再落盘
```

按文件 mtime 插入到正确位置（列表是新的在前），自动跳过已归档会话，备份为 `workspace.json.bak-doctor-<时间戳>`。

注意：`onebot-*` 会话（QQ 群/私聊桥接）常出现「磁盘有、注册表无」，因为应用关闭瞬间正在写入的会话来不及登记 —— 这是真实遗漏，补上是对的。

### 第 4 步：打客户端防护（治本）

```bash
node "<skill-dir>/scripts/doctor.mjs" patch           # dry-run，看命中几处
node "<skill-dir>/scripts/doctor.mjs" patch --apply   # 落盘（需先退出应用）
```

做的事：把 `dsh-client-ui-chat` 里 9 处 `.kind` 裸读改成 `?.kind`。

- 脚本自动探测 `app.asar` 路径（Windows / macOS / Linux 常见安装位置）；找不到时用 `DSH_ASAR=<完整路径>` 指定
- asar 头部写死了文件长度，脚本会**等长原地改写**，长度或语法校验不过直接中止，不会写出损坏的 asar
  - 腾出新增字节有两条路：先在块注释里裁；生产包没有块注释时，改从文件末尾 `//# sourceMappingURL=…` 这类行注释里裁（注释内容不参与语义，截短安全）
  - 两条都找不到就报 `找不到可裁剪的注释` 并中止 —— 这是**正常的拒绝**，不是脚本坏了：说明这个版本被压缩过，需要人工确认后再改
- 幂等：已打过补丁会提示「无需重复」
- 首次写入前备份为 `app.asar.bak-reasonfix`

### 第 5 步：重启并验证

**必须从开始菜单/桌面图标启动**。从命令行启动时若环境里有 `NODE_OPTIONS`，Electron 会继承它而直接退出：

```bash
env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE cmd //c start "" "C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
```

启动后再跑一次 `status`，确认「裸读 .kind 0 处」「未登记 0 个」。

## 常用补充命令

```bash
node doctor.mjs verify <id前缀>   # host 视角判定单个会话：不显示到底断在哪层（最权威）
node doctor.mjs verify --all      # 全量判定（含 UNREGISTERED / ARCHIVED 明细）
node doctor.mjs guards            # 抓自动改写会话文件的脚本/计划任务（"修好又坏"必跑）
node doctor.mjs pin <id前缀> --apply   # 把会话置顶到侧栏固定区（UI 层不显示时的兜底）
node doctor.mjs endcheck [--apply]  # "历史加载失败 / reading 'code' / reading 'kind'"：修畸形 turn/end
node doctor.mjs reasonguard [--apply]  # reason:null 防复发三补丁（写入端/投影端/目标循环）
node doctor.mjs lineage [<id前缀>]  # 查分支（fork）："我是不是分支了""历史怎么变少了"先跑这个
node doctor.mjs scan              # 只体检全部会话是否还有坏帧
node doctor.mjs goals             # 盘点所有会话的目标（"目标没了"先跑这个）
node doctor.mjs frames            # 检查首帧不变量（"列表里没有/打不开"先跑这个）
node doctor.mjs all               # 数据层 + 注册表层一次做完
node doctor.mjs logs              # 只查崩溃日志里的 kind 报错
node doctor.mjs restore <file>    # 从 .bak-reasonfix-* 还原单个会话文件
node doctor.mjs restore-asar      # 客户端回滚到官方原始字节
```

## 会话在列表里消失、点开打不开：首帧不变量（最容易误判的一类）

**症状**：工作区注册表里明明有这个会话，标题也在，但侧栏就是不显示；或者显示了下但点进去空白。同时磁盘上的数据一条不少，`goals`／`scan` 也都正常。

**根因**：host 的 `readFirstZstdLine` 里有一句断言——

```js
/** Assert that the independently decodable first frame contains only the header record. */
if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1)
  throw new Error("corrupt Zstandard session log: first frame is not exactly one header line");
```

**第一个 zstd 帧必须只装会话头那一行**。不满足就抛 `SessionPersistenceCorruptionError`，而 `listArtifacts` 捕获后返回 `metadata: undefined` 并 `continue` —— 会话被**静默跳过**：不进列表、没有 summary、打不开，但一个字节都没丢。

**谁会造成**：任何「把整份日志重压成一帧」的脚本。历史上有过一次「nullfix」，把 1629 个小帧合并成 1 帧，正文 20MB 全塞进第一帧，从此这两个会话在界面上消失（数据完好）。诊断时容易只看 `seq` 连续、解码正常就判「数据没问题」，从而完全走错方向。

**判定与修复**：

```bash
node "<skill-dir>/scripts/doctor.mjs" frames            # 全库检查，列出违规会话与原因
node "<skill-dir>/scripts/doctor.mjs" frames --apply    # 原地重排（需先退出应用）
```

修复只改压缩分帧：首帧单独装会话头一行，其余按 ~1MB 按行边界切块。**明文内容零改动**，脚本写入前会把新文件回读解压、与原明文逐字节比对，不一致就放弃写入；备份为 `*.bak-reframe-<时间戳>`。

文件会变大（分块多、压缩率略降），属正常。

## 历史加载失败：`failed to project session … reading 'code'`（第二类数据损坏）

**症状**（对话区直接报，不是白屏）：

```
历史加载失败：failed to project session "session-xxxxxxxx-…": Cannot read properties of undefined (reading 'code')（gateway/internal）
```

**根因**：`turn/end` 事件的 `reason` 写成

```json
{ "kind": "error", "message": "turn aborted (upstream rate limited, repaired by bridge tooling)" }
```

少了 schema 要求的 `error` 对象。dsh 的 continuation 投影里有这一行（`dsh-api-session-controller`）：

```js
const ending = event.data.reason.kind === "error"
  && CONTINUABLE_FAILURES.has(event.data.reason.error.code)   // ← error 不存在，undefined.code
  && state.admitted && state.failedAttempt ? event.seq : null;
```

抛 TypeError → `preparedProjections` 失败 → `failed to project session` → 整个会话的历史加载不出来。**一个会话只要有一条这种事件，整份历史就打不开**（投影是对全量事件 fold 的）。

**谁写的**：不是 dsh 自己。`message` 里的 `repaired by bridge tooling` 是外部「桥接救援脚本」在遇到限流（429 / user concurrency limit exceeded）后补的收尾事件，它只写了人读的 message，没写机器要的 `code`。

**和 `reason: null` 的区别**：那个报 `reading 'kind'`，这个报 `reading 'code'`；那个是 dsh 自己在审批取消时写的，这个是外部工具写的。两者都属于「turn/end 结构不合 schema」。

**判定与修复**：

```bash
node "<skill-dir>/scripts/doctor.mjs" endcheck            # 全库扫描，列出会话与 seq
node "<skill-dir>/scripts/doctor.mjs" endcheck --apply    # 需先完全退出应用
```

修复只做一件事：给这些 `turn/end` 补出 `error: { message, code }`，`message` 原文保留，`code` 按内容推断（限流 → `RATE_LIMIT`，超时 → `TIMEOUT`，连接断 → `TRANSPORT`，认不出 → `UNKNOWN`）。语义不变——限流仍然记录为限流。

保护：只重写含坏事件的帧，其余帧原始字节不动；写入前校验「行数不变、除目标行外逐行一致」；备份 `*.bak-endfix-<时间戳>`。

`UNKNOWN` 不在 `CONTINUABLE_FAILURES` 里，所以认不出的失败不会被误判成「可继续」。若想让它显示成可续跑，把 code 改成上面集合里的值即可（`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` / `STREAM_CLOSED`）。

**排查提示**：这类会话往往同时命中「侧栏不显示」——因为投影失败会让它的列表摘要也构建不出来。修完 `endcheck` 再看 `verify`，很多「消失」会一起恢复。

## 运行中突然 `历史加载失败`：dsh 自己写 `reason: null`（第三类，可根治在写入端）

**症状**：会话正用着，突然报「历史加载失败：failed to project session "session-…": Cannot read properties of null (reading 'kind')（gateway/internal）」（2026-11-14 两个会话实测）。用 `endcheck` 扫，坏事件的 `reason` 是 **`null`**（不是缺 `error` 的 error 对象），而且时间戳就是刚刚。投影报错按坏形状分两种：reason 为 null → `reading 'kind'`；缺 error.code → `reading 'code'`。

**与第二类的区别**（别混）：

| | 谁写的 | 坏成什么样 | 时间特征 |
|---|---|---|---|
| 第二类 | 外部桥接救援脚本 | `{kind:"error", message:"…"}`，缺 `error.code` | 集中在上游限流那阵 |
| 第三类 | **dsh 自己**（agent-loop） | `{turn:N, reason:null}` | 边用边冒出来 |

**根因**（`@deepseek-ai/dsh-agent-loop/lib/index.js` 的 `ReactLoopAgent.turn()`）：

```js
let turnEnds = null;
...
finally { this.session.append("turn/end", { turn, reason: turnEnds }); }  // root 仍是 null
```

正常路径 `turnEnds` 会被 `step()` 的返回值（`completed` / `max-tokens` / `aborted` / `error`）覆盖。但当某一步的上游返回**空响应**时会走到一条不赋值就退出的路径：

```
assistant/attempt { turn:39, step:24, stream: [] }   ← 空流，没有内容也没有工具调用
step/end
turn/end { turn:39, reason:null }                    ← 初始值原样落盘
```

一条 null 就够让整份历史打不开（投影读 `reason.error.code`）。

**为什么「目标循环 / goal round」用户最容易撞**：goal 驱动每轮结束会 splice `<goal_round>` 并立刻开下一轮，轮次极多（实测单会话 31–86 轮），空响应概率被放大。实测约 1/50 轮会中一次——**不是目标循环设计有问题，是空响应那条路径没赋默认值**。判断依据：坏事件前一条必是 `assistant/attempt` 且 `stream: []`。

**根治（三处等长补丁，写入端 + 两个读取端）**：

```bash
node "<skill-dir>/scripts/reasonguard.mjs"           # 先 dry-run 看长度与语法
node "<skill-dir>/scripts/reasonguard.mjs" --apply   # 需先完全退出应用
node "<skill-dir>/scripts/doctor.mjs" reasonguard --apply   # 等价入口
```

| 目标 | 改动 | 效果 |
|---|---|---|
| `dsh-agent-loop` | `reason: turnEnds` → `reason: turnEnds ?? { kind: "completed" }` | **不再写 null** |
| `dsh-api-session-controller` | `event.data.reason?.kind` / `?.error?.code` | 历史里有 null 也能打开 |
| `dsh-goal-round-driver` | `event.data.reason?.kind` / `?.reason?.kind` | goal 监听器不抛错 |

- 等长原地改写（多余字节从同文件注释里裁），写前 `node --check`，长度或语法不过就中止
- 幂等：重跑显示「改动 0 类」；备份 `app.asar.bak-reasonguard-<时间戳>`
- **dsh 每次升级必重打**（installer 会整体替换 `resources`），`status` 的「写入端」一行能看出 3/3 还是失效

**顺序很重要**：先退出应用 → 打补丁 / 修数据 → 重开。目标循环还在跑时，不修写入端就只修数据，几分钟后会重新中招。

## 「我好像分支过 / 历史怎么变少了」：先分清是分支还是真丢

```bash
node doctor.mjs lineage            # 全库找分支关系
node doctor.mjs lineage 7b798201   # 盯住某一条，看它的父/子
```

**dsh 的「分支」不是给原会话挂标签，而是新建一个普通会话**：把源会话 `seq 0..boundary` 的事件原样复制过去，再在源会话尾部追加一条 `session/end-seed {inherited:true}` 标出切点（`dsh-session/lib/types/fork.js` 的 `buildForkSeed`）。

有三个反直觉点，正好对上用户的原话：

| 现象 | 真相 |
|---|---|
| 「我怎么会突然换个会话」 | 你没换。**分支继承了原名，源会话被自动改名成「名字 (1)」**（实测：fork 后源会话立刻多一条 `session/title {source:{kind:"user"}}`）。侧栏里看起来多了一条"同名"会话 |
| 「历史怎么少了」 | 分支只复制**分叉点之前**的事。之后你继续用的那条在涨，分支那条停在分叉时刻的量（实测 371 条 vs 继续涨到 4736 条） |
| 「这条会话本来更长的」 | 你以为的"原会话"其实是被改名的那条。看 `(1)` 后缀就知道谁才是源 |

判定不依赖索引：两会话共享一段逐事件完全相同的长前缀（`type + time + data 长度` 全等），且源会话在切点后有一条 `inherited` 的 end-seed，就是父子。

**索引偏移坑**：明文第 0 行是会话头（没有 `seq`），所以「行索引 = seq + 1」，判定切点时要 `seeds.includes(n)` 而不是 `n-1`。

分支是纯正常行为，**不要修**。真正"历史少了"要走 `goals` / `endcheck` / `frames` 三条。

## 侧栏不显示，但 verify 说是 VISIBLE：UI 列表层

这是最容易「修错方向」的一类。`verify` 判 `VISIBLE` 意味着：文件能完整解码、host 的 `listArtifacts` 认它、`formatStatus: current`、工作区 `sessionIds` 里有它、没归档、标题投影缓存也在。此时**不要动数据**，问题在渲染层。

侧栏到底怎么决定「显示哪几行」（源码级，实测 `dsh-client-ui-workspace/lib/client.js`）：

1. 渲染层先拿一份 host 的 `session.list` 快照，投影成 `list.byId`（每个会话的 summary：`displayTitle / blank / updatedAt / origin / retainedBy`）
2. 分组时逐个 `workspace.sessionIds` 取值，**`list.byId[id] === undefined` 就 `continue`** —— 第一个静默丢弃点，没有日志
3. 再经 `sessionVisible(summary, current, archived, archivedFilter)`：`origin === 'subagent'` 丢弃；`blank` 且不是当前选中会话丢弃；`archivedFilter` 为 `default` 时归档会话丢弃
4. `orderByRecency` / 置顶区同样要求 summary 存在（`summaries[id] === void 0` 直接跳过）

所以「数据全对、侧栏没有」只剩三种可能：

| 可能 | 怎么确认 | 处理 |
|---|---|---|
| 被 `sessionVisible` 过滤（归档 / subagent / blank） | `verify` 报 `ARCHIVED`；或它是 subagent 子会话 | 取消归档；子会话本来就不单独列出 |
| 侧栏用的是旧快照（会话在启动后才登记/改名） | 重启应用后自己出现 | 重启；或按下一条强制刷新位置 |
| summary 缺失（会话从未被打开过，冷会话投影没建立） | `verify` 里 `cache✗`，或侧栏搜索都搜不到标题 | 见下面兜底手段 |

**兜底手段（代价从低到高，都不碰会话文件）**：

```bash
node "<skill-dir>/scripts/doctor.mjs" pin <id前缀>              # dry-run
node "<skill-dir>/scripts/doctor.mjs" pin <id前缀> --apply      # 需先完全退出应用
node "<skill-dir>/scripts/doctor.mjs" pin <id前缀> --unpin --apply
```

`pin` 只改 `workspace.json` 的 `global.pinnedSessionIds`，让会话进侧栏**顶部固定区**——固定区走的是另一条渲染路径，能绕开按时间分组的折叠逻辑。写前备份 `workspace.json.bak-pin-<时间戳>`，幂等。

按有效性排序的经验：
1. **在侧栏搜标题**。能搜到 → 说明 summary 在，只是分组/折叠没显示出来，pin 一下即可。
2. **打开一次该会话**（命令面板 / 搜索结果里点进去）。冷会话的投影缓存会在打开时重建，返回侧栏通常就有了。
3. **pin**。前两条无效时用它，重启后一定出现在顶部。
4. 仍然没有 → 才回到数据层重新 `verify --all`，看是不是 `formatStatus` 变了。

**不要去「重建会话」**。这一层的所有问题都不涉及内容丢失，重建反而会丢上下文。

## 会话标题认不出来：原地改名（不重建）

dsh 的标题就是**一条事件**：`session/title {title, messageSeqs:[], source:{kind:"user"}}`，投影规则是「最后一条生效」（`dsh-session-title` 的 `titleProjectionDefinition.apply`）。所以改名 = 往会话文件追加一条同 schema 事件，历史事件一条不动。

```bash
node "<skill-dir>/scripts/doctor.mjs" rename <id前缀> "新标题"            # dry-run
node "<skill-dir>/scripts/doctor.mjs" rename <id前缀> "新标题" --apply    # 写入
node "<skill-dir>/scripts/doctor.mjs" restore-title <id前缀>              # 撤销改名
```

脚本做的事与保护：

- 先用 `tasklist` 检查应用是否在跑，**在跑就拒绝写入**（否则被内存状态覆盖）
- 改前备份 `*.bak-rename-<时间戳>`
- 以 `maxSeq + 1` 追加，追加后重新解码校验「末条就是我们写的事件、事件数 +1」
- 同时同步投影缓存 `storages/session_projcache/sessions/<id>.json` 的 `rows.title`，否则侧栏要等打开会话才刷新
- 幂等：标题已是目标值就只同步缓存，不重复追加事件

安全性：这是纯追加，不重写任何既有事件；`seq` 连续性和原有内容都能事后复核（`scan` 会一并检查坏帧）。**比重建会话安全得多**，优先用它。

标题长度别超过 60 字符（dsh 侧有 `maxTitleBytes` 字节上限，中文按 UTF-8 三字节算）。

## 「目标没了 / 早上的会话不见了」怎么判

用户说目标消失、某天的会话消失时，**先证明数据在不在，再解释为什么看不见**。`goals` 从每个会话的 `goal/change` 事件重建目标清单（objective、phase、轮次、最后推进时间）。

三种常见误判：

1. **会话标题是旧的**。dsh 只在会话开始时生成一次 `session/title`（多为首条提问，甚至 `source.kind = "fallback"`）。跨天延续的长会话，侧栏会一直显示几天前的标题，用户认不出来就以为「会话没了」——实际该会话的新内容都在里面。
2. **目标轮的 prompt 为空**。goal 自动推进的轮次没有用户输入，`turnOutline` 里这些轮的 `prompt` 是空字符串。点进去只看到助手输出、看不到自己说过什么，很容易判断成「历史没了」。
3. **目标停止推进 ≠ 目标丢失**。目标轮次由应用在会话打开时驱动，应用没运行就不走。`goals` 会提示「active 但已 N 小时没推进」。

判定为「数据还在、只是认不出来」时，引导用户在侧栏重命名该会话（或追加一条 `session/title` 事件），不要重建会话。判定为「磁盘上确实没有该目标」时，才去查注册表遗漏、会话删除、回收站。

Windows 用户可双击 `scripts/run-doctor.cmd`，菜单式操作。

## 必须提醒用户的几条事实

0. **先 `verify` 再动手**。`verify <id前缀>` 一条命令就能判定「数据丢了 / dsh 发现不了 / 注册表漏登记 / 归档 / 纯 UI 层」。跳过这一步最容易做的事就是去翻备份、重建会话——而绝大多数情况一个字节都没丢。
0.5 **"修好又坏"= 有第三方在改文件，不是修得不对**。判据：刚修完 `status` 全绿，过一阵（尤其每 30 分钟这种整点）又白/又不见。先跑 `guards`。实测就是`~/.zcode/bridge/watcher.mjs` 的 nullfix sweep + 一个残留的 `DSH-SessionFix-*` 计划任务。**不掐掉它，修 100 次也没用**。
1. **客户端补丁会被升级覆盖**。应用一升级，`app.asar` 被整体替换，补丁失效。升级后又白屏 → 先 `patch --apply` 重打，再按需 `fix` / `registry`。
1.5 **`reasonguard` 的补丁同样会被升级覆盖**，而且它比 `patch` 更关键：`patch` 治「白屏」，`reasonguard` 治「历史加载失败」的复发。升级后 `status` 的「写入端」若不足 3/3，先退出应用再 `reasonguard --apply`。**`reason:null` 是 dsh 自己写的**（空响应的路径没给 `turnEnds` 赋默认值），所以只修数据必然复发。
2. **改数据前必须退出应用**，否则改动被覆盖。
3. **点「取消/拒绝」审批是触发条件**。在未打补丁的版本上，取消任何审批都有概率把该轮写成 `reason:null`。这不是用户操作错误。
4. **`torn JSONL record` 是字节守恒问题，不是数据丢失**。报错形如 `SessionQueryError: stored session "…" is corrupt: … complete frame contains a torn JSONL record`。dsh 的读取器对每个完整帧校验 `committedBytes === inputBytes`，只要某帧明文**不以换行结尾、或帧内多出空行**，就差几个字节判 torn，整个会话打不开。`scan` 现在会报 `torn 帧`，`fix` 能修（只重写涉事帧，记录数不变）。**注意：`verify` 判 `VISIBLE` 不代表能打开**——它只读首帧；完整可读性用 `scan` 或 `node scripts/host-read.mjs`（走 dsh 自己的 `open()`）确认。
5. **历史版本 `repairSession` 有个加换行的 bug，已修**。旧写法 `lines.join('\n') + '\n'` 会给已以换行结尾的帧多补一个 `\n`，于是「修完 reason:null 反而变成打不开」。判断依据：修过的帧明文以 `\n\n` 结尾。若遇到这类会话，`scan` 会列出、`fix` 会规范化尾部换行为恰好一个并剔除空行。

## 排查细节

根因链条、崩溃日志实证、坏事件样例、帧结构说明见 `references/root-cause.md`。当 dsh 版本升级导致 `app.asar` 内路径或命中数变化时，先读该文件确认判断依据，再手动定位新位置。
