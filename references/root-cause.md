# 根因档案：dsh 会话全白

排查时间：2026-11-13。dsh 桌面端（`DeepSeek Harness.exe`）+ `@deepseek-ai/dsh` CLI 依赖树。

## 1. 症状序列

用户描述的三个阶段，全部被后续证据解释：

1. 「昨天以前的会话记录都在，今天没有」 → 注册表层：今天那个会话打不开，被 `workspace.json` 的 `sessionIds` 漏掉
2. 「刚加载进去能看到点，然后变白」 → 客户端层：首帧渲染出历史消息，遇到坏事件时 React 抛错，错误边界把整块对话区清空
3. 「开新会话让它自己处理，又变白了」 → 新会话在修改注册表时弹审批，用户点「取消」，`turn/end` 写成 `reason:null`，形成新的坏事件

## 2. 客户端崩溃证据

文件：`%APPDATA%/@deepseek-ai/dsh-desktop/logs/crash-2026-11-13T00-00-29-931Z-host.log`

连续 21 条同一错误：

```
TypeError: Cannot read properties of null (reading 'kind')
```

末尾紧跟：

```
[session-controller] event feed subscriber failed
```

代码位置：`app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`，共 3 类模式、**9 处**裸读：

| 原始写法 | 危险点 |
|---|---|
| `data.reason.kind` | `data` 存在但 `reason` 为 null |
| `reason.reason.kind` | 嵌套 reason 为 null |
| `(reason.kind)` | 局部变量 reason 为 null |

## 3. 数据层证据

坏事件在 `session-49e24b72-.../session.v4.jsonl.zstd` 的 seq 326：

```json
{"type":"turn/end","seq":326,"data":{"reason":null}}
```

前一条事件是：

```json
{"type":"approval/decided","data":{"outcome":"cancelled"}}
```

即：**用户取消审批 → 该轮以 `reason:null` 收尾 → 客户端裸读崩溃**。

合法形状参照客户端自身分支，应为：

```json
{"reason":{"kind":"aborted","reason":{"kind":"user"}}}
```

## 4. 文件格式

`session.v4.jsonl.zstd` 不是单个 zstd 流，而是**多帧追加**（每批事件压一帧、尾接下一帧），魔数 `28 b5 2f fd` 在文件里出现上百次。

因此：

- 逐帧 `zstdDecompressSync`，坏帧单独跳过即可，不必整文件丢弃
- 修改时只重压受影响的帧，其余帧原始字节原样拼接（能最大限度保留历史、避免二次损坏）
- 用 `buf.indexOf(MAGIC)` 扫帧边界，不能按 zstd 规范只读第一帧

## 5. 为什么必须做等长改写

`app.asar` 是「16 字节头部 + JSON 目录 + 拼接的文件内容」，每个文件的 `offset` / `size` 写死在 JSON 目录里，目录本身还有对齐填充。

在 `.kind` → `?.kind` 这类改写里，每处 +1 字节，9 处共 +9 字节。直接改会让后面的所有条目错位、整个 asar 报废。所以脚本从块注释里**精确裁掉相同的字节数**，保证 `size` 不变，再写回原 offset。

## 6. 复现与回归

复现：未打补丁的客户端上，任意会话触发一次审批 → 点「取消」→ 该轮以 `reason:null` 收尾 → 重进该会话即白屏。

回归检查：

```bash
node scripts/doctor.mjs status
```

期望：问题会话 0、未登记 0、裸读 .kind 0 处、?. 防护已生效。

## 7. 版本漂移应对

dsh 升级后若脚本报「asar 里没找到 dsh-client-ui-chat/lib/client.js」，说明包结构变了。人工定位步骤：

1. 列出 asar 内所有 `client.js`：
   ```bash
   npx @electron/asar list "<app.asar>" | grep "client\.js$"
   ```
2. 在其中搜 `reason.kind` / `reading 'kind'` 附近代码，确认新的包名与路径
3. 同步修改 `scripts/doctor.mjs` 里的 `TARGET_SUFFIX` 与 `PATCHES`，再跑 `patch`

若上游已修复（源码里已是 `?.kind`），`patch` 会输出「裸读 .kind 0 处」，此时只需保留 `fix` / `registry` 两层能力。

## 8. 复发根源：第三方「自愈」脚本在改会话文件（2026-11-14 实测定论）

### 症状特征

修完之后 `status` 全绿，用户重开、用一阵，会话**又白 / 又从侧栏消失**。一天内反复三次以上。修复动作本身没问题，问题是有另一个进程在并行改同一个文件。

### 实测链路（本机）

`%USERPROFILE%\.zcode\bridge\watcher.mjs`（示例：任意第三方桥接目录） 主循环里有一段「self-healing」，每 30 分钟执行一次：

```
execSync(py + ' -I nullfix.py --scan-all')
```

`nullfix.py` 的本意是修 `turn/end reason:null`，但它做了三件危险的事：

1. **补出来的 reason 缺 `error` 对象**
   `{"kind":"error","message":"turn aborted (…)"}` → 投影读 `reason.error.code` → `Cannot read properties of undefined (reading 'code')` → 整份历史打不开。
