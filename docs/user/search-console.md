# Google Search Console

通过 Telegram 私聊查询已授权网站的搜索点击、曝光、CTR、平均排名、Sitemap 状态和 URL 索引状态。

## 连接

只有工作区所属的部署管理员可以配置。Search Console 已合并到 **Plugins → Google**，
与 Docs、Sheets、Drive 和 Gmail 共用一个 Web application 和 Google 账号。先按
[Google 连接指南](google-workspace.md) 连接账号并授予全部读取权限。

1. 确认该 Google 账号拥有要查询的 Search Console 资源权限；URL 检查可能需要完整用户权限。
2. 打开 **Plugins → Google → Search Console properties → Edit**。
3. 搜索并选择允许查询的资源，最多 20 个，然后点击 **Save properties**。发现列表不会自动授权任何资源。
4. 打开 Google 页面标题右侧的 **Enable**。五项服务共用此开关。

支持网域资源（如 `sc-domain:example.com`）和 URL 前缀资源（如 `https://example.com/`）。
未选择资源时，其余 Google 工具仍然可用。Search Console 使用 `webmasters.readonly` 权限。
不再需要单独创建服务账号或上传 JSON 密钥。

## 查询示例

只有活跃的工作区 owner/admin 可以在机器人私聊中通过共享账号查询选定资源。群组和定时任务不提供此工具。

- “列出这个工作区可查询的 Search Console 资源。”
- “查询 example.com 2026 年 9 月的总点击、曝光、CTR 和平均排名。”
- “按查询词比较 9 月 1–7 日和 9 月 8–14 日的搜索表现。”
- “查看 example.com 的 Sitemap 状态。”
- “检查 https://example.com/blog/intro 的 Google 索引状态。”

性能查询使用 Pacific 日期、已完成的数据，单次范围最多 366 天，每页最多 100 行。支持按日期、查询词、页面、国家、设备和搜索外观分组，以及 Web、图片、视频、新闻、Discover 和 Google News 类型。Google 返回排名靠前的行，可能省略匿名查询和近期数据；没有结果不代表没有流量。

URL 检查只读取 Google 已索引的版本，不能进行实时测试或请求收录。Sitemap 只读，不支持提交或删除。

## 更新与排障

断开 Google 会同时停用五项服务。更换客户端或重新连接账号会清空资源选择，需要重新选择。
设置变更后，旧连接的结果不能再用于后续回答或待发送的回复。

发现列表为空时，确认连接的 Google 账号拥有 Search Console 资源权限，随后在编辑窗口重试。
Google 拒绝访问时检查项目 API、账号权限与连接状态。达到配额时稍后再试。设置冲突时，关闭
编辑器并重新加载后再保存。旧的服务账号配置在保存统一 Google 连接时移除，并需要重新授权和选择资源。

不要在 Telegram 粘贴密钥。管理其他集成见 [工作区与成员](administration.md)。
