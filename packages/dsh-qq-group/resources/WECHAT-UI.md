# 微信界面驱动（Computer Use 路线）

微信 4.2.0.9 不在 dsh-world 原生桥的支持列表里（只支持 4.1.15.13 / 4.1.15.56），
原生桥依赖 Weixin.dll 的函数偏移，版本一变就失效。所以走界面操作。

## 已验证

\`\`\`text
probe   → 找到微信窗口（按进程名 weixin/wechat 匹配，避开中文标题编码）
capture → PrintWindow 直接抓窗口内容，不抢前台、不怕被遮住
\`\`\`

实测截图能看到左侧会话列表（千宇·未来 / 大肥鱼 / 公众号 / 林小皓）。

## 动作

| action | 参数 | 说明 |
|---|---|---|
| probe | - | 找窗口，返回位置和尺寸 |
| capture | maxWidth / maxHeight | 抓窗口截图（base64 PNG） |
| click | x / y | 相对窗口左上角点击 |
| type | text | 向当前焦点输入 |
| key | key | 发送按键（SendKeys 语法） |

## 调用方式

用 base64 编码的 JSON 作为 -PayloadBase64 传入：

\`\`\`powershell
$payload = '{"action":"capture","maxWidth":1000,"maxHeight":1200}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
powershell -NoProfile -ExecutionPolicy Bypass -File wechat-ui-driver.ps1 -PayloadBase64 $b64
\`\`\`

## 已知限制

- 只截窗口矩形，右侧聊天面板可能是空白（微信用分层渲染，PrintWindow 抓不全）
- click 是相对坐标，需要先 capture 拿到 width/height 换算
- 没有做"按聊天名定位"，目前靠坐标

## 下一步

1. 解决聊天面板渲染不全（改用分段截图或 DWM 合成）
2. 封装成 DSH 工具给家会话：wechat_ui_screen / wechat_ui_click / wechat_ui_type / wechat_ui_key
3. 工具只在 agentPreset=standard（家会话）注册，工作会话不暴露
