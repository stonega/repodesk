# Cloudflare

连接后可以在 Telegram 私聊查询流量、DNS、TLS、安全规则、Pages、Workers、存储和账号资源。DNS、缓存、域名设置及 Worker 路由修改需工作区 owner/admin 提出，并逐项核对预览后批准。

## 使用 API Token

在 **Plugins → Cloudflare → API token → Edit** 直接保存受限 Token，无需创建 OAuth client。

1. 点击 **Create an account API token** 打开 [Cloudflare 账号 Token 页面](https://dash.cloudflare.com/?to=/:account/api-tokens)，创建 Token 并限制可访问的账号和域名。建议使用不依赖个人用户的账号 API Token；也可继续使用受限的用户 API Token。
2. 按用途授予 Zone Read、DNS Read、Cloudflare Pages Read；流量统计需要所选域名的 Analytics Read。Workers、KV、R2、D1、Queues、Vectorize、Hyperdrive、Turnstile、安全和负载均衡等功能需要各产品对应的读取权限。修改操作分别需要 DNS Edit、Cache Purge、Zone Settings Edit 或 Workers Routes Edit。账号验证需 Account Settings Read；使用用户 API Token 发现账号时另需 User Memberships Read。
3. 粘贴 Token 并保存。面板随后打开账号和域名选择；仅有一个账号时会自动选中到草稿，多个账号时请选择。
4. 需要 DNS 或缓存操作时，搜索并勾选域名，最多二十个；不选域名仍可查询账号级资源，但不能访问域名级数据。不会自动把发现的所有域名授权给工具。
5. 保存选择。首次设置账号会启用插件；更换 Token 后请确认范围，再启用插件。

Token 加密保存，保存后不会显示；保存 Token 本身不代表权限已验证。按名称保存资源选择时会验证账号和域名归属。账号和域名较多时可用 **More accounts/domains** 加载下一页。

如果 Token 无法列出账号（包括没有账号发现权限的账号 API Token），在 **Configuration → Edit** 选择 **Enter IDs manually**，填写账号 ID 和域名 ID。此方式保存时不验证远端权限，使用工具时仍会检查权限和域名归属。

Token 创建与权限名称见 [Cloudflare 官方说明](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)。各工作区有独立连接。

## 提问与操作

| 请求示例 | 条件 |
| --- | --- |
| “列出已授权域名的 DNS 记录。” | 活跃成员，私聊 |
| “查看这个账号的 Pages 项目和最近部署。” | 活跃成员，私聊 |
| “整理 example.com 最近七天的请求数、带宽、缓存命中率和每日访客。” | 活跃成员，私聊；Analytics Read |
| “按国家或状态码分析这个域名的流量。” | 活跃成员，私聊；Analytics Read |
| “列出 Workers、定时触发器、KV、R2、D1 和 Queues。” | 活跃成员，私聊；对应产品读取权限 |
| “检查域名证书、安全规则和负载均衡配置。” | 活跃成员，私聊；对应产品读取权限 |
| “把域名的 SSL 模式设为 strict。” | owner/admin，核对当前值和预览后批准 |
| “把 example.com/api/* 路由到 my-worker。” | owner/admin，核对预览后批准 |
| “把 app.example.com 的 A 记录改成这个 IP。” | owner/admin，核对预览后批准 |
| “清理这些 URL 的缓存。” | owner/admin，核对预览后批准 |

支持的查询还包括 DNSSEC、域名设置、Pages 自定义域名、Workers 版本及部署元数据、
Vectorize、Hyperdrive、Turnstile、健康检查、邮件路由、等候室和 Web Analytics 站点元数据。
账号和域名范围始终来自保存的配置；读取权限与 Cloudflare 套餐限制仍适用。

流量按 UTC 自然日查询，默认最近七个完整日，可指定最多三十一天及国家、状态码、
内容类型或浏览器分类。每日独立访客不能直接相加当作整个时段的独立访客；域名请求量
也不等于 Web Analytics 会话数。空数据不代表零流量。列表需按返回的页码或游标继续读取；
Pages 每页最多十条。

DNS 支持 A、AAAA、CNAME、TXT、MX，记录名需位于选定域名。清理支持最多二十个域内 HTTP(S) URL，或明确请求整站清理。群组和定时任务不能使用这些工具。

域名设置支持 SSL、HTTPS、最低 TLS 版本、TLS 1.3、安全等级、浏览器检查、缓存等级和
缓存 TTL、开发模式、HTTP/3、IPv6、WebSockets、Early Hints。路由支持创建、更新和删除；
明确传入空脚本代表绕过 Worker。修改前会读取当前设置，目标有变化时中止。

当前不提供创建部署、上传文件、Worker 源码、KV 值、R2 文件内容、D1 数据查询或 secrets
管理。API Token 连接没有 Reconnect 按钮；查询失败时先确认该操作的权限、套餐和日期范围。

写操作会显示目标和完整内容，只有请求本人可以在十五分钟内批准。修改或删除的记录在执行前已变化时，提案会中止。结果未知时先检查 Cloudflare，再决定是否重新提出。

## 更换与移除 Token

在 **API token → Edit** 更换 Token；留空保留现有值。更换后插件会暂停，重新确认账号和域名后再启用。勾选 **Remove saved token and disable Cloudflare** 可移除本地凭据并停用插件；要撤销远端 Token，请到 Cloudflare 操作。

旧的 OAuth 连接仍可继续运行；在面板保存 API Token 会移除其本地凭据和待处理授权。之后请到 Cloudflare 撤销旧应用授权。

不要把连接密钥发到 Telegram；只在管理面板配置。相关费用和保留说明见 [模型与配置](configuration.md) 与 [记忆与隐私](memory-and-privacy.md)。
