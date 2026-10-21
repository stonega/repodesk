# Google Docs、Sheets、Drive 和 Gmail

Plugins 提供四个独立插件：**Google Docs**、**Google Sheets**、**Google Drive** 和
**Gmail**。分别连接、启用或断开；只使用其中一个时，不需要连接其他插件。
当前提供读取和搜索功能，不支持编辑、分享、删除或发送邮件。

## 连接账号

需要部署管理员操作：

1. 打开所需插件的 **Connection → Edit**。
2. 在 Google Cloud 项目中启用对应的 Google Docs API、Google Sheets API、Google
   Drive API 或 Gmail API，配置 OAuth 同意界面及测试用户。
3. 创建 **Web application** OAuth 客户端，将对话框显示的 **Callback URL** 原样添加为
   Authorized redirect URI。线上管理地址需要 HTTPS；本机开发支持 localhost。
   **Callback URL** 和 **Read scope** 旁的复制按钮可复制完整值；若复制失败，可选中文字手动复制。
4. 填入 Client ID 和 Client secret，点击 **Save**。再次打开 **Edit**，点击
   **Connect Google account**，在 Google 确认账号及权限。
5. 返回插件页面，核对账号，再打开标题右侧的 **Enable**。

建议每个插件使用独立 OAuth 客户端，便于分别撤销 Google 授权。读取权限之外还会请求
邮箱身份，用于显示连接的账号。Google Workspace 管理策略、应用验证和测试模式的授权
有效期可能影响连接。

保存后的 Client secret 不会显示。替换客户端凭据会断开并停用这个插件；留空保留同一
Client ID 的原有 secret。**Disconnect** 清除当前插件在 RepoDesk 保存的访问令牌和
刷新令牌，保留客户端设置以便重新连接。彻底撤销授权请使用
[Google 账号连接管理](https://myaccount.google.com/connections)。共用 OAuth 客户端时，
在 Google 撤销授权可能影响多个插件。

## 在 Telegram 中使用

仅工作区 **owner/admin** 可以在与机器人的**私聊**中查询连接账号的数据。普通成员、群组
和定时任务无法使用这些工具。所有有权限的 owner/admin 访问的是工作区连接的账号，
不是各自的个人 Google 账号。

- **Google Docs**：提供文档链接中的 document ID，读取标题、各个标签页、段落和表格文字。
- **Google Sheets**：提供 spreadsheet ID，查询工作表信息；读取单元格时明确给出 A1 范围，
  例如 `预算!A1:D20`。返回格式化后的单元格值。
- **Google Drive**：按文件名搜索，查看文件 ID、类型、链接等信息。读取 Docs 或 Sheets
  内容需要分别连接对应插件；Drive 本身只提供元数据。
- **Gmail**：使用 Gmail 搜索语法，例如 `from:friend@example.com newer_than:7d`，再按
  返回的 message ID 读取邮件。支持常见邮件头、摘要和纯文本内容；仅 HTML 的邮件提供
  摘要，不下载附件。

文件或邮件列表每次最多返回 20 条，需要时继续读取下一页。较大的文档或单元格范围
可能超出响应上限，请缩小请求。文件、表格和邮件中的文字是数据，不能替你授权操作。

## 连接故障

显示 **Reconnect required** 时，在 Edit 中重新连接账号。检查 Google 项目是否启用
正确的 API、同意界面是否允许当前账号，以及 Callback URL 是否与当前管理地址一致。
修改管理域名后，需要更新 Google 客户端的回调地址，并重新开始登录。

工作区其他插件设置改变导致版本冲突时，关闭对话框并通过错误提示中的 **Retry** 读取
已保存设置，再重新编辑。失败保存会保留当前草稿；Cancel 放弃草稿。

返回[用户文档](README.md)。