2. **把整个文件压成 1 帧**
   整个明文一次性 compress → 首帧装了 3000+ 行，违反 `assertZstdHeaderFrame`（首帧必须只含会话头一行）→ host 逐条 `listArtifacts` 时抛错被 `catch` 吞掉 → `metadata === undefined` → `continue` → 该会话对侧栏「不存在」。
3. **在 app 运行时整文件重写**
   解压 → 改字节 → 重压 → 原子替换。app 手里还是旧句柄，替换之后它的追加全写到被删除的旧 inode → 静默丢事件；同时 app 内存里的投影水位与磁盘脱节。

另外还有一个残留的一次性计划任务 `DSH-SessionFix-49e24b72`（跑一个「等 app 退出再修」的脚本，失败后没有自我删除），会再补一刀。

### 判据

- 现象按**整点/半点**（30 分钟倍数）复发 → 强烈指向某个定时 sweep
- 会话目录里出现 `.bak-nullfix` / `.bak-nullfix.N` 系列备份
- 文件被改成 **1 帧**、行数没变（数据没丢，只是分帧错了）
- `watcher.log` 里有 `nullfix sweep:` 字样

### 处置

```bash
node doctor.mjs guards          # 先找出来
```

然后：

1. 删掉自动调用（把 watcher 里那段 sweep 整段删掉并写清原因，别只注释掉一行）
2. 修 nullfix 脚本本身：**默认 dry-run**、`--apply` 才写、检测到 `DeepSeek Harness.exe` 在跑就直接拒绝、**逐帧修复**（保持帧边界，首帧仍只装会话头）
3. 删残留计划任务：`Unregister-ScheduledTask -TaskName 'DSH-SessionFix-…' -Confirm:$false`（`schtasks /delete` 可能被安全策略拦，用 cmdlet）
4. 手工修数据：退出 dsh → `python -I nullfix.py --scan-all --apply` → `doctor.mjs status` 复检

### 原则

dsh 的 `session.v4.jsonl.zstd` 是它的私有存储：**不允许常驻进程在 app 运行时改写**。所有数据修复都必须是「退出 app → 一次性离线修 → 复检」。

## 9. 第三类历史加载失败：dsh 自己写 `reason: null`，host 投影层崩在 `reading 'kind'`（2026-11-14 定案）

### 症状（实测）

2026-11-14 22:04，两个会话同时报（session-658ed063… / session-86b47e17…）：

```
历史加载失败：failed to project session "session-…": Cannot read properties of null (reading 'kind')（gateway/internal）
```

### 根因链

`@deepseek-ai/dsh-agent-loop/lib/index.js` 的 `ReactLoopAgent.turn()`：

```js
let turnEnds = null;
...
finally { this.session.append("turn/end", { turn, reason: turnEnds }); }
```

正常路径 `turnEnds` 由 `step()` 返回值覆盖（completed / max-tokens / aborted / error）；但**空响应**（`assistant/attempt … stream:[]`）走到不赋值就退出的分支，初始 `null` 原样落盘；审批取消路径同样可能让 `turnEnds` 保持 null。goal 轮次每轮 splice 重开、轮次极多（实测单会话 31–86 轮），空响应概率被放大。

投影崩点：`dsh-api-session-controller` continuation 投影的 `event.data.reason.kind`（补丁前裸读）——reason 为 null 时抛 `reading 'kind'`；投影是对全量事件 fold，**一条坏事件毁掉整份历史**。同一家族的第二类是 `{kind:"error"}` 缺 `error.code` → `reading 'code'`（外部桥接救援工具写的）。§2 的客户端裸读是第三个崩溃面，三者同根（reason:null）。

### 三层防护（reasonguard.mjs，等长原地改写 + node --check，写前备份 app.asar.bak-reasonguard-<时间戳>）

| 目标 | 补丁后写法（2026-11-14 版 asar 实测行号） | 作用 |
|---|---|---|
| `dsh-agent-loop` | `reason: turnEnds ?? { kind: "completed" }`（:833） | 写入端不再落 null |
| `dsh-api-session-controller` | `event.data.reason?.kind === "error" && …reason?.error?.code`（:501） | 投影端容错 |
| `dsh-goal-round-driver` | `event.data.reason?.kind` / `?.reason?.kind`（:274–279） | goal 监听器容错 |

数据层修复由 `endcheck --apply` 完成（reason:null → `{kind:"aborted", reason:{kind:"user"}}`，缺 error.code 的补出 `error:{message,code}`）。

### 2026-11-14 验证记录

- 备份 `app.asar.bak-reasonguard-20261114141817`（22:18:17 落盘）；补丁后 endcheck 全库 0 条畸形、scan 232 会话无坏帧无 torn；verify：658ed063 = ARCHIVED（健康，仅被归档）、86b47e17 = VISIBLE
- **dsh 升级必重打**（installer 整体替换 resources）；`status` 的「写入端（reason:null 防复发）」一段显示 3/3 状态，不足先退出应用再 `reasonguard --apply`
