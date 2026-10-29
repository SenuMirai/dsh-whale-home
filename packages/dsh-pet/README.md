# dsh-whale-girl 🐋

住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的鲸鱼娘 AI 伙伴。

她**不是**单纯的桌宠——在 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的全部能力之上，
增加了三件事：**会说话**、**会看屏幕**、**会陪玩**。

> 本插件 fork 自 dsh-pet（MIT, © 2026 PC2005-cloud），改动范围见 [NOTICE.md](./NOTICE.md)。

---

## 当前状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 形象渲染（106 段透明动画） | ✅ 沿用上游 | 待机 / 点击 / 拖拽 / 移动 / 碎碎念 / 余额动画，全部可播 |
| 文字对话（真模型 + 人设 + 记忆） | ✅ 沿用上游 | `/chat` 命令、右键对话、记忆落盘 |
| 桌宠物理（拖拽甩抛 / 多开 / 桌面窗） | ✅ 沿用上游 | 浏览器 overlay + 透明置顶桌面窗 |
| 余额展示 / 系统通知 / 斜杠命令 | ✅ 沿用上游 | `/balance`、`/pet`、`/chat` |
| **实时语音对话** | ✅ 已可用 | 本地 SenseVoice ASR + 晓伊 TTS，按住说话；见 [docs/VOICE.md](./docs/VOICE.md) |
| **看屏幕搭话（主动识屏）** | ✅ 已可用（默认关） | 截图仅内存 → 官方视觉模型 → 气泡；快照可核对；见 [docs/SIGHT.md](./docs/SIGHT.md) |
| **游戏陪玩（看战况点评）** | ✅ 已可用 | 识屏的「陪玩模式」：盯局势、点评、该开团就喊；见 [docs/SIGHT.md](./docs/SIGHT.md) |
| **游戏代打（自己玩）** | ✅ 已可用（默认空跑） | 键鼠注入 + 决策循环 + 三层急停；见 [docs/AUTOPLAY.md](./docs/AUTOPLAY.md) |
| **QQ 群接入（已拆分）** | ➡️ 独立插件 [dsh-qq-group](dsh-qq-group) | 不再和桌宠共享人设/记忆/数据目录；设置页可选人设、主动/被动、DSH 模型 |

路线图与验收标准见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

---

## 安装

本插件目前是**本地 link 安装**（不走 npm），因为还在开发期：

```powershell
# 1. 构建
pnpm install
pnpm run bundle

# 2. 装进 profile（在 profile 的 package.json 里加 link + bundles 行）
#    见 docs/INSTALL.md

# 3. 重启 DSH —— profile.bundles 只在启动时读取一次，热重载不会捡起新插件
```

**必须重启**。这是最容易踩的坑：插件装进去后 `plugin_manager` 能看到它，
但状态会是 `failed`，路由 404，看起来像插件坏了——其实只是宿主没重新读 bundles。

---

## 与 dsh-pet 的隔离

两个插件可以**同时安装、同时运行**，互不干扰：

