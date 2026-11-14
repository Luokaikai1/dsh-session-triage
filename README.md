# dsh-session-triage

DeepSeek Harness（下称 dsh）会话「**对话区整块变白**」「**历史加载失败**」「**侧栏里会话不见了**」的**分层诊断 + 修复**技能。

它不是常驻插件，而是一本操作手册（`SKILL.md`）加几支可直接运行的 `node` 脚本。原则只有一句：**先判层，再动手**——绝大多数"会话没了"的情况，磁盘上一个字节都没丢。

## 它解决的问题

| 层 | 典型现象 | 命令 |
|---|---|---|
| 数据层 | 某轮 `turn/end` 的 `reason` 被写成 `null` | `fix` |
| 投影层 | 打开会话报 `failed to project session … reading 'code'` | `endcheck --apply` |
| 分帧层 | 会话在侧栏里消失、点开打不开（首帧不变量被破坏） | `frames --apply` |
| 注册表层 | 侧栏只剩更早的会话，今天的不见了 | `registry` |
| 客户端层 | 对话区白屏，侧栏与输入框正常 | `patch --apply` |
| 复发层 | 修好又坏、一天内反复三次以上 | `guards` |

`verify <id前缀>` 一条命令即可判定属于哪一层，是"数据真的丢了"还是"dsh 发现不了"。

## 与 `dsh-session-doctor` 插件的关系

**独立编写，不隶属，也不是它的二创。**

- npm / GitHub 上的 `dsh-session-doctor`（作者 imtokenxinluo）是**常驻库**：写时哨兵（watch）、无损修复（repair）、事故归因（blame），装进 profile 后随宿主运行。
- 本技能是**操作手册 + 命令行脚本**：覆盖首帧不变量、注册表漏登记、客户端补丁、fork 血缘判定这类"插件不管"的层面。

两者可以同时使用，互不冲突。

## 安装

把本仓库整个目录放到 dsh 的技能目录下：

```bash
git clone https://github.com/<you>/dsh-session-triage.git "$HOME/.dsh/skills/dsh-session-triage"
```

- Windows：`%USERPROFILE%\.dsh\skills\dsh-session-triage`
- 放好后新开会话，技能目录里即出现 `dsh-session-triage`。

**运行脚本需要 Node.js ≥ 22**（用到 `node:zlib` 的 zstd 解压）。

## 用法

```bash
node scripts/doctor.mjs status               # 总览：环境/数据/注册表/补丁/崩溃日志（先跑这个）
node scripts/doctor.mjs verify [--all]       # host 视角判定：dsh 到底认不认这个会话（最权威）
node scripts/doctor.mjs scan                 # 只体检，不写文件
node scripts/doctor.mjs fix                  # 修非法 turn/end reason
node scripts/doctor.mjs endcheck [--apply]   # 修畸形 turn/end（缺 error.code）
node scripts/doctor.mjs frames [--apply]     # 首帧不变量（列表里消失时先跑）
node scripts/doctor.mjs registry [--dry]     # 补登漏掉的会话
node scripts/doctor.mjs lineage [<id前缀>]   # 分支（fork）血缘
node scripts/doctor.mjs guards               # 找"自动改写会话文件"的脚本/计划任务
node scripts/doctor.mjs patch [--apply]      # 客户端空值防护（默认 dry-run）
node scripts/doctor.mjs reasonguard [--apply] # reason:null 防复发三补丁
node scripts/doctor.mjs restore <文件>       # 从备份还原
```

默认全部 **dry-run**，只有带 `--apply`（或 `fix`/`registry` 这类写明会写的子命令）才落盘；写之前会生成 `.bak-<标签>-<时间戳>` 备份。

## 已知限制

- **客户端补丁会被升级覆盖**：`patch` / `reasonguard` 直接改安装目录下的 `app.asar`，dsh 每次升级会整体替换 `resources/`，补丁与 `.bak` 一并失效，必须重打。这是设计使然，不是缺陷。
- **改数据前必须先退出 dsh**，否则改动会被运行中的进程覆盖。
- **主要在 Windows 上端到端验证**。macOS / Linux 的 `app.asar` 路径靠 `DSH_ASAR` 环境变量指定，**未端到端验证**。
- **`guards` 只扫描指定的第三方目录**：需设置 `DSH_BRIDGE_DIR=<目录>`，否则只查计划任务，不查脚本。
- **只覆盖已列举的损坏形态**。其它形状的损坏（例如非 zstd 多帧结构）不在处理范围，脚本会报错退出而不是猜着改。
- `reasonguard` 是**等长原地改写**：版本不匹配、锚点找不到就中止，不会破坏原有字节。
- 本技能**不会自动执行任何脚本**——skill 只是说明书，命令要你自己跑。

## 目录结构

```
SKILL.md                 技能正文（判层流程、各层处置、必须提醒用户的事实）
scripts/doctor.mjs       主脚本（status/verify/fix/endcheck/frames/registry/lineage/guards…）
scripts/reasonguard.mjs  客户端三处 reason 容错补丁
scripts/host-probe.mjs   宿主视角探针
scripts/host-read.mjs    走 dsh 自己的 open() 验证可读性
scripts/hostlist.mjs     会话清单
references/root-cause.md 根因链条、崩溃日志实证、帧结构说明
```

## 免责

脚本会修改你的**会话文件**与**客户端安装文件**。所有写操作前都有备份，但请先在 `status` / `scan` 的只读结果上确认诊断结论，再执行写入。作者不对误用导致的损失负责。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
