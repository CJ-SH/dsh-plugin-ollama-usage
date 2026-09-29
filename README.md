# dsh-plugin-ollama-usage

在 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的 Web 对话页显示 **Ollama Cloud 账户用量**
（5 小时滚动窗口 / 每周），并提供一份 `baseURL` / 凭据模式的配置。

```
活动会话 · 输入框下方     session 26% · weekly 6%
新会话（hero）            同一条面板
配置                      baseURL / 凭据模式 / 密钥
```

它只读一个端点（`GET {baseURL}/api/usage`）：不改任何 provider 配置、不发起对话；
没有可用凭据或端点不提供用量时，面板静默消失，不留占位符。

## 你会看到什么

| 位置 | 席位 |
|---|---|
| 活动会话输入框下方 | `conversation.composer.dock`（id `ollama-usage`, order 1）——**同排由壳负责**：dsh ≥ `0.1.6-alpha.2` 给该席位一个居中的 `flex; gap:12px` 行，本插件的 entry 只是普通流式项，与内置 stats / context 胶囊自动同行；旧版该席位是纵向列，同一份 DOM 自动降级为"自家居中一行" |
| 新会话（hero） | `conversation.input.dock`（id `ollama-usage-hero`, order 1，输入卡片上方那行；与 statusline 的任务 pill 同行） |
| 配置 | 见下方「配置住在哪里」——**dsh 0.2 起不再是 `settings.plugin.item`** |

面板同时显示两个窗口，各自带占比；数据默认每 5 分钟刷新一次。

**本插件不测量、不定位**（2026-09-21 起）：dock entry 没有任何坐标、观察者或版本探测；
`conversation.composer.dock` 的排列完全交回壳，`conversation.input.dock` 那行只用一条
`[data-slot="conversation.input.dock"]{display:flex !important; flex-flow:row wrap; …}` 把座位锚点
从内联 `display:contents` 改成换行行（`!important` 不可省），其余照旧。

## 要求

| | |
|---|---|
| **dsh** | 带 `web` profile 的 dsh；实测 **`0.2.0-rc.1`**（配置模型见下方「配置住在哪里」；`0.1.6-alpha.2` 时代的 dock 行为仍在，`0.1.5-rc.2` 下 composer.dock 退化为自家一行）。席位与容器都是内部契约，dsh 升级可能移动它们 |
| **Node** | `^22.19.0 || >=24.0.0` |
| **Ollama Cloud 账号** | `/api/usage` 需要可用的 API key，见下面的两种模式 |

## 安装

本包是 dsh **bundle**：声明 `dsh.bundle` + `cordis.patch.yml`，安装即把 bundle 追加进 profile 并应用它的 patch 层
（[官方指南](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)）。

从仓库安装（npm 尚未发布；发布后命令相同，只是把路径换回包名）：

```bash
git clone https://github.com/CJ-SH/dsh-plugin-ollama-usage
dsh plugin --profile web add ./dsh-plugin-ollama-usage
```

或者直接用 git URL（不必自己 clone）：

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-ollama-usage
```

`lib/` 是仓库里的纯 JavaScript，没有构建步骤，所以 git 安装拿到的就是可运行的产物。

### `link:` 安装额外一步：`npm run link-imports`

Host 半从 0.2 起需要 **schemastery**（`Config` 必须是真正的 schemastery schema，见下）。
`link:` 安装的插件位于 profile 之外，Node 的父目录回溯到不了
`$DSH_HOME/profiles/node_modules`，因此这个 peer 会以 `ERR_MODULE_NOT_FOUND` 让整行加载失败。
把 profile 已维护的安装闭包链进包内即可（幂等；materialized 安装不需要）：

```bash
npm run link-imports     # 链接 @deepseek-ai/schemastery -> $DSH_HOME/profiles/node_modules/…
```

**不要**用 `npm install` 装这个 peer：拷贝会解析成功但破坏模块同一性，`Config` 必须是
设置服务所内省的那一个 schemastery 实例。

然后预检并**重启 dsh** —— 插件在启动时加载，而重启会结束 agent 进程，请自己执行：

```bash
dsh --profile web --dump-config | grep ollama-usage
```

### 卸载

```bash
dsh plugin --profile web remove dsh-plugin-ollama-usage
```

## 配置住在哪里（dsh 0.2 起）

0.2 删除了 `ctx.settings.register(ns, schema)` 与 `settings.yaml`。取而代之的契约是：

- **命名空间就是 loader row id**：本包的 `cordis.patch.yml` 插入 `- id: ollama-usage`，
  `settings.update("ollama-usage", …)` 与 `settings.describe()` 的 `ns` 都是这个字符串。
- **schema 就是 Host 半导出的 `Config`**：`baseURL` / `credentialMode` / `apiKeyEnv` 三个字段，
  默认 `https://ollama.com` / `reference` / `OLLAMA_API_KEY`，**每个字段都 `.volatile()`** ——
  没有 volatile 字段的 entry 会被 `describe()` 整个跳过，写入也会被拒绝
  （`Plugin entry "ollama-usage" has no volatile fields`）。
