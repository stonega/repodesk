# Google Search Console

通过 Telegram 私聊查询已授权网站的搜索点击、曝光、CTR、平均排名、Sitemap 状态和 URL 索引状态。

## 连接

只有工作区所属的部署管理员可以配置插件。

1. 在 Google Cloud 项目中启用 **Google Search Console API**。
2. 创建服务账号并下载 JSON 密钥。复制其中的 `client_email`。
3. 在每个 Search Console 资源的 **设置 → 用户和权限** 中，将该邮箱添加为用户。一般性能查询可使用受限用户；需要 URL 检查时授予完整用户权限。Google 会继续检查每个接口的权限。
4. 打开 **Plugins → Google Search Console → Service account → Edit**，粘贴 JSON 并保存。密钥会加密存储，保存后不会显示。
5. 在自动打开的 **Properties** 编辑窗口中搜索并选择允许查询的资源，最多 20 个，然后点击 **Save properties**。发现列表不会自动授权任何资源。
6. 打开页面标题右侧的 **Enable**。

支持网域资源（例如 `sc-domain:example.com`）和 URL 前缀资源（例如 `https://example.com/`）。各工作区使用独立凭据和资源选择。插件只请求 Google 的 `webmasters.readonly` 权限。

服务账号创建方式见 [Google 官方说明](https://developers.google.com/identity/protocols/oauth2/service-account)。不需要配置浏览器授权回调或 Google OAuth 客户端。

## 查询示例

所有活跃成员都可以在机器人私聊中查询工作区选定的资源。群组和定时任务不提供此工具。

- “列出这个工作区可查询的 Search Console 资源。”
- “查询 example.com 2026 年 9 月的总点击、曝光、CTR 和平均排名。”
- “按查询词比较 9 月 1–7 日和 9 月 8–14 日的搜索表现。”
- “查看 example.com 的 Sitemap 状态。”
- “检查 https://example.com/blog/intro 的 Google 索引状态。”

性能查询使用 Pacific 日期、已完成的数据，单次范围最多 366 天，每页最多 100 行。支持按日期、查询词、页面、国家、设备和搜索外观分组，以及 Web、图片、视频、新闻、Discover 和 Google News 类型。Google 返回排名靠前的行，可能省略匿名查询和近期数据；没有结果不代表没有流量。

URL 检查只读取 Google 已索引的版本，不能进行实时测试或请求收录。Sitemap 只读，不支持提交或删除。

## 更新与排障

更换密钥会暂停插件并清空资源选择，需要重新选择并启用。移除本地凭据也会停用插件；要撤销远端密钥，请在 Google Cloud 删除对应服务账号密钥。设置变更后，旧连接的结果不能再用于后续回答或待发送的回复。

发现列表为空时，确认已把保存的服务账号邮箱添加到 Search Console 资源；添加后在编辑窗口点击重试。Google 拒绝访问时，检查项目 API 是否启用、资源权限和密钥状态。达到配额时稍后再试。其他会话修改设置产生冲突时，关闭窗口并重新加载，核对后再保存。

不要在 Telegram 粘贴密钥。管理其他集成见 [工作区与成员](administration.md)。
