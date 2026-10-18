# 连接和使用 GitHub

连接分为两层：管理员为工作区安装 GitHub App 并选择仓库；成员验证自己的 GitHub 身份。工作区连接不会替成员完成账号验证。

## 管理员：连接仓库

1. 在首次设置点击 **Connect GitHub**，或打开 **Workspace → Plugins → GitHub**。
2. 首次使用时创建 GitHub App。默认是个人所有；如需组织所有，在 Plugins 选择 **Create GitHub App → Organization** 并填写组织名。
3. 核对 App 名称和安装范围。个人所有的 App 需要安装到组织时，创建时允许安装到其他 GitHub 账号。
4. 到 GitHub 确认创建，再完成用户授权和安装。组织可能要求 owner 审批。
5. 在 GitHub 选择目标仓库并返回。首次设置会尝试连接唯一可用的 installation；存在多个时，到 Plugins 明确选择 installation 和仓库，再点击 **Connect selected repositories**。
6. 确认面板列出正确仓库。

新建 App 的凭据由 RepoDesk 加密保存，无需下载图标、手工粘贴私钥或创建个人访问令牌。授权流程十分钟有效，保持同一个登录浏览器和站点地址；过期后从面板重新开始。

GitHub 的 **Authorized GitHub Apps** 仅表示身份授权；**Installed GitHub Apps** 才表示 App 已安装。两个步骤均完成后才有仓库访问。

### App 权限与仓库变更

完整工作流使用 Contents、Issues、Pull requests 的读写权限和 Metadata 只读权限；成员目录还使用组织 Members 只读权限。新 App 会预填这些权限。

已有 App 增加权限后，需要在 GitHub installation 接受新权限，组织可能需要 owner 批准。仅在 RepoDesk 重新连接不能授予缺失权限。

仓库重命名会按已选仓库的数字身份更新；后来新授权的仓库不会自动加入工作区，需要重新授权和选择。GitHub 中的 **All repositories** 会授权其范围内的仓库，选择前确认符合预期。

## 成员：验证自己的账号

1. 先加入工作区，在机器人私聊发送 `/github` 或 `/github connect`。
2. 打开授权链接，在 GitHub 确认账号和授权。
3. 返回原 Telegram 私聊，核对显示的 GitHub 登录名并点击 **Connect account**。

仅浏览器授权不会完成绑定。无需另建面板账号。多工作区先使用 `/workspace <UUID>` 选择目标；同一 GitHub 身份在一个工作区只能关联一个成员。

`/github sync` 手动刷新权限；worker 也会定期刷新。`/github disconnect` 清除本人连接和有效授权，并取消待处理工作，不会恢复更宽的仓库访问。

连接后的读取需要 GitHub 读权限，Codex 需要已验证的写权限。GitHub admin 身份不会提升工作区角色，管理员代选的 GitHub 资料也不能替代本人验证。

## 查询仓库、Issue 和 PR

发送 `/repos` 选择默认仓库，或每次写出 `owner/repository`。

- “列出 example/app 本周合并的 PR，附日期和链接。”
- “example/app 的 Issue #42 现在是什么状态？”
- “比较 PR #12 和 #15 的代码改动、审查意见和未解决问题。”

GitHub 连接本身支持元数据、PR 改动及审查记录查询，不要求启动 Code Truth。理解仓库中更广泛的源码，使用 [Code Truth](code-truth.md)。分页、缺失补丁或截断会限制结论，可以要求继续查询并说明覆盖范围。

私有仓库的交互式查询和 PR 操作使用私聊。私有仓库的定期群报告需要管理员批准来源与接收位置，见 [定时任务](workflows.md)。

## 创建 Issue

例如：“在 example/app 创建登录超时问题的 Issue，复现步骤是……”。

机器人展示仓库、完整标题和正文。本人在十五分钟内点击 **Approve** 才会提交；**Reject** 放弃。发布后链接返回原聊天或 Topic。

标题最多 256 字符、正文最多 3,000 字符，当前不包含标签和指派人。以 App 身份发布，可能通知仓库订阅者。结果未知时先查 GitHub，避免重复创建。

## 合并或关闭 PR

例如：“将 example/app 的 PR #12 用 squash 合并”，或“关闭 PR #15”。

提案会显示 PR、目标分支、操作；合并还显示当前 head commit 和 merge/squash/rebase 方法。每个 PR 单独由请求本人确认。请求者需满足工作区角色或已验证 GitHub 写权限条件；已绑定账号还必须通过当前上游权限检查。

合并前 PR 发生变化会使提案失效，需要重新检查。不会自动绕过 GitHub 分支规则；草稿 PR、merge queue 等情况可能需要 GitHub 自己的流程。关闭不会合并或删除分支。

Codex 创建 PR 不代表授权合并。使用消息上的 **Review / Merge** 会打开 GitHub 页面，不会仅因点击链接而执行合并。

## 开发与审查

[Codex](codex.md) 用于实现修改并生成 PR；[Review Bot](review-bot.md) 用于自动审查和同一 PR 上的明确修复。它们均需额外启用。权限失败见 [排障指南](troubleshooting.md)。
