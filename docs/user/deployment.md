# 公开部署与 HTTPS

先按 [快速开始](get-started.md) 启动服务并创建首个管理员，再开放公网访问。公开部署可以使用 webhook；polling 也可继续使用，但 GitHub 回调、Review Bot 和 Telegram 任务记录入口需要各自可访问的站点地址。

## 部署前准备

准备可运行 Docker Compose 的服务器、域名、HTTPS 证书和反向代理。Code Truth 和 Codex 会额外占用磁盘、CPU 和内存，按仓库和并发规模规划。

固定部署目录和 Compose 项目名。数据卷与项目名关联，移动目录或改名后可能连接到新的空卷。长期使用前建立 [备份和恢复流程](maintenance.md)。

远程首次设置可通过 SSH 隧道完成：

```sh
ssh -L 3000:127.0.0.1:3000 YOUR_USER@YOUR_SERVER
```

浏览器访问 `http://localhost:3000/setup`，先领取管理员账号。

## 配置站点

1. 将域名解析到服务器。
2. 在宿主机或已有网关配置 HTTPS 反向代理，将站点请求转发到 `http://127.0.0.1:3000`。代理在其他容器内时使用该部署的内部网络地址，容器内的 `127.0.0.1` 不指向宿主机。
3. 转发完整路径和查询参数，包括 `/api/`、`/telegram/`、`/github/`、`/mini` 和 `/mini-api/` 下的请求；不要只转发管理页面。
4. 设置 `.env` 的公开地址，不加末尾斜杠：

```dotenv
PUBLIC_ORIGIN=https://repodesk.example.com
TELEGRAM_TRANSPORT=webhook
```

5. 重新创建 app 和 worker，使环境配置生效：

```sh
docker compose config --quiet
docker compose up -d
```

检查 HTTPS 登录和以下端点：

```sh
curl --fail https://repodesk.example.com/healthz
curl --fail https://repodesk.example.com/readyz
```

`/healthz` 表示应用进程存活；`/readyz` 还检查 worker 等条件。注册 webhook 之前，接收器可能尚未就绪。

数据库、Code Truth 和 Codex runner 保持内部可访问。面板中的 **Site domain** 用于管理站点域名；修改域名后，同时核对反向代理、运行环境地址和各服务回调地址。

## 注册 Telegram webhook

1. 确认同一个 Bot Token 没有被其他 polling 实例使用。
2. 在管理面板 **Site domain** 点击 **Register Telegram webhook**。
3. 检查 Setup 的接收器状态，以及 Telegram 中的 `/help` 和普通问答。

安装、构建镜像和普通 webhook 模式启动不会替你注册 webhook。注册需要明确执行，已有待处理消息会保留。激活与成员权限独立：机器人已激活，也只有获准成员能使用。

### 从 polling 切换

先停止原 polling worker，再修改传输方式并重建服务，最后注册 webhook。同一机器人不能同时使用 polling 和 webhook。

### 从 webhook 切回 polling

先停止原接收实例，使用 Telegram 的 `deleteWebhook` 删除原 webhook，并保留待处理更新（`drop_pending_updates=false`），再改为 `polling` 并重新创建 app/worker。RepoDesk 不会自动删除已有 webhook。

接口说明见 [getUpdates](https://core.telegram.org/bots/api#getupdates) 和 [deleteWebhook](https://core.telegram.org/bots/api#deletewebhook)。

## 服务回调

公开地址确定后再连接服务，可以减少回调不匹配。回调需要与注册值完全一致，且连接过程使用同一个浏览器会话。

| 用途 | 路径或配置入口 |
| --- | --- |
| GitHub 用户授权回调 | `/api/admin/github/callback` |
| GitHub App 创建回调 | 由 RepoDesk 的创建流程提供 |
| Review Bot webhook | 复制 Review Bot 页面显示的完整 URL |
| Cloudflare 授权回调 | `/api/admin/cloudflare/callback` |

迁移域名后，在对应服务中核对回调和 webhook 设置。新建 GitHub App 时若使用本地地址，GitHub webhook 会保留未启用的占位地址；上线后需要更新。

## 开启 Telegram 任务记录

Codex 的 **View conversation** 打开只读 Mini App，需要额外配置：

1. 站点已经提供 HTTPS。
2. 在 BotFather 启用机器人的 **Main Mini App**，URL 设为 `https://repodesk.example.com/mini`。
3. 从 Telegram 任务消息打开 **View conversation**，分别检查私聊和已关联群组。

普通浏览器访问 `/mini` 不能读取任务记录。转发链接不会授予访问权限；访问者仍需通过 Telegram 身份和当前任务权限检查。详情见 [Codex 开发任务](codex.md)。
