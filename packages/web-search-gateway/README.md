# 网页搜索网关

`@onlyfeng/dsh-web-search-gateway` 从 `0.2.0` 起使用带命名空间的包名。公开仓库已于 2026-11-21 以干净历史重建，旧版本及其固定提交不再提供；升级时保留现有网关配置与搜索 provider 即可。

`ctx.web` 的网关搜索 provider：让 dsh 的 `web_search` 走**模型网关自己的服务端搜索工具**（OpenAI Responses 的 `web_search`、Anthropic Messages 的 `web_search_20250305`），而不是 DeepSeek 的 Search API。许多自建/第三方网关只代理 `/messages`、`/responses` 这类聊天端点，没有 DeepSeek 专属的 `/v1/tools/search` 路由。

## 为什么需要它

dsh 自带的两个 search provider 都有各自前提，网关没满足时就用不了：

| 自带 provider | 前提 | 网关只有 Messages/Responses 时 |
|---|---|---|
| `deepseek-search-api` | 网关实现 DeepSeek 的 `/v1/tools/search` | 404 |
| `deepseek-official`（走 Messages 原生搜索） | 网关接受 `thinking:{type:'disabled'}` | 部分模型拒绝该模式（要求 adaptive 或网关自定义的其它 thinking 模式），且该字段写死不可配置 |

本插件把 thinking 模式、模型、工具选择策略都做成配置项，补上这一层。

## 两个 provider

| id | 协议 | 请求 | 来源解析 |
|---|---|---|---|
| `<idPrefix>-responses` | OpenAI **Responses** | `POST {baseURL}/responses`，`tools:[{type:web_search}]` | `output_text.annotations[].url_citation` 与 `web_search_call.action.sources[]` |
| `<idPrefix>-messages` | Anthropic **Messages** | `POST {baseURL}/messages`，`tools:[{type:web_search_20250305}]` | `web_search_tool_result` 块里的 `web_search_result` |

已完成的检索可以返回空来源列表。Messages 网关若保留成功结果块但省略来源内容，也可以返回摘要和空列表。模型正文中的链接不会计入结构化来源。网关若只返回搜索调用意图，或只返回失败的工具结果，插件会报错，即使 HTTP 状态为 200。

每次搜索是独立的辅助模型请求，不继承对话模型路由。模型负责搜索词选择、检索取舍与答案组织，可按实测质量、工具支持、成本和延迟选型。

## 配置

`baseURL`/`baseURLEnv` 没有默认值：网关地址是部署特有的信息，不适合硬编码一个默认值。其余字段都有合理默认，按需覆盖。

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | 无 | 网关 base 的字面值，含版本路径；操作名由插件追加（如 `{baseURL}/responses`）。与 `baseURLEnv` 二选一，必须且只能配一个 |
| `baseURLEnv` | 无 | 存放网关 base 的环境变量**名**，与 `baseURL` 二选一。读取的是 DSH 进程环境；修改系统环境变量后通常需要重新启动 DSH |
| `baseURLPath` | 空字符串 | 在字面值或环境变量的地址后追加路径，例如变量为 `https://gateway.example.com/api` 时设为 `/v1`。已经含 `/v1` 的地址应留空，避免重复 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用，经 `ctx.credentials` 解析，回退到进程环境变量 |
| `responsesModel` | `gpt-4.1` | Responses 路由上执行搜索的模型 |
| `messagesModel` | `claude-3-5-sonnet-latest` | Messages 路由上执行搜索的模型 |
| `idPrefix` | `gateway` | provider id 前缀，profile 用它 pin 具体 provider（如 `gateway-responses`） |
| `responsesToolType` | `web_search` | 老网关/兼容层可能要改成 `web_search_preview` |
| `responsesToolChoice` | `required` | 部分网关拒绝 `required`，可改 `auto` |
| `messagesThinking` | `omit` | `omit` 不发该字段；`enabled` 发 `{type:'enabled', budget_tokens}`；`disabled` 发 `{type:'disabled'}`；其它字符串原样作为 `type` 发送（用于网关自定义扩展） |
| `messagesThinkingBudgetTokens` | `4096` | `messagesThinking: enabled` 时的 `budget_tokens` |
| `messagesMaxTokens` / `messagesMaxUses` | `4096` / `5` | Messages 请求的输出上限与单次最大搜索次数 |
| `maxResponseBytes` | `2097152` | 网关响应解压后的字节上限，包含分块传输；超限终止读取 |
| `maxSources` / `maxSummaryChars` | `100` / `32768` | 返回来源数和摘要长度上限，发生截断时设置 `truncated` |
| `timeoutMs` | `120000` | 单次搜索超时（毫秒） |