| 项 | dsh-whale-girl | dsh-pet |
|---|---|---|
| 包名 / entry id | `dsh-whale-girl` | `dsh-pet` |
| 路由前缀 | `/dsh-whale-girl/*` | `/dsh-pet-7340/*` |
| 用户数据目录 | `$DSH_HOME/dsh-whale-girl/` | `$DSH_HOME/dsh-pet/` |
| 桌面助手桥接协议 | `dsh-whale-girl-bridge://` | `dsh-pet-bridge://` |
| Electron 用户数据 | `%APPDATA%\dsh-whale-girl-helper\` | `%APPDATA%\dsh-pet-electron-helper\` |
| **斜杠命令** | `/whale-balance` `/whale-pet` `/whale-chat` | `/balance` `/pet` `/chat` |
| **overlay 插槽 id** | `whale-girl` | `pet` |
| **设置页 id** | `whale-girl-config` | `pet-config` |
| **字典命名空间** | `whale-girl.config` | `pet.config` |

> ⚠️ **命令名必须带 `whale-` 前缀。** DSH 的 `commands` 是全局命名空间，
> 同名注册会抛 `command "xxx" is already registered`，并且**整个 DSH 都启动不了**
> （不是插件不可用，是应用起不来）。这一条踩过，见 [docs/ROADMAP.md](./docs/ROADMAP.md) 的坑 6。

---

## 配置与用户数据

配置结构**与上游完全同构**，详见上游 README 的「⚙️ 配置」一节。本插件只是把路径从
`$DSH_HOME/dsh-pet/` 换成 `$DSH_HOME/dsh-whale-girl/`：

| 路径 | 作用 |
|---|---|
| `$DSH_HOME/dsh-whale-girl/main-config.jsonc` | 用户配置（覆盖片段） |
| `$DSH_HOME/dsh-whale-girl/memory.json` | 对话记忆（全存不删） |
| `$DSH_HOME/dsh-whale-girl/main-animation/` | 用户自定义动画（优先于包内素材） |
| `$DSH_HOME/dsh-whale-girl/memes/` | 用户自定义表情包 |
| `$DSH_HOME/dsh-whale-girl/pet/` | 额外宠物种类（pet pack） |

---

## 开发

```powershell
pnpm run bundle      # 构建 lib/{index,client,standalone,qq}.js
pnpm run typecheck   # 类型检查
pnpm test            # 单元测试

node tools/run-checks.mjs          # ★ 一键回归：全部套件（30 个），任一失败即非零退出
node tools/test-routes.mjs         # 单独跑：路由可达性（autoplay/* 曾经全部 404 的那个坑）
node tools/test-hotkey.mjs         # 单独跑：全局语音热键（解析/轮询/SSE，真按键注入）
node tools/test-play-loop.mjs      # 单独跑：陪玩循环调度（假定时器，不碰真键鼠）
node tools/test-memory-io.mjs      # 单独跑：记忆导入/导出（多格式解析、去重排序）
node tools/test-chat-format.mjs    # 单独跑：台词/动作拆分（气泡只留台词，动作进记录）
node tools/test-qq.mjs             # 单独跑：QQ 群接入（协议/策略/提示词/记忆，不联网）
node tools/test-sound.mjs          # 单独跑：音频引擎（WAV/DSP/混音/唱歌音准）
node tools/verify-load.mjs         # 单独跑：profile 安装正确性（15 项）
node tools/check-name-collisions.mjs  # 单独跑：与 dsh-pet 的命名冲突
node tools/probe-coexist.mjs       # 单独跑：真实服务语义下的激活与并存
node tools/probe-apply.mjs         # 用伪 ctx 跑 apply()，抓真实报错
```

> `test-qq.mjs` / `test-sound.mjs` 走的是 `src/` 里的 TypeScript 源码，
> 要用 `node --import ./scripts/test-register.mjs tools/test-qq.mjs`（补 `.ts` 解析）。
> `run-checks.mjs` 已经替你加上了这个参数。

### QQ 群接入（云端）

不用启动 DSH，单独一个进程就能跑：

```powershell
node lib/qq.js --check                               # 体检：配置/模型/TTS/NapCat/后端
node lib/qq.js --sing 小星星 --out .\out\twinkle.wav  # 离线渲一首歌（验证音质）
node lib/qq.js --score                               # 打印乐谱模板
```

部署（Docker / systemd）与全部配置项见 [docs/QQ.md](./docs/QQ.md)。

**改完代码、重启 DSH 之前，必须先跑 `run-checks.mjs` 全绿。**
命令撞名会让整个 DSH 起不来，而 DSH 启动失败后的「回滚」会连主人的
模型配置、权限预设、皮肤一起清掉——代价太大，不能靠重启试。

### 为什么本机没装 pnpm 也能构建

DSH 自带运行时里有 node 与 pnpm：

```powershell
$rt = "$DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies"
$env:PATH = "$rt\node\bin;$env:PATH"
& node "$rt\pnpm\bin\pnpm.mjs" run bundle
```

---

## 许可

- 本插件代码：MIT（见 [LICENSE](./LICENSE)）
- 上游 dsh-pet 代码与美术素材：MIT, © 2026 PC2005-cloud（见 [NOTICE.md](./NOTICE.md)）
