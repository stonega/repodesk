# Cloudflare

连接后可以在 Telegram 私聊查询已授权的域名、DNS 和 Pages 信息。DNS 修改和缓存清理需工作区 owner/admin 提出并确认。当前不提供 Pages 部署、Workers 管理、上传文件或修改 secrets。

## 浏览器授权

管理员先为部署配置 OAuth client，再连接工作区：

1. 在 Cloudflare 创建 OAuth client，设置 Authorization Code、refresh token 和 `client_secret_basic`，使用 RepoDesk **Authorization → Edit** 显示的回调地址。
2. 回调形如 `https://repodesk.example.com/api/admin/cloudflare/callback`，应与公开站点完全一致。
3. 在 **Plugins → Cloudflare → Authorization → Edit** 填写 client ID、client secret 和需要的 scope ID。账号发现需要 Account Read，域名发现需要 Zone Read；操作另需对应的读写权限。
4. 点击 **Connect Cloudflare**，在 Cloudflare 选择账号和授权范围。
5. 返回后，一个可用账号会自动选中；多个账号时在弹窗选择。需要 DNS 或缓存操作时，再在 **Configuration → Edit** 选择域名并保存。

未选域名可以仅查询 Pages。最多选择二十个域名，不会自动把发现的所有域名授权给工具。各工作区有独立连接。

OAuth client 的注册细节和 scope 取值请查 [Cloudflare 官方说明](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)。私有 client 仅供所属账号成员使用；面向其他账号的 client 有额外发布与域名验证要求。

## 使用 API Token

也可在 **Configuration → Edit** 明确选择 **API token**，填写受限 Token、账号 ID 和域名 ID。按用途授予 Zone Read、DNS Read、Pages Read，以及需要的 DNS Edit 或 Cache Purge，并将资源限制在目标账号和域名。

留空保留现有 Token；移除 Token 会停用该连接。保存状态不代表远端权限已验证，先从查询确认。

## 提问与操作

| 请求示例 | 条件 |
| --- | --- |
| “列出已授权域名的 DNS 记录。” | 活跃成员，私聊 |
| “查看这个账号的 Pages 项目和最近部署。” | 活跃成员，私聊 |
| “把 app.example.com 的 A 记录改成这个 IP。” | owner/admin，核对预览后批准 |
| “清理这些 URL 的缓存。” | owner/admin，核对预览后批准 |

DNS 支持 A、AAAA、CNAME、TXT、MX，记录名需位于选定域名。清理支持最多二十个域内 HTTP(S) URL，或明确请求整站清理。群组和定时任务不能使用这些工具。

写操作会显示目标和完整内容，只有请求本人可以在十五分钟内批准。修改或删除的记录在执行前已变化时，提案会中止。结果未知时先检查 Cloudflare，再决定是否重新提出。

## 断开与重连

授权通常会自动刷新；刷新失败或结果不确定时需要 **Reconnect**。**Disconnect** 清除本地授权并停用插件，同时尝试远端撤销。远端撤销未确认时，到 Cloudflare 账号中检查。

更换 client、scope 或认证方式前先断开。不要把连接密钥发到 Telegram；只在管理面板配置。相关费用和保留说明见 [模型与配置](configuration.md) 与 [记忆与隐私](memory-and-privacy.md)。
