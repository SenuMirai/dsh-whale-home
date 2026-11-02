# 微信版可行性评估

> 结论先说：**能复刻，而且我们的插件天生适合**——但难点全在「微信适配层」，不在插件。
> 这份文档记录调研结论、三条路线、以及我建议的第一步。

## 一、那个项目到底是什么

主人说的 `WeChat Agent` 有两个同名项目，我都看了：

### 1. [sourcepro5/WeChatAgent](https://github.com/sourcepro5/WeChatAgent) —— 和我们要做的事最像

它自己的 package.json 描述写得很直白：

> Personal WeChat AI friend with **NT reader, WeChat-Hook, OneBot v11** and an existing DSH Desktop

拆开就是：

```
微信 PC 客户端
  ├─ NT reader   —— 解密读取微信 4.x 的本地数据库
  └─ WeChat-Hook —— 注入 WeChat.exe（需要 wx_key.dll + 编译产物）
        ↓
   OneBot v11
        ↓
   DSH 插件（packages/dsh-social-bridge-plugin）
```

**它的功能列表和我们 dsh-qq-group 几乎一一对应**：人格聊天、独立上下文、图片/表情理解、
原生表情发送、主动聊天、上下文压缩、群友记忆、表情包池、按聊天授权。

**但关键的部分没有开源**：README 明说「源码不含账号、凭据、联系人、聊天记录、微信客户端
或原生 DLL」「开发构建需准备已授权的匹配微信、Hook 编译产物、wx_key.dll 和读取依赖」。
也就是说，**最难的 hook 二进制是私有的**，我们抄不到。

而且它**锁死微信 4.1.10.27**（Windows x64）。微信每 1~2 周一个小版本，这个绑定意味着
每次微信更新都要重新逆向。

### 2. [com.wechat.wechatai](https://github.com/Xposed-Modules-Repo/com.wechat.wechatai) —— 安卓 LSPosed 模块

微信内嵌的 AI 助手模块，走 Xposed hook，锁 **微信 8.0.78**。功能类似，但它是安卓端
Xposed 模块，不是 DSH 插件，和我们的架构不通用。

## 二、我们的插件能直接复用吗

**能，这是最大的好消息。**

`dsh-qq-group` 本质是一个 **OneBot 11 客户端**：它连 `ws://127.0.0.1:3001`，收发标准
OneBot 事件与 API。这意味着**只要有一个「微信 ⇄ OneBot 11」的适配层，插件几乎不用改**。

它用到的 API 一共 15 个，分成两类：

| 类型 | API | 微信侧 |
|---|---|---|
| **标准 OneBot 11**（核心，必须有） | `send_group_msg` `send_private_msg` `get_login_info` `get_msg` `get_forward_msg` `get_group_info` `get_group_list` | ✅ 适配层要实现 |
| **QQ / NapCat 专有**（可选功能） | `get_group_root_files` `get_group_files_by_folder` `get_group_file_url` `get_file`（群文件）、`get_cookies`、`send_qzone_msg` `delete_qzone_msg`（QQ空间） | ❌ 微信没有，需优雅跳过 |

也就是说：**聊天、私聊、群聊、记忆、画像、日记、心情、语音、表情包这些核心能力都能原样保留**，
只有「群文件」「QQ空间」这两个功能在微信版里会缺席。

### 一个方向问题（必须先解决）

我们的插件是**主动连接** `config.url` 这个 WS **服务端**（NapCat 提供）。
而 Akasha-WeChat 那类桥是**反向连出去**（连 AstrBot 的 server）。

所以要么适配层自己**监听一个 WS 端口**（像 NapCat 在 3001 那样），要么给插件加
「反向 WS 接收」模式。前者更省事。

## 三、微信侧适配层：三条路

微信桌面版**没有个人号官方 API**（官方只给企业微信「会话存档 SDK」）。
所以「收消息」和「发消息」都要绕。这两个是独立的，风险不同：

### 收消息

| 方法 | 原理 | 4.1.10+ 是否可用 | 风险 |
|---|---|---|---|
| 读本地加密 DB | 解密 `db_storage/message_N.db` | 需要先拿到密钥 | **低**（只读，不注入） |
| 读 DB 密钥 | `wcdb-key-tool` 扫 Config.Cipher（管理员 + ReadProcessMemory） | 社区在 4.1.13.12 上 20/20 成功 | 中低 |
| 被动内存扫描 `x'96hex'` | 扫进程内存找 raw key | **❌ 4.1.10 起彻底失效**（零驻留） | — |
| DLL 注入 / Frida / 调试器 | hook 密钥设置函数 | ✅ 可行 | **中高**，有真实封号案例 |
| 降级到 4.1.9 提密钥再升级 | 一次提取，密钥跨版本有效 | ✅ 最稳 | 无 |

