# dsh-qq-group × dsh-world 融合推进方案

> 状态：Phase 1 已完成；dsh-world 0.5.1 已安装，待重启 DSH 做 Phase 0 桥接验证
> 原则：群聊纯聊天；主人私聊优先接 dsh-world；A 方案保留为 QQ 本地工具层和降级通道；不做长期双写。

## 1. 目标

让大肥鱼同时具备：

1. 群里的人格、关系、记忆、表情包、语音、QQ空间；
2. 一个真正长期生活的 Agent 会话：
   - 近期原文记忆；
   - 自己写的日记；
   - 不断改写的「我是谁」；
   - 自己的生活节奏和主动行为；
   - 能调用电脑/文件/浏览器等工具；
3. 主人私聊里，她不是“另一个机器人”，而是同一段生活的延续。

## 2. 为什么选 dsh-world

dsh-world 已经提供：

```text
home Agent 会话
近期原文记忆
日记作为长期记忆
「我是谁」自述
生活线与主动行为
本地 bridge：
  POST /dsh-world/bridge/say  外部把话送进家
  outlets                    把她的话推回外部
```

这些正好是 B 方案需要的 Agent 运行时，不需要我们重写。

我们保留自己的：

```text
QQ 接入（NapCat / OneBot 11）
群聊接话判断
群人格/群记忆
主动搭话与 @主人
语音、唱歌、表情包、QQ空间
```

## 3. 总体架构

```text
QQ 群聊
  → dsh-qq-group 现有链路
  → 纯聊天 / 群记忆 / 表情包 / 语音
  → 永不进入电脑工具

QQ 主人私聊
  → ExecutionRouter
     ├─ B：dsh-world bridge（优先）
     │    → home Agent
     │    → 长期记忆 / 日记 / 自述 / 工具
     │    → outlet 回 QQ
     └─ A：插件本地工具循环（降级）
          → /电脑
          → 截屏 / 点击 / 输入 / 快捷键

群永久记忆
  → 由 dsh-qq-group 管

生活记忆
  → 由 dsh-world 管

内心吐槽 thought
  → 按天写入 dsh-world 的 inner-thoughts
  → 只作为晚上回顾素材，不当事实记忆
```

## 4. 数据边界

### 4.1 dsh-world 管

```text
<DSH_HOME>/worlds/<worldId>/
  conversations/       按天归档
  room/我是谁.md       自述
  diary/               日记
  activity/            她的活动
  archive.sqlite       原文正本
```

### 4.2 dsh-qq-group 管

```text
<DSH_HOME>/dsh-qq-group/
  qq-memory.json       群聊短期记忆/摘要/关键记忆
  permanent-memory.json
    global             主人全局永久记忆
    groups             各群永久记忆
  diary.json           每条回复的内心吐槽（玩法层）
  qzone.json           QQ空间记录
  stickers/            表情包/自拍
```

### 4.3 单向同步

只允许：

```text
dsh-qq-group → dsh-world
```

具体：

```text
主人私聊永久记忆
  → worlds/<id>/room/from-qq-permanent.md
  → 只读，带时间和来源

每条回复 thought
  → worlds/<id>/room/inner-thoughts/YYYY-MM-DD.jsonl
  → dsh-world 晚上回顾时读取
```

禁止：

```text
两边同时写同一份主人记忆
两边同时注入同一份永久记忆
```

B 接管私聊后，QQ 私聊永久记忆停止写入，只保留历史导出。

## 5. 路由设计

新增设置：

```text
worldBridge.enabled: boolean
worldBridge.worldId: string        // 默认 default
worldBridge.privateBackend:
  world    B 优先，失败回退 A/普通聊天
  plugin   只用 A
  chat     只用现有普通聊天
```

同一时刻只能有一个后端回复：

```text
主人私聊
→ 读 worldBridge 配置
→ world 可用且启用：B
→ world 不可用且 A 开启：A
→ 否则：普通聊天
```

群聊：

```text
永远走现有插件
永远不进入 world
```

## 6. dsh-world 桥接接口

### 6.1 读取 bridge.json

```text
<worldDir>/bridge.json
{
  "origin": "http://127.0.0.1:xxxxx",
  "token": "...",
  "pid": 123,
  "startedAt": "...",
  "name": "..."
}
```

