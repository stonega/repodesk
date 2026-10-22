# Google

**Plugins → Google** 将 Docs、Sheets、Drive、Gmail 和 Search Console 合并在一个插件中。
五项服务共用已注册的 **Web application**、一个 Google 账号和一个 **Enable** 开关。

## 连接账号

1. 在 Google Cloud 的同一个项目中启用 Google Docs API、Google Sheets API、Google Drive API、Gmail API 和 Google Search Console API。
2. 打开 **Plugins → Google → Connection → Edit**，复用已有的 Web application OAuth 客户端。
3. 将窗口中的 **Callback URL** 添加到该客户端的已授权重定向 URI。每个回调地址和读取权限旁都有复制按钮。
4. 配置 Google 的同意画面和测试用户，保存 Client ID 与 Client secret。
5. 重新打开 Edit，点击 **Connect Google account**，确认账号并授予列出的全部读取权限。
6. 返回后检查账号，再打开 **Enable**。保存配置或完成登录不会自动启用。

回调地址为管理站点地址加 `/api/admin/google/callback`。修改管理域名后，需要更新 Google 客户端的回调地址并重新开始登录。
Google 的应用验证、Workspace 管理策略和测试模式授权期限仍然适用。

## 现有配置

旧的 Google 插件页面会跳转到统一页面。若已有 OAuth 客户端，编辑器会预填一个已有 Client ID；
保存时可以保留该客户端的密钥，也可以输入另一个已注册客户端的 ID 和密钥。
保存统一配置会移除旧的独立连接和 Search Console 服务账号密钥。随后重新连接，授予合并后的权限，
并重新选择 Search Console 资源。旧令牌不会自动获得其他服务的访问权限。

## 使用范围

连接属于当前工作区。只有活跃的工作区 owner/admin 能在私聊中读取该账号；普通成员、群聊和定时工作流不能读取。

- **Docs**：提供文档 ID，读取标题、标签页、段落和表格文字。
- **Sheets**：提供表格 ID，查询工作表信息或明确的 A1 单元格范围。
- **Drive**：按文件名搜索，读取文件 ID、类型和链接；可用于发现 Docs 和 Sheets 的 ID。
- **Gmail**：按 Gmail 搜索语法查找邮件，读取邮件头、摘要及纯文本；不下载附件或 HTML。
- **Search Console**：在同一页的 **Search Console properties → Edit** 中发现并选择资源。没有选择资源时，其余四项服务仍可使用。详见 [Search Console](search-console.md)。

列表可能分页；文档和表格只读文字或单元格内容。编辑、分享、删除文件及发送邮件均不支持。

## 断开和恢复

**Disconnect** 会删除五项服务共用的本地令牌并停用 Google，保留客户端设置以便重新连接。
更换客户端或重新连接账号后，需要重新选择 Search Console 资源。要撤销 Google 端授权，请前往
[Google 账号连接管理](https://myaccount.google.com/connections)。

显示 **Reconnect required** 时，在 Edit 中重新连接。连接失败时检查五个 API、同意画面、测试用户、
全部读取权限和完全一致的回调地址。设置冲突时，关闭编辑器并重新加载后再保存。
