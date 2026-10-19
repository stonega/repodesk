# Cloudflare

连接后可以在 Telegram 私聊查询已授权的域名、DNS 和 Pages 信息。DNS 修改和缓存清理需工作区 owner/admin 提出并确认。当前不提供 Pages 部署、Workers 管理、上传文件或修改 secrets。

## 使用 API Token

在 **Plugins → Cloudflare → API token → Edit** 直接保存受限 Token，无需创建 OAuth client。

1. 点击 **Create an account API token** 打开 [Cloudflare 账号 Token 页面](https://dash.cloudflare.com/?to=/:account/api-tokens)，创建 Token 并限制可访问的账号和域名。建议使用不依赖个人用户的账号 API Token；也可继续使用受限的用户 API Token。
2. 按用途授予 Zone Read、DNS Read、Cloudflare Pages Read，以及需要的 DNS Edit 或 Cache Purge。账号验证需 Account Settings Read；使用用户 API Token 发现账号时另需 User Memberships Read。
3. 粘贴 Token 并保存。面板随后打开账号和域名选择；仅有一个账号时会自动选中到草稿，多个账号时请选择。
4. 需要 DNS 或缓存操作时，搜索并勾选域名，最多二十个；不选域名可仅查询 Pages。不会自动把发现的所有域名授权给工具。
5. 保存选择。首次设置账号会启用插件；更换 Token 后请确认范围，再启用插件。

Token 加密保存，保存后不会显示；保存 Token 本身不代表权限已验证。按名称保存资源选择时会验证账号和域名归属。账号和域名较多时可用 **More accounts/domains** 加载下一页。

如果 Token 无法列出账号（包括没有账号发现权限的账号 API Token），在 **Configuration → Edit** 选择 **Enter IDs manually**，填写账号 ID 和域名 ID。此方式保存时不验证远端权限，使用工具时仍会检查权限和域名归属。

Token 创建与权限名称见 [Cloudflare 官方说明](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)。各工作区有独立连接。

## 提问与操作

| 请求示例 | 条件 |
| --- | --- |
| “列出已授权域名的 DNS 记录。” | 活跃成员，私聊 |
| “查看这个账号的 Pages 项目和最近部署。” | 活跃成员，私聊 |
| “把 app.example.com 的 A 记录改成这个 IP。” | owner/admin，核对预览后批准 |
| “清理这些 URL 的缓存。” | owner/admin，核对预览后批准 |

DNS 支持 A、AAAA、CNAME、TXT、MX，记录名需位于选定域名。清理支持最多二十个域内 HTTP(S) URL，或明确请求整站清理。群组和定时任务不能使用这些工具。

写操作会显示目标和完整内容，只有请求本人可以在十五分钟内批准。修改或删除的记录在执行前已变化时，提案会中止。结果未知时先检查 Cloudflare，再决定是否重新提出。

## 更换与移除 Token

在 **API token → Edit** 更换 Token；留空保留现有值。更换后插件会暂停，重新确认账号和域名后再启用。勾选 **Remove saved token and disable Cloudflare** 可移除本地凭据并停用插件；要撤销远端 Token，请到 Cloudflare 操作。

旧的 OAuth 连接仍可继续运行；在面板保存 API Token 会移除其本地凭据和待处理授权。之后请到 Cloudflare 撤销旧应用授权。

不要把连接密钥发到 Telegram；只在管理面板配置。相关费用和保留说明见 [模型与配置](configuration.md) 与 [记忆与隐私](memory-and-privacy.md)。