**`messagesThinking` 怎么选没有通用答案**：哪种模式被接受，取决于网关和模型的具体实现，不同厂商、不同模型差异很大。建议顺序：先用默认的 `omit` 试；网关报错提示需要显式启用思考，就试 `enabled`；报错提示要求某个自定义模式名，就把该模式名原样填进 `messagesThinking`。把你验证过的组合记在自己的 profile 配置旁，供同事复用。

## 从旧包升级

安装前记下正在使用的搜索 provider，并备份当前 profile 的插件设置。先停用旧组合包，再启用新包。它们都使用 `web-search-gateway` 行 ID 和已有的 `idPrefix`。以行 ID 配置的网关地址与凭据引用可继续使用。若本地覆盖显式指定了旧模块 `name`，将该引用改成 `@onlyfeng/dsh-web-search-gateway`。

在新包已接管该行后运行一次 `web_search`，确认当前 provider 返回摘要和来源，再移除旧包。切换失败时停用新包，重新启用备份记录中的旧版，并复查同一个 provider。若切换失败，按备份恢复原组合包；重建后不再提供旧版本固定提交。插件管理器提示需要重启时，在重启后复查实际搜索结果。

## 安装

在插件市场添加 `https://onlyfeng.github.io/dsh-plugins/market.json` 后，选择「网页搜索网关」，在确认框核对仓库、版本、提交和子目录。通过 CLI 安装时，将 `<sha>` 换成市场列出的完整 Git 提交。

```sh
dsh plugin --profile <profile> add "git+https://github.com/onlyfeng/dsh-plugins.git#<sha>&path:/packages/web-search-gateway"
```

安装后，bundle 的 `cordis.patch.yml` 会插入一个**禁用**的 `web-search-gateway` 行（没有 `baseURL` 时插件会在加载时报错退出，所以默认先插入禁用状态，避免装上就炸）。在你自己 profile 的 `cordis.patch.yml` 里补一层覆盖，填上网关信息并启用：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: gateway-responses   # 或 gateway-messages，取决于你的网关支持哪种协议
    fetchProvider: http
- id: web-search-gateway
  disabled: false
  config:
    baseURL: https://your-gateway.example.com/api/v1
    apiKeyEnv: YOUR_GATEWAY_API_KEY
```

或者用环境变量引用网关地址（例如与聊天用的同一个网关变量共享）：

```yaml
- id: web-search-gateway
  disabled: false
  config:
    baseURLEnv: YOUR_GATEWAY_BASE_URL_VAR   # 变量值例如 https://gateway.example.com/api
    baseURLPath: /v1
    apiKeyEnv: YOUR_GATEWAY_API_KEY
```

`baseURLEnv: YOUR_GATEWAY_BASE_URL_VAR/v1` 不会执行变量替换；路径须单独配置。字面值和环境变量引用同时设置会报错。安装或更新是否需要重启，以插件管理器返回的应用状态为准；支持 HMR 时可直接应用。

## 验证

重启后在设置页「Web 搜索与抓取」里应能看到 `Gateway web search (Responses)` / `Gateway web search (Messages)`；或直接让 Agent 调用 `web_search` 工具触发一次搜索。失败时会显示 HTTP 状态码或预定义错误类型。协议细节可通过受控的网关日志核对。远程网关使用 HTTPS，本机回环开发服务可以使用 HTTP。

## 已知限制

- 每次搜索都是一次完整的模型调用，有时延和 token 成本，不是免费的本地操作。
- 只实现 search；fetch 继续用本地 `http` provider（`web_fetch` 本身不需要经过模型网关）。
- Responses 的 `open_page`/`web_fetch` 服务端动作只能拿到模型写的摘要而非页面原文，因此没有做成 fetch provider——这类能力留给专门的 fetch provider 实现。
- `messagesThinking` 的可用取值因网关而异，本插件不能穷举所有网关的要求，需要自行试探。
