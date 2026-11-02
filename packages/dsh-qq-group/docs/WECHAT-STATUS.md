# 微信接入状态

> 更新时间：2026-10-27
> 目标：复用上游 dsh-world 0.5.6 微信模块，不自己重写。

## 已完成

- 上游 dsh-world 0.5.6 已构建，typecheck/build/npm pack 通过；
- 项目自带 283 项测试全部通过；
- 独立测试 profile：
  - `C:\Users\<用户名>\.dsh\profiles\world-wechat-test`
  - `worldId: wechat-test`，与主世界隔离
  - `wechat: true`
  - `archiveScope: home`
- 微信 Python 适配器依赖已安装到：
  - `<dsh-world-056>/.host/wechat/.venv`
- 适配器 Python 单元测试：

```text
Ran 58 tests
OK
```

## 当前阻塞

原生桥编译需要：

```text
Visual Studio C++ x64 Build Tools
```

已确认上游发布包**没有预编译 DLL/EXE**；`sender.py` 仍然加载原生引擎，只装 Python 依赖不能发送。因此不能绕过 MSVC。

也试过便携 WinLibs（MinGW GCC）：

```text
能编译大部分 bridge.cpp
卡在 __try / __except（访问微信内存的 SEH 保护）
MinGW GCC 不支持 MSVC SEH
```

不拿掉这段保护硬编译，避免微信进程崩溃。原生桥仍应使用 MSVC。

又试了 LLVM-MinGW（Clang 23）：

```text
SEH 这一关能过
但 bridge.cpp 要求 sizeof(std::function<void()>) == 64
libstdc++ 是 48
ABI 与 MSVC 不兼容，不能用于微信
```

结论：容器/便携编译器都替代不了 MSVC 工具链。

缺少：

```text
C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe
```

构建命令：

```powershell
cd <dsh-world-056>\src\ecosystem\wechat\windows
.\wechat.ps1 Build
```

报错：

```text
The term '...vswhere.exe' is not recognized
```

## 安装后继续

一键安装脚本：

```powershell
C:\<工作目录>\plugins-src\dsh-qq-group\scripts\install-wechat-buildtools.ps1
```

只检查、不安装：

```powershell
.\install-wechat-buildtools.ps1 -CheckOnly
```

然后：

1. 安装 Visual Studio Build Tools（Desktop development with C++ / MSVC x64）；
2. 重新执行 `wechat.ps1 Build`；
3. 创建 `.host/wechat/config.json`：
   - 参考 `world-wechat-test/wechat-config.template.json`
   - 填写独立微信小号、`selfId`、`dbDir`、目标 chats；
4. 启动 `world-wechat-test` profile；
5. 先只测试文字/图片/表情，不自动群发；
6. 通过后再移植世界控制台补丁到 0.5.6。

## 风险

```text
微信原生桥不是官方 API
账号可能被限制或封禁
仅建议家庭群、低频使用
```

## 相关文件

```text
C:\<工作目录>\backups\artifacts\dsh-world-0.5.6-patched.tgz
C:\Users\<用户名>\.dsh\profiles\world-wechat-test
C:\Users\<用户名>\.dsh\profiles\world-wechat-test\wechat-config.template.json
```