插件只读，不修改。

### 6.2 送话

```http
POST {origin}/dsh-world/bridge/say
x-dsh-world-token: <token>
content-type: application/json

{ "text": "主人说的话" }
```

返回 `202` 表示已进入她的家；具体回复走 outlet。

限制：

```text
dsh-world 只跟踪最近一条消息
→ QQ 侧必须串行队列
→ 上一条回复/超时后才能送下一条
```

### 6.3 接收回复

插件新增本地路由：

```http
POST /dsh-qq-group/world/outlet
content-type: application/json

{
  "text": "她的话",
  "kind": "reply | busy | reach",
  "name": "大肥鱼",
  "images": ["http://..."],
  "image": "表情名"
}
```

dsh-world 的 `outlets` 配置指向这个地址：

```yaml
outlets:
  - name: qq
    url: '{origin}/dsh-qq-group/world/outlet'
    kinds: [reply, reach]
```

`busy` 可只记日志，不发给主人。

## 7. 内心吐槽融合

现状：

```text
diary.json 只记录每条回复的 thought
不进入记忆
```

目标：

1. 保留现有日记玩法；
2. 额外写一份按天的纯文本：

```text
worlds/<id>/room/inner-thoughts/2026-10-26.jsonl
```

每行：

```json
{
  "ts": 1790000000000,
  "groupId": "<示例群号>",
  "groupName": "大肥鱼养殖基地",
  "incoming": "群友的话",
  "reply": "她发出去的话",
  "thought": "她当时的内心话"
}
```

3. dsh-world 夜间回顾读取，作为“今天在群里想过什么”的素材；
4. 日记仍由 dsh-world 自己写，不由插件代写；
5. thought 不直接当事实记忆，不进入永久记忆。

## 8. 人格处理

```text
dsh-world 的「我是谁」= 私聊/生活里的底层她
dsh-qq-group 的群 persona = 不同场合的面具
```

要求：

- 名字、称呼、底层价值观一致；
- 群 persona 可以不同，但不能和私聊的她完全割裂；
- 不把每个群的人格都塞进同一个 home Agent；
- 不把 home Agent 的私聊内容带进群。

## 9. 工具与审批

### B（dsh-world）

- 使用 DSH Agent 原生工具；
- 高危工具先依赖 DSH 审批；
- 后续把审批桥到 QQ：

```text
她请求执行危险动作
→ 插件发 QQ 私聊：
   1 允许一次 / 0 拒绝 / 2 本会话始终允许
→ 超时自动拒绝
```

### A（插件）

- 只保留 QQ 本地工具；
- 当前 /电脑 只开放截屏/点击/输入/快捷键/滚轮；
- 不开放 shell/文件/支付。

## 10. 分阶段实施

### Phase 0：验证 dsh-world

- 安装 dsh-world；
- 写人设；
- 开 bridge；
- curl 发送一句话；
- 配 outlet 到临时服务；
- 确认回复、日记、我是谁正常。

验收：

```text
bridge.json 存在
POST say 返回 202
outlet 收到 reply
日记文件生成
```

### Phase 1：只读桥接（不改回复）

- 插件读取 bridge.json；
- 只做健康检查，不发送；
- 状态页显示：

```text
world 在线 / 离线
world 名称
bridge pid
```

验收：

```text
不启动 world 时显示离线
启动后显示在线
不影响现有 QQ 聊天
```

### Phase 2：主人私聊接 B

- 主人私聊进入串行队列；
- 发送到 bridge；
- outlet 回 QQ；
- 关闭该私聊的普通插件回复；
- world 不可用时回退 A/普通聊天。

验收：

```text
一条私聊只回一次
连续两条按顺序回
world 断开时能降级
群聊完全不受影响
```

### Phase 3：记忆融合

- 主人私聊永久记忆导出到 `from-qq-permanent.md`；
- thought 写入 `inner-thoughts`；
- 停止 QQ 私聊永久记忆双写；
- 群永久记忆保持原样。

验收：

```text
world 能读到导出文件
群记忆不串私聊
私聊不串群
```

### Phase 4：工具统一

