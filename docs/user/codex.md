# Codex 开发任务

在 Telegram 中提出明确的修改目标，Codex 会调查代码、实现、检查并在通过后创建可供审查的 PR。补充需求可以继续同一个任务和 PR；查询或解释请求保持只读。

普通聊天可用并不表示 Codex 已准备好。管理员需要配置执行环境、模型认证和 GitHub 连接，成员需要验证 GitHub 写权限。

## 管理员：准备执行环境

下面适用于 [快速开始](get-started.md) 的源码 Compose 部署，使用 Docker runner。如果已经使用 RepoDesk 的专用 VPS 更新器部署了 runner，先检查现有服务，不要再启动一套。

runner 的可信管理容器需要 Docker socket，可以控制宿主机 Docker。使用可信、专用的部署主机；任务容器不获得该 socket，也不接入应用数据库网络。

在仓库根目录构建任务镜像：

```sh
docker build --target codex-job -t localhost/deepx-codex-job:local .
```

生成管理令牌并填入私有 `.env`：

```sh
openssl rand -hex 32
```

```dotenv
CODEX_RUNNER_TOKEN=填写生成的令牌
COMPOSE_FILE=compose.yaml:deploy/codex/compose.yaml
```

已有 Code Truth 时，保留两者：

```dotenv
COMPOSE_FILE=compose.yaml:examples/code-truth.compose.yaml:deploy/codex/compose.yaml
```

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

叠加文件会构建 supervisor 并将内部连接提供给 app/worker，runner 不公开端口。任务镜像单独构建，不能仅靠普通 `up --build` 更新。

默认最多四个活跃任务，每任务资源设置为 2 CPU、4,096 MiB 内存。小服务器可降低并发；设置见 [模型与配置](configuration.md)。保留管理令牌与 `codex_runner_state` 数据卷，不能用新令牌直接替换已有加密状态。任务镜像、supervisor、app 和 worker 应来自同一版本。

## 管理员：连接模型与仓库

1. 在 [GitHub](github.md) 连接目标仓库，确认 App installation 已接受 Contents、Issues、Pull requests 读写权限。
2. 打开 **Plugins → Codex → Configuration → Edit**。
3. 选择已经保存的供应商和 Responses 兼容模型，或选择 **ChatGPT device code**。
4. 使用账号登录时，点击 **Sign in with device code**，在显示的链接输入一次性代码。必要时在 ChatGPT 账号或组织设置允许设备登录，使用 **Recheck connection** 检查状态。
5. 保存并启用插件。确认 runner、任务镜像和模型认证均就绪。

登录在工作区范围保存，不需要复制宿主机 Codex 配置或凭据。API 供应商与 ChatGPT 登录独立；ChatGPT 模式使用其自身 Codex 模型，不使用自定义供应商设置。

仓库默认分支和协作者权限在 GitHub 管理，插件没有额外的仓库列表或维护者名单。Codex 从仓库说明、项目脚本和 CI 发现准备与检查步骤，面板不要求手工填写检查命令。

## 成员：发起任务

先在机器人私聊完成 `/github` 授权并返回确认，再请求：

> 在 example/app 修复登录失败后没有提示的问题。保留现有交互，增加错误提示并运行相关检查。

明确指定修改仓库；参考文档链接只是参考，不应代替目标仓库。可以附截图、代码文件或可选取文字的 PDF，限制见 [Telegram 使用指南](telegram-experience.md)。

机器人把原始要求交给 Codex；明确的修改请求授权对应持续任务，通过检查后自动发布 PR，无需先创建 Issue 或再次批准开发。分析请求不会授权实现或发布。

## Reference repositories

To refresh documentation from another repository, name both the source and the
modification target in your request. For example: “Copy `docs/user` from
`example/product` into `example/product-site`; keep `product-site` as the only
modification target.” Both repositories must be selected in the workspace. Every
contributor needs verified read access to the source and write access to the target.

RepoDesk prepares the named source's default branch at a recorded commit before
Codex starts. Full repository names avoid ambiguity. Reference repositories do not
receive code changes or PRs. If source access or another required environment
condition is unavailable, the task reports the blocker for an administrator to
resolve. Repeating “continue” does not repair a missing environment prerequisite.

## 补充需求与提问

回复任务消息、必要问题，或在同一 Topic 继续讨论：

- “错误提示改成中文，并增加重试按钮。”——补充实现需求。
- “为什么用了这个方案？”——查询技术选择，不授权新修改。
- “目前哪些检查通过了？”——查询实际进度。

普通说明不会仅因聊天中有任务就自动变成修改指令；需要时明确说“继续修改这个任务”。同一 Topic 有多个任务时，按提示选择。必要的产品问题会等待你的回答，其他技术判断由 Codex 处理。

后续修改通常更新同一个 PR。已关闭或合并的 PR 不会自动重建。目标仓库写错时立即说明；只有尚未产生工作成果且满足安全条件的空任务可以替换目标，已有修改不能直接搬到其他仓库。

## 状态、停止与 PR

进度消息更新已确认阶段；必要问题、阻塞和最终结果会有新消息。用最新任务消息上的 **Status / Cancel**，或 `/status`、`/cancel` 查看和停止。也可以在绑定对话发送“停止”或 `stop`。

旧消息上的控制按钮可能已失效，重新发送 `/status` 获取当前状态。停止是尽力操作，已发布的分支和 PR 保留，进行中的外部写入可能仍完成。

PR 消息中的 **Review** 打开改动页面，**Merge** 打开 GitHub PR。链接本身不执行合并；自动创建 PR 不包含合并或部署授权。普通 Telegram PR 合并操作见 [GitHub 指南](github.md)。当前开发任务不会发布 `.github/` 目录修改。

## 查看完整任务记录

点击 **View conversation** 打开只读 Telegram Mini App，查看留存需求、问题、Codex 消息和可展开活动。关闭页面不会停止任务；旧记录或中断的部分输出可能不完整。

管理员先按 [公开部署](deployment.md) 配置 HTTPS 和 BotFather Main Mini App。私聊任务记录仅原发起人可见；群任务还需当前群成员和任务权限。转发链接不授予访问。会话过期后，从 Telegram 重新打开。

## 中断与恢复

- **服务器关闭或执行环境中断**：新版本创建的任务在确认中断原因后，会保留工作区、重新验证权限和凭据，再继续原任务及完整检查。恢复期间仍可停止；普通失败、OOM、已取消和旧的失败任务不会因此自动重跑。
- **等待登录**：管理员在 Codex 页面重新认证，再检查原任务状态。
- **暂时无法验证 GitHub 权限**：任务会等待自动恢复；必要时 `/github sync`，授权失效则重新 `/github`。
- **仓库配置变化**：新任务只受目标仓库、GitHub 连接和 Codex 配置变化影响；其他仓库的变化可能短暂等待权限同步，随后继续原任务。目标仓库改名、默认分支或可见性改变、连接被替换或写权限撤销时，任务仍会停止。旧版本已失败的任务不会自动重跑。
- **缺少默认分支**：在 GitHub 修正仓库默认分支，再提出新请求。
- **发布结果未知**：先检查 GitHub 的分支和 PR，未知写入不会自动重放。

共享同一工作区 ChatGPT 登录的 Codex 阶段会串行执行；API Key 任务可并行。供应商限流、额度和账号限制仍适用。详见 [排障指南](troubleshooting.md)。
