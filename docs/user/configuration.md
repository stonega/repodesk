# 模型与配置

RepoDesk 的聊天、Codex 开发和 Review Bot 审查可以选择不同模型。供应商由部署管理员统一添加，各工作区保存自己的选择。

## 添加模型供应商

在 **Model settings → Model providers → New** 填写名称、供应商类型、Base URL 和 API Key。

- Base URL 通常包含 API 前缀，例如 `https://api.openai.com/v1`，应使用供应商实际提供的地址。
- 保存时会获取模型列表；失败时编辑器保留输入，可以修正后重试。
- Key 加密保存，只显示是否已配置。编辑同一地址时留空保留原 Key；更换地址需要重新输入。
- Docker 内的 `localhost` 指容器本身。宿主机模型服务需使用 worker 能访问的地址。
- 正在使用的供应商不能直接删除，先更换各服务的模型选择。

模型列表可读取，只能说明发现接口可用；还需确认模型支持实际使用的推理协议。

## 为服务选模型

| 服务 | 选择位置 | 需要的能力 |
| --- | --- | --- |
| Telegram 聊天 | Model settings 的聊天模型设置 | 流式 Chat Completions、工具调用、`max_completion_tokens`、`store:false` |
| 图片理解 | 同一聊天模型 | 在聊天能力之外支持图片输入 |
| Codex 开发 | Plugins → Codex → Configuration → Edit | Responses 兼容模型，或独立的 ChatGPT device code 登录 |
| Review Bot | Plugins → Review Bot → Configuration → Edit | 继承 Codex 或选择独立 Responses 模型；修复使用 Codex 模型 |

首次配置后用小请求验证。ChatGPT 登录与模型 API Key 是两种独立认证方式，不会授予 GitHub 权限。

## 聊天网页搜索

在 **Model settings → Search providers → New** 添加搜索供应商：

- **DuckDuckGo (free)**：免费，不需要 API Key。使用公开搜索结果页，可能遇到限流或验证而暂时不可用。
- **DeepSeek**：填写 DeepSeek API Key，使用官方 Search API。
- **Exa**：填写 Exa API Key。

供应商可供同一部署管理员的工作区复用；Key 加密保存且不会回显。
编辑同一类型的供应商时，Key 留空保留原值；切换到另一种付费类型需要重新填写。
保存凭据不会发起搜索，也不验证余额或配额。

在 **Bot chat model → Edit → Search provider** 选择已添加的供应商，
或选择 **Disabled** 关闭搜索。保存后，聊天模型可按需要调用 `search_tool`
查询公开网页，并引用结果链接。首次配置默认关闭，Codex 和 Review Bot 不受此选项影响。
每次搜索最多返回 10 条带标题、链接和摘要的结果，查询最长 128 个字符。
搜索结果是外部参考资料，不会授予操作权限；不要把密钥或私密对话交给搜索供应商。

DeepSeek、Exa 的搜索请求费用由供应商单独计费，不计入模型 token 预算或 Usage 金额。
替换供应商凭据或更改聊天模型设置会使使用旧配置的运行停止。
删除正在使用的供应商前，先在各工作区切换供应商或关闭搜索。

## 推理强度、容量和价格

聊天模型的 **Advanced model settings** 提供推理强度、上下文和最大输出容量、输入输出及缓存价格覆盖。

推理强度的非 `off` 值会发送为 `reasoning_effort`，选择供应商支持的值。`off` 表示不发送该参数，不保证关闭模型默认推理。

容量和价格可能来自供应商或内置目录，界面区分自动信息与手动覆盖。代理和自定义模型的实际限制可能不同，以供应商说明为准。清空上下文容量覆盖后，由供应商执行限制。

价格用于应用内估算，不等同于供应商账单。缺少价格的模型可以在无限预算下记录 token；有限预算要求有可用价格。填写 `0` 表示明确的零价格。

## 工作区预算与保留

在 **Overview** 的工作区编辑器调整时区、保留期限、单次和月度 USD 预算。

- 预算留空为 **None**，表示不设金额上限；`0` 仅允许零费用请求。
- 未确认费用继续占用预留预算，直到管理员核对。
- 保留期限影响历史、记忆和任务来源，不会让 Telegram 提供更早历史。
- 设置主要影响后续运行；已开始的工作可能使用开始时的配置。更换供应商等变更也可能使旧运行停止。

普通聊天费用、Codex 供应商费用和 ChatGPT 账号限制分别管理。不要把聊天费用总额当作全部外部服务账单。

## 查看用量

面板 **Usage** 展示用量和预留费用，Telegram 的 `/usage` 提供摘要。也可以在私聊询问“本月我的模型费用是多少？”或“把今天的费用按模型拆分”。

自然语言费用查询需要已启用技能允许费用查询工具；新建工作区的起始技能已包含。普通成员查询自己的费用，owner/admin 可查询工作区合计和剩余月度预算。

“今天”和“本月”按 UTC 统计；查询只覆盖仍保留的账务记录，最多九十天。回答会区分已结算、预留和未知金额，不包含生成这条回答随后产生的费用。它是应用内记录，不是供应商账单。后台记忆整理可能继续增加原请求费用。

## 环境变量

模型和机器人凭据通常在面板填写。常用部署选项如下：

| 变量 | 默认值或作用 |
| --- | --- |
| `POSTGRES_PASSWORD` | 必填，数据库密码，建议随机十六进制字符串 |
| `PUBLIC_ORIGIN` | `http://localhost:3000`；公开部署改为完整 HTTPS origin |
| `APP_PORT` | `3000`，宿主机回环监听端口 |
| `ENCRYPTION_KEY_FILE` | `./secrets/encryption-key`，Compose 使用的加密密钥文件 |
| `TELEGRAM_TRANSPORT` | `webhook`；快速开始使用 `polling` |
| `RUN_TIMEOUT_SECONDS` | `300`，普通助手单次时限，范围 `1–1800` 秒 |
| `COMPOSE_FILE` | 基础文件和可选服务叠加文件 |
| `CODEX_RUNNER_CONCURRENCY` | `4`，runner 并发任务数，范围 `1–32` |
| `CODEX_RUNNER_CPUS` | `2`，Codex 任务 CPU 设置 |
| `CODEX_RUNNER_MEMORY_MB` | `4096`，Codex 任务内存设置 |
| `CODEX_RUNNER_RETENTION_HOURS` | `24`，runner 工作数据保留设置 |

修改 `.env` 后使用 `docker compose up -d` 重新创建受影响服务；单纯 `restart` 不会加载新的容器环境。`RUN_TIMEOUT_SECONDS` 不是 Codex 持续任务的总时长上限。

完整配置见 [Code Truth](code-truth.md)、[Codex](codex.md) 和 [维护指南](maintenance.md)。