- B 使用 DSH 工具；
- A 保留 QQ 本地工具；
- 增加 QQ 内审批；
- 记录审计日志。

### Phase 5：主动行为

- dsh-world 的 `reach` 推回 QQ；
- 群里仍由插件主动搭话；
- 私聊主动消息走 world；
- 夜间免打扰/频率限制统一。

## 11. 风险与限制

1. dsh-world bridge 只跟踪最近一条消息，必须串行；
2. dsh-world 的 home 是单会话，不适合直接承载多群；
3. 两套人格可能漂移，需要统一底层设定；
4. 两套记忆可能双写，必须禁止；
5. dsh-world 的 Agent 工具审批目前在 DSH，不在 QQ；
6. dsh-world 后续可能自带 QQ 接入，届时我们可能变成 transport/适配层；
7. 不复制 dsh-world 源码进本项目，避免维护两套 Agent；
8. 暂不更新 GitHub，等完整版本稳定后再统一发布。

## 12. 文件规划

新增文件全部收在插件目录：

```text
src/qq/world-bridge.ts      读 bridge.json、送话、健康检查
src/qq/world-outlet.ts      outlet 接收与 QQ 转发
docs/WORLD-BRIDGE.md        本文档
```

不新建散落的临时脚本目录。  
所有备份统一放在：

```text
C:\<工作目录>\backups\
```

每轮更新前：

```text
源码 zip
数据 backup
全量备份更新（模型不重复拷贝时增量更新）
```

## 13. 当前已完成的基础

- 路线 A 第一版：1.28.2
  - 主人私聊 /电脑
  - 截屏/点击/输入/快捷键/滚轮
  - 默认关闭
- 语音/自拍误判已修
- 永久记忆私聊入口已补
- 关键记忆滚动区已做
- TTS 启动幂等已做

## 14. 结论

```text
A：保留，作为 QQ 本地工具层和降级通道
B：接 dsh-world bridge，不再自造 Agent
群聊：纯聊天，永远不给工具
私聊：B 优先，A 兜底
记忆：生活归 world，群聊归插件，单向同步
```

## 15. 当前进度

```text
Phase 0：dsh-world 0.5.1 已构建并安装，待重启 DSH
Phase 1：只读世界桥已完成（world/status + 状态页卡片）
Phase 2：待 Phase 0/1 验证后接入私聊
```

下一步：重启 DSH，打开「世界控制台」，写人设并开始世界，开启 bridge，再用状态页确认在线；之后接 bridge say/outlet。

## 16. 时间参与召回排序（补充）

这条接受：`recallCount` 延长半衰期，但不能让旧事一直占前排。时间必须进入排序。

### 16.1 召回分数

```text
score =
  relevance（语义/关键词相关度）
  × activation（重要性、情绪、衰减后的激活）
  × recencyPrior（时间新鲜度）
```

其中：

```text
halfLife = baseHalfLife × (1 + 0.35 × min(recallCount, 8)) × (0.7 + importance)
activation = importance × (0.6 + 0.4 × emotion) × exp(-ageDays / halfLife)
recencyPrior = 0.35 + 0.65 × exp(-ageDays / 14)
```

- 时间不是硬过滤，不会因为旧就直接排除；
- 新鲜事有加成，但不至于压死高相关的旧事；
- 重要且高情绪的记忆保留“长期锚点”通道；
- 被召回后 `recallCount` 增加，halfLife 变长，下一次更抗衰减；
- 但每次召回仍要重新过 `recencyPrior`，避免“老事永久前排”。

### 16.2 候选池

```text
1. 先用 relevance 捞出候选
2. 按 score 排序
3. 保留 1~2 个“长期重要锚点”名额
4. 其余按时间相关度 + 激活值取
5. 同一事件最多取 2 条，避免重复占位
```

### 16.3 时间查询

如果主人明确说：

```text
去年这个时候
上次
前几天
第一次
```

时间范围作为过滤条件，而不是只靠关键词。  
没有时间线索时，默认偏向近期，但保留重要旧事。

### 16.4 结论

```text
遗忘 = 激活降低
想起 = 激活回升 + 半衰期变长
排序 = 相关度 × 激活 × 时间新鲜度
旧事可以回来，但不能永远占前排
```