- **值存放在 profile patch**：`~/.dsh/profiles/<profile>/cordis.patch.yml` 的
  `- id: ollama-usage` / `config:` 段。插件自身的保存路径（`config/save`）就是写这里；
  手改这个文件在 HMR 下同样生效。
- 因此「Settings → 插件 → 插件配置」的 **`settings.plugin.item` 席位在 0.2 已不存在**
  （0.2 只有 `settings.section`）。本包的浏览器半仍在等待那个已删除的席位，**配置卡片暂不可见**；
  在此之前请用官方 Plugins 行页，或直接编辑上面的 profile patch 段。

> 这也解释了本包为什么不再「零 `@deepseek-ai/*` 依赖」：0.1.x 的取舍是把一个手搓的
> callable + `toJSON()` 交给 `settings.register`，而 0.2 的设置服务要求真正的 schemastery
> schema（`volatileForm()` 读 `schema.meta.volatile`，`schema(entry)` 要求 `toJSON`），
> 手搓形状不再可能通过。于是只引入 **`@deepseek-ai/schemastery`** 这一个 peer，
> 与同工作区的 `dsh-plugin-web-search` 采用同一套机制。

## 凭据：两种模式

配置完全由本插件自己持有：row id（即设置命名空间）`ollama-usage` 的
`baseURL` / `credentialMode` / `apiKeyEnv`，密钥经官方凭据 seam 存取。

| 模式 | 密钥来源 | 本插件能否写入 |
|---|---|---|
| **凭据模式**（默认） | 复用已有 `apiKeyEnv`（默认 `OLLAMA_API_KEY`） | **不能** —— Host 半根本没有接受外部引用名的写入接口 |
| **密钥模式** | 本插件专属引用 `OLLAMA_USAGE_API_KEY` | 只能写它自己 |

写入接口（`credential/set` / `credential/unset`）**不接受 ref 参数**，物理上无法覆盖某个提供方共用的
`OLLAMA_API_KEY`；密钥只在 Host 侧读取，从不回传给浏览器，错误信息里也不含密钥。

## 取数口径

`GET {baseURL}/api/usage` + `Authorization: Bearer <key>`。`baseURL` 填 `https://ollama.com` 或
`https://ollama.com/api` 都可以（原生 API base 以 `/api` 结尾，代码会补齐）。

端点 404 → 视作「该端点不提供用量」，静默；非 2xx / JSON 非法 / 未配置凭据 → 同样静默（不渲染、不报错）。

响应目前只带 `session`（5 小时滚动）与 `weekly`，且**不含任何重置时间戳**，因此面板显示滚动口径
（「每 5 小时重置 / 每 7 天重置 / 每 30 天重置」）；若端点将来返回 `resets_at`，代码会自动改显示绝对时间。

## 不碰别人的行

patch 只插入自己的一行。Host 半在组合的 `webServer` 上注册**自己的路由**（`POST /ollama-usage/<endpoint>`），
每个请求先问组合的 `connection.requestRejection`（`401`/`403` 逐字回写；缺这个 seam 时 `503` 拒绝服务）——
与 shipped `dsh-host-open-in-app` 同一套形状。

早期版本靠拓宽 shipped `connection` 行的 `inject` 让 `connection.rpc.handle` 能注册通道；那会让本插件的
可用性依赖别的 bundle 的配置与层序，自有路由没有这个耦合。

## 数据保留

设置与凭据是用户数据，卸载后保留；不需要时手动清理 `~/.dsh/profiles/<profile>/cordis.patch.yml`
里的 `- id: ollama-usage` 段（0.2 起没有 `settings.yaml` 了；本插件不会写入任何凭据，
除非你显式使用密钥模式）。

## 结构

