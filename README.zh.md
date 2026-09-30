# dsh-plugin-ollama-usage

[English](README.md) | 中文

在 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的 Web 对话页显示 **Ollama Cloud 账户用量**
（5 小时滚动窗口 / 每周），并提供一份 `baseURL` / 凭据模式的配置。

## 功能

- 在活动会话输入框下方与新会话（hero）页各显示一条面板，两处内容相同。
- 同时给出 `session`（5 小时滚动）与 `weekly` 两个窗口的占比，默认每 5 分钟刷新一次。
- 只读账户用量：不改动任何 provider 配置，也不发起对话。
- 支持复用现有 Ollama 密钥或使用插件专属密钥两种模式。
- 凭据缺失、端点不提供用量或响应异常时，面板静默消失，不留占位符、不报错。

## 安装

要求：带 `web` profile 的 dsh（实测 `0.2.0-rc.1`）、Node `^22.19.0 || >=24.0.0`，以及一个可用的 Ollama Cloud API key。

本包是 dsh bundle，安装即把 bundle 追加进 profile 并应用它的 patch 层。

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-ollama-usage
```

### 从本地目录安装

```bash
git clone https://github.com/CJ-SH/dsh-plugin-ollama-usage
dsh plugin --profile web add ./dsh-plugin-ollama-usage
```

### `link:` 安装额外一步

`link:` 安装的插件在 profile 之外，需要把 profile 的安装闭包链进包内（幂等；materialized 安装不需要）：

```bash
npm run link-imports
```

**不要**用 `npm install` 装 peer `@deepseek-ai/schemastery`，拷贝会破坏模块同一性。

插件在启动时加载，安装后请重启 dsh；`dsh --profile web --dump-config | grep ollama-usage` 可预检。

## 使用

面板出现在活动会话的输入框下方与新会话（hero）页：

```
活动会话 · 输入框下方     session 26% · weekly 6%
新会话（hero）            同一条面板
配置                      baseURL / 凭据模式 / 密钥
```

配置入口是设置里的「Ollama 用量」页（插件注册的 Settings 页；装了 suite hub 时并入 hub 面板），
也可以直接编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里 `- id: ollama-usage` 的 `config:` 段
（字段 `baseURL` / `credentialMode` / `apiKeyEnv`）。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-ollama-usage
```

## 技术说明

- 凭据两种模式：**凭据模式**（`reference`，默认）复用已有 `apiKeyEnv`（默认 `OLLAMA_API_KEY`），本插件不能写入；**密钥模式**（`direct`）只写自己的引用 `OLLAMA_USAGE_API_KEY`。
- 用量端点目前只返回窗口名、不含重置时间戳，面板按滚动口径显示（每 5 小时 / 每 7 天 / 每 30 天重置）；端点将来返回 `resets_at` 时会自动改为绝对时间。
- 席位与容器是 dsh 内部契约，dsh 升级可能移动它们；面板不显示本身就是失败模式（不渲染占位符、不报错）。
- 设置与凭据在卸载后保留，需要时手动清理 profile patch 里的 `- id: ollama-usage` 段。

## 深入阅读

契约、排障与内部结构见 [docs/design-notes.md](docs/design-notes.md)。

## License

MIT © 2026 HenTaiCJN

Ollama 是 Ollama Inc. 的产品；本插件与它没有隶属关系，只调用其公开 API。
