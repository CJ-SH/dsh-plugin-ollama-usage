# dsh-plugin-ollama-usage

Ollama Cloud 账户用量，显示在 Web 对话页的三个位置：

| 位置 | 席位 |
|---|---|
| 活动会话输入框下方 | `conversation.composer.dock`（id `ollama-usage`, order 1） |
| 新会话（hero） | `shell.overlay`（id `ollama-usage-hero`, order 1） |
| 设置 → 插件 → 插件配置 | `settings.plugin.item`（key `ollama-usage`） |

配置完全由本插件自己持有：设置命名空间 `ollama-usage`（`baseURL` / `credentialMode` / `apiKeyEnv`），
密钥经官方凭据 seam 存取。

## 两个凭据模式

| 模式 | 密钥来源 | 本插件能否写入 |
|---|---|---|
| **凭据模式**（默认） | 复用已有 `apiKeyEnv`（默认 `OLLAMA_API_KEY`） | **不能** —— Host 半根本没有接受外部引用名的写入接口 |
| **密钥模式** | 本插件专属引用 `OLLAMA_USAGE_API_KEY` | 只能写它自己 |

写入接口（`credential/set` / `credential/unset`）**不接受 ref 参数**，物理上无法覆盖某个提供方
共用的 `OLLAMA_API_KEY`。

## 取数

`GET {baseURL}/api/usage` + `Authorization: Bearer <key>`。`baseURL` 填 `https://ollama.com`
或 `https://ollama.com/api` 都可以（原生 API base 以 `/api` 结尾，代码会补齐）。

端点 404 → 视作"该端点不提供用量"，静默；非 2xx / JSON 非法 / 未配置凭据 → 同样静默（不渲染、不报错）。

响应目前只带 `session`（5 小时滚动）与 `weekly`，且**不含任何重置时间戳**，因此面板显示滚动口径
（「每 5 小时重置 / 每 7 天重置 / 每 30 天重置」）；若端点将来返回 `resets_at`，代码会自动改显示绝对时间。

## 安装

```powershell
dsh plugin --profile web add D:\project\dsh\dsh-plugin-ollama-usage
dsh --profile web --dump-config      # 预检：应出现 id: ollama-usage 的行
```

安装后需**重启 dsh**（`dsh web`）才会加载。卸载：

```powershell
dsh plugin --profile web remove dsh-plugin-ollama-usage
```

设置与凭据是用户数据，卸载后保留；不需要时手动清理 `settings.yaml` 里的 `ollama-usage` 段
（本插件不会写入任何凭据，除非你显式使用密钥模式）。

## 结构

```
lib/index.js    Host 半：设置命名空间、凭据 seam、/usage 取数、私有 RPC 通道
lib/client.js   Client 半：三处 UI（module-loader bundle 形式，仅依赖基线 react）
test/host.test.mjs    自检：注册、信封、凭据边界、空态（24 条断言）
test/client.test.mjs  自检：席位、样式生命周期、跨半边契约（27 条断言）
cordis.patch.yml  安装时合入 profile 的 loader 行
```

**无构建步骤、运行时零外部依赖**：Host 半不 import 任何 `@deepseek-ai/*`（设置 schema 用
`dsh-settings` 实际消费的可调用对象 + `toJSON()`），Client 半只 `require('react')`（平台基线）。

## 自检

```powershell
npm test        # 两个 harness，共 51 条断言，无需测试框架
```

- **host.test.mjs**：用假 cordis ctx 挂载 Host 半并断言行为 —— 注册的命名空间与通道、
  `config/read` 信封与端点推导、**凭据写入边界**（凭据模式零写入、密钥模式只写
  `OLLAMA_USAGE_API_KEY`）、四类空态（无凭据服务 / 未配置 / 404 / 非 JSON）、错误信息不含密钥，
  以及"不 import 任何 `@deepseek-ai/*`"。
- **client.test.mjs**：通过假 `window.__ModuleLoader__` 加载真实 bundle 并挂载到假 ctx —— 断言
  三个席位（**槽名与 id/key 分离**，这正是原型期踩过的坑）、order、样式标签的注入与回收、
  以及**跨半边契约**（客户端调用的每个 endpoint 在 Host 都有 `case`，通道名与命名空间两边一致）。