```
lib/index.js    Host 半：Config 声明、凭据 seam、/usage 取数、自有的 /ollama-usage 路由
lib/client.js   Client 半：三处 UI（module-loader bundle 形式，仅依赖基线 react）
locale/{zh,en}.json  插件卡片/清单的显示文案（{"meta":{"title","description"}}）
icon.svg       清单里的图标（`package.json` 顶层 `icon`）
tools/link-imports.mjs  `link:` 安装时把 schemastery 链进包内（见安装一节）
test/host.test.mjs    自检：Config 契约、写路径、栅栏/方法/媒体类型/请求体、信封、凭据边界、空态（71 条断言）
test/client.test.mjs  自检：席位、样式生命周期、"无测量"、面板锚点、无死类名、跨半边契约（33 条断言）
test/card.test.mjs    自检：设置卡片（10 条断言）
test/hero.test.mjs    自检：hero 行（6 条断言）
cordis.patch.yml  安装时合入 profile 的 loader 行（不覆盖任何别的行）
```

**无构建步骤**：Host 半只 import 一个 peer —— `@deepseek-ai/schemastery`（0.2 的 `Config` 契约
要求真正的 schemastery schema；详见「配置住在哪里」），Client 半只 `require('react')`（平台基线）。

## 自检

```bash
npm test        # 四个 harness，共 120 条断言，无需测试框架
```

- **host.test.mjs**：用假 cordis ctx 挂载 Host 半并断言行为 —— **Config 契约**（默认值、
  序列化、`volatileForm` / `isVolatilePath` 两条规则的本地复刻、以及"必须是真 schemastery"
  而非手搓形状）、**写路径**（`settings.update` 的 ns 等于 row id、revision 冲突、
  非法 patch 不落盘）、**栅栏最先**（401/403 逐字回写、缺 seam 时 503 fail-closed）与方法/媒体类型/
  请求体校验（405/415/400）、`config/read` 信封与端点推导（含脏值归一化与
  "describe 失败时回落到 row 层"）、**凭据写入边界**（凭据模式零写入、密钥模式只写
  `OLLAMA_USAGE_API_KEY`）、四类空态（无凭据服务 / 未配置 / 404 / 非 JSON）、错误信息不含密钥。
  另有两类**反假绿**守卫：源码（去注释后）里不得再出现 `settings.register` / `installSection`，
  且清单的 peer 区间必须真的匹配运行时——0.2 会**拒绝**区间不满足的 row，而"不声明"则静默放行。
- **client.test.mjs**：通过假 `window.__ModuleLoader__` 加载真实 bundle 并挂载到假 ctx —— 断言
  三个席位（**槽名与 id/key 分离**，这正是原型期踩过的坑）、order、样式标签的注入与回收、
  以及**跨半边契约**（客户端调用的每个 endpoint 在 Host 都有对应分支，路由前缀与命名空间两边一致）；
  并断言**测量路径确已删除**——源码（去注释后）里没有 `ResizeObserver` / `getBoundingClientRect` /
  `data-flow` / 任何测量助手函数，样式表里也没有 `height:0` / `position:absolute` 的 dock 规则。
- **card.test.mjs** / **hero.test.mjs**：设置卡片与 hero 行的渲染、交互与卸载（请求走假 `fetch`）；
  hero 的相位规则（"dock 行挂载时 hero 行不出现"）由后者钉住。

## 故障排查

**面板完全不显示。** 依次排查：凭据不可用（凭据模式的 `apiKeyEnv` 未配置，或密钥模式的引用为空）；
`GET {baseURL}/api/usage` 返回 404 或非 2xx；`baseURL` 填错；dsh 升级移动了席位。
面板不显示占位符、也不报错 —— **不显示本身就是失败模式**。

**整行没激活（插件整个不存在）。** dsh 只会把原因写进启动日志：`1 entry did not activate` /
`TypeError` / `ERR_MODULE_NOT_FOUND`。先看 peer 是否解析得了（`npm run link-imports`），
再看 `credentialMode` 有没有被手改成 `reference` / `direct` 之外的值（`Config` 是 union，
非法值会让这一步直接失败，而不是被静默改写）。

**卡片一直停在「读取中…」。** 说明请求没有拿到答复信封：看 dsh 启动日志里有没有
`[ollama-usage] route unavailable`（路由被别的行占用）或 `trust fence unavailable`（组合里没有
`connection.requestRejection`）。

## License

[MIT](./LICENSE) © 2026 HenTaiCJN

Ollama 是 Ollama Inc. 的产品；本插件与它没有隶属关系，只调用其公开 API。
