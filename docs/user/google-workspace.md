# Google

**Plugins → Google** 将 Docs、Sheets、Drive、Gmail 和 Search Console 合并在一个插件中。
管理员配置共用的 **Web application** 和 **Enable** 开关；每位成员在 Telegram 连接自己的 Google 账号。

## 管理员配置应用

1. 在 Google Cloud 的同一个项目中启用 Google Docs、Sheets、Drive、Gmail 和 Search Console API。
2. 打开 **Plugins → Google → Web application → Edit**，填写已有 Web application 的 Client ID 和 Client secret。
3. 将窗口中的 **Callback URL** 添加到客户端的已授权重定向 URI。回调地址和每个读取权限旁都有复制按钮。
4. 配置 Google 的同意画面和测试用户，保存设置，再打开 **Enable**。

回调地址为管理站点地址加 `/api/admin/google/callback`，所有用户和五项服务共用这一个地址。
修改管理域名后，需要更新 Google 客户端的回调地址。更换 Client ID 或密钥会清除当前工作区所有成员的连接，需要各自重新授权。

## 在 Telegram 连接自己的账号

1. 在机器人私聊中选择工作区，发送 `/google`，点击 **Connect Google account**。
2. 在浏览器选择自己的 Google 账号，授予列出的五项读取权限。
3. 返回 Telegram，确认显示的账号是自己的，再点击 **Connect account**。若账号不对，点击 **Reject**。
4. 需要 Search Console 时，发送 `/google properties`，选择资源并点击 **Save**。

连接链接和资源选择窗口均在十分钟后失效。浏览器登录后仍需在 Telegram 确认，无需登录管理面板。
Google 的应用验证、Workspace 管理策略和测试用户限制仍然适用。

- `/google` 或 `/google status`：查看当前工作区的账号及状态。
- `/google connect`：连接或重新连接；完成后需要重新选择 Search Console 资源。
- `/google properties`：分页选择自己的 Search Console 资源，最多 20 个；Save 保存，Cancel 放弃草稿。
- `/google disconnect`：清除自己在当前工作区的连接，不影响其他成员或工作区。

要撤销 Google 端授权，请前往 [Google 账号连接管理](https://myaccount.google.com/connections)。

## 使用范围

每位活跃成员只能在私聊中读取自己确认连接的账号。管理员角色不会获得其他成员的 Google 账号权限。
群聊和定时工作流不能读取这些个人数据。停用成员会清除其连接；重新加入后需要再次授权。

- **Docs**：提供文档 ID，读取标题、标签页、段落和表格文字。
- **Sheets**：提供表格 ID，读取工作表信息或明确 A1 范围内的单元格。
- **Drive**：按文件名查找文件及其 ID、类型和链接。
- **Gmail**：搜索邮件，读取邮件头、摘要和纯文本；不下载附件或 HTML。
- **Search Console**：读取自己选择的资源；详见 [Search Console](search-console.md)。

列表可能分页。编辑、分享、删除文件及发送邮件均不支持。

## 升级与恢复

旧的独立插件页面会跳转到 Google。已有 Web application 可以继续使用；若页面提示复用旧客户端，打开 Edit 保存一次。
旧的工作区共用账号和服务账号不再提供访问，每位成员需重新连接自己的账号。
显示 **Reconnect required** 时，发送 `/google connect` 完成授权并确认。应用未启用或配置不完整时，请管理员检查 **Plugins → Google**。
