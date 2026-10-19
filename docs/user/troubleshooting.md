# 常见问题与排障

先确认问题发生在哪个工作区、机器人、聊天或 Topic，以及是模型运行、任务执行还是消息交付失败。不要因为没有回复就连续重发可能写入外部服务的请求。

## 管理员的基础检查

在原部署目录运行，命令不会修改服务配置：

```sh
docker compose ps
curl --fail http://localhost:3000/healthz
curl --fail http://localhost:3000/readyz
docker compose logs --tail=100 app worker
```

检查日志时间和面板当前状态，历史错误不代表问题仍在。分享诊断时提供版本、时间、任务引用和脱敏错误信息，不提供 `.env`、Token、密码或完整私聊内容。

## 机器人不回复

| 现象 | 检查与处理 |
| --- | --- |
| Setup 提示未激活 | 聊天模型、Telegram 接收器、已启用发布技能是否就绪 |
| 显示 Request access | 尚未成为活跃成员，用邀请加入或等待申请审批 |
| 面板可开但 `/readyz` 失败 | 检查 worker、数据库、迁移和 polling 状态 |
| 私聊正常，群里不回复 | 关联群、成员身份、Topic、隐私模式；改用 `/ask@your_bot` 或 Reply |
| 已收到请求但迟迟未完成 | `/status` 定位排队、运行或等待输入，查看 Runs & delivery |
| 看不到原生预览 | 群组和定时任务只发送最终回复；短私聊可能直接完成 |
| 旧任务按钮无效 | 使用最新消息上的按钮，或直接发送 `/status` |

### Polling 冲突

- `polling_webhook_conflict`：同一个 Bot Token 已有 webhook，先按 [部署指南](deployment.md) 明确切换。
- `telegram_polling_conflict`：另一个实例正在 polling，停止重复实例。
- `telegram_unauthorized`：检查 Bot Token 和机器人身份。
- 限流：等待 Telegram 指定的重试间隔，避免不断重启。

polling 不会自动删除 webhook。更换传输方式后同时重新创建 app 和 worker。

## 模型、预算和附件

**供应商保存失败**：核对 Base URL、API Key、模型列表接口和服务器网络。Docker 内不能用 `localhost` 指代宿主机。URL 变化时需重新输入 Key。

**模型列表正常但聊天失败**：模型还需支持流式 Chat Completions、工具调用和应用使用的参数；Codex 使用 Responses。检查推理强度是否受支持，详见 [模型与配置](configuration.md)。

**预算不足或价格缺失**：检查单次/月度上限、模型价格和未确认费用。有限预算需要价格；留空预算是不设限，`0` 仅允许零费用调用。先向供应商核对账单，再由管理员处理未知费用。

**超时**：普通运行默认 300 秒。检查模型延迟或推理设置；必要时调整 `RUN_TIMEOUT_SECONDS`，重新创建服务。调整不会自动重试旧失败，也不会延长 Codex 的任务授权范围。

**图片或文件无法处理**：核对 [格式与大小限制](telegram-experience.md)，图片需视觉模型。扫描 PDF 可改发图片；不支持的文档可转成 UTF-8 文本，不发送秘密信息。

## GitHub 连接和权限

| 现象 | 检查与处理 |
| --- | --- |
| 已授权但没有仓库 | 同时完成 App installation，选择仓库并返回连接；用户授权不等于安装 |
| GitHub 提示 redirect_uri | 核对站点 origin 和回调，保持同一浏览器会话，从 Connect GitHub 重新开始 |
| 新仓库没出现 | 在 GitHub 授予后，重新授权并选择；不会自动扩展工作区范围 |
| 成员显示 Verification pending | 本人私聊 `/github`，浏览器授权后返回 Telegram 确认 |
| Codex 要求连接账号 | 私聊完成 `/github`，确认当前写权限，再重发请求 |
| `github_app_permissions_missing` | 在 GitHub 修改 App 权限并接受 installation 更新；仅重连无效 |
| 权限暂时无法验证 | 等待同步或 `/github sync`；失效则 `/github connect`；不要新建重复任务 |

普通成员或工作区管理员不自动拥有 GitHub 写权限。私有仓库的交互请求在私聊进行。详细步骤见 [GitHub](github.md)。

## Code Truth 没有代码结果

确认服务容器存在、插件已启用、仓库已配置，点击 **Sync & check indexes**。首次构建可能尚未完成；就绪后核对默认分支、commit 和索引时间。

索引是快照，刷新失败可能保留旧版本。PR/Issue 实时状态使用 GitHub 查询，不依靠源码索引。修改 `.env` 的服务连接后需重新创建 app/worker。

## Codex 或 Review Bot 不工作

确认 runner 健康、任务镜像已单独构建、插件启用且模型认证有效。**Enabled** 不代表执行环境安装完毕。

登录暂停由管理员在 Codex 页面重新认证。任务默认分支不存在时，在 GitHub 修正；错误仓库不要靠改默认分支解决。取消的历史任务不会仅因权限恢复就自动重启。

**仓库目标无法验证**：这可能是助手传入的仓库名称与原始请求不一致，不代表 GitHub 连接故障。明确原始请求中的目标仓库；等待或重新连接无法修复名称校验错误。

**Codex 报告 sandbox 无法启动**：模型可能已正常回复，但读取源码的命令被执行环境阻止。管理员应检查 runner 与任务镜像版本；普通任务使用兼容容器的只读隔离，PR 审查的额外凭据保护仍要求执行环境支持。修复环境后查看原任务状态，再决定是否继续；不要据此修改 GitHub 权限。

服务器重新启动后，服务恢复和任务恢复是两个步骤。新版本创建的开发任务会在确认基础设施中断后显示恢复状态，验证当前权限、保留工作区并继续检查。管理员可查看原任务状态；无需为等待恢复重复提交请求。权限撤销、保留期届满或无法确认启动结果会阻止续跑，发布结果未知仍需先核对 GitHub。

Review Bot 额外检查 HTTPS webhook、secret、事件订阅和 GitHub delivery。自动审查跳过草稿 PR；明确请求的修复需启用并满足写权限，fork PR 仅支持审查和问答。

**View conversation** 打不开时，检查 BotFather Main Mini App 的 `/mini` URL，从 Telegram 重新打开以刷新身份。私聊记录只向原发起人开放，群记录还需当前群成员和来源权限；过期来源或旧任务也可能限制可见内容。

## 结果未知、交付失败和重复风险

`delivery_unknown` 表示 Telegram 可能已接收；GitHub/Cloudflare 的 unknown 同样表示可能已产生效果。先查看对应聊天、仓库或控制台，保留原任务引用。

应用不会自动重复未知写入。管理员在 Runs & delivery 核对交付、在 Usage 核对费用；确认后再决定是否创建新请求。取消不能撤回已有远端结果。

## 升级或恢复后异常

检查磁盘、迁移结果、镜像版本一致性、Compose 项目名以及是否沿用原密钥和数据卷。不要重新生成密钥、删除卷或直接回退数据库。按 [备份与恢复](maintenance.md) 核对后再恢复写入。