### 发消息

| 方法 | 说明 | 风险 |
|---|---|---|
| **Windows UIA 自动化** | 模拟操作微信窗口（Akasha-WeChat 就这么做的） | **低**（不注入） |
| hook 发送函数 | 直接调协议 | 高 |

**所以「低侵入」的组合是：读解密 DB 收 + UIA 模拟发送。** 全程不注入、不 hook 代码段，
是灰色地带里最轻的一档。

### 参考实现：[Akasha-WeChat](https://github.com/alingalingling/Akasha-WeChat)

MIT 协议，Python，做的正是「微信 → OneBot v11」：
- 收：连 WeFlow 的 SSE 推送
- 发：UIA 自动化
- 转 OneBot v11，反连 AstrBot

**但它依赖 WeFlow**（一个读本地微信记录的工具），而 WeFlow 的作者已经删库，只能在 QQ 群下载。
第三方闭源依赖 + 删库史 = 不可靠。**可以参考它的思路，不能直接依赖它。**

## 四、三条路线对比

| 路线 | 能加普通微信好友/群吗 | 稳定性 | 封号风险 | 前置条件 | 结论 |
|---|---|---|---|---|---|
| **A. 企业微信 / 微信客服** | 部分（只能走客服/外部联系人） | 高，官方 API | 无 | 需企业认证（个体户也行） | 想长期用选这个 |
| **B. 安卓 LSPosed hook** | ✅ 完整 | 中高 | 中（小号） | root 安卓机 + 常驻 | 真能跑，最像 QQ 版 |
| **C. Windows 读 DB + UIA 发** | ✅ 完整 | 中（微信更新会坏） | 低-中 | 锁定微信版本 + 禁更新 | 折中方案 |
| **D. Windows DLL 注入 hook** | ✅ 完整 | 低（版本战） | **高** | 逆向能力 | ❌ 不建议 |

补充：安卓路线有人真做成了（[这篇博客](https://zxis233.github.io/2026/09/23/wechat-lsposed-astrbot/)），
思路是 hook 手机微信收发函数 → 转 OneBot v11 → 反向 WS 连 bot。作者自己的原话是
「先挂安卓手机上了，看看跑几天会被检测封号。还好是小号，随便造」。

## 五、必须接受的三个事实

1. **主号绝对不能用。** 腾讯对自动化有真实封号案例；2025-10 还有多款工具作者收到律师函后删库。
   要用就专用小号，封了不心疼。
2. **微信每 1~2 周更新一次**，任何方案都会周期性失效，需要持续维护。
3. **这和 QQ 版的难度不是一个量级。** QQ 有 NapCat 这种成熟协议端，装上就能用；
   微信没有等价物，适配层要自己养。

## 六、我建议的第一步（零风险）

**先不碰真微信。** 按这个顺序推进：

### 第 0 步：把插件变成「多后端」

现在 `qq.json` 只有一个 `url`，一个插件实例只能连一个 OneBot。
要同时挂 QQ 和微信，得支持多连接：

```json
"upstreams": [
  { "id": "qq",    "url": "ws://127.0.0.1:3001", "token": "..." },
  { "id": "wechat","url": "ws://127.0.0.1:3002", "token": "..." }
]
```

会话 key 再加一层命名空间（`qq:809773499` / `wx:xxx@chatroom`），和私聊那个 `p:` 前缀同一个思路。

### 第 1 步：写一个假 OneBot 网关

用 Node 写一个能跑在本机的 mock：注册成 WS 服务端，模拟群消息/私聊、回显发送。
**用它跑通全链路**，证明插件在「非 NapCat 的 OneBot 实现」上也能正常工作，
并且找出所有 QQ 专有 API 的失败点。**这一步完全不碰微信，零风险。**

### 第 2 步：把 mock 换成真适配层

到这一步才需要决定走 A / B / C 哪条，也才需要动真账号。

## 七、需要主人拍板

1. **用哪个号？** 必须是全新小号吗？现在有没有？
2. **走哪条路？** A 企业微信（合规但要资质）/ B 安卓（要 root 手机）/ C 桌面读 DB+UIA（锁版本）。
3. **有没有企业资质？** 有的话 A 路线最省心，且不会封号。
4. **能不能接受「微信更新就坏」？**

第 0、1 步不依赖上面任何决定，随时可以开工。
