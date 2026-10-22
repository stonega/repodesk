# Search Console

Search Console 属于 [Google 插件](google-workspace.md)，使用你在当前工作区连接的 Google 账号。

## 选择资源

1. 在机器人私聊发送 `/google`，完成 Google 授权，并在 Telegram 确认账号。
2. 发送 `/google properties`，查看该账号可用且已验证的资源。
3. 点击资源切换选择，使用 Previous/Next 翻页。最多选择 20 个。
4. 点击 **Save**，系统会再次检查资源权限；**Cancel** 放弃草稿。

选择窗口十分钟后失效。保存失败时保留草稿，可修复权限后重试。
未选择资源不影响自己的 Docs、Sheets、Drive 和 Gmail。

## 查询示例

在私聊中可以请求：

- 列出我选择的 Search Console 资源。
- 查询 example.com 在 2026-10-01 到 2026-10-10 的点击、曝光、CTR 和平均排名。
- 列出 example.com 的 sitemap。
- 检查 Google 已索引的 `https://example.com/blog/intro` 状态。

只有活跃成员能使用自己的连接；其他成员及管理员不能通过自己的会话读取你的账号。
群聊和定时工作流不支持这些个人数据查询。

数据按太平洋时间统计，单次日期范围最多 366 天、每页最多 100 行。
Google 只返回部分排名靠前的数据，可能省略匿名查询或尚未完成的数据；空结果不代表没有流量。
URL 检查读取已索引版本，不会实时抓取、请求索引或修改网站。

## 断开与恢复

`/google disconnect` 只断开自己的账号。重新连接后需重新选择资源。
修改资源选择后，旧选择下的回答可能无法继续作为上下文使用。
若发现列表为空，请检查当前 Google 账号的 Search Console 权限，再发送 `/google properties`。
需要重新登录时发送 `/google connect`；应用配置问题请管理员检查 Google 插件。
