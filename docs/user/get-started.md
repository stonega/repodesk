# Get started：快速开始

这篇教程使用 Docker Compose 部署 RepoDesk，通过 Telegram polling 收取消息。完成后，你可以登录管理面板，并在 Telegram 私聊机器人。无需域名、HTTPS 或公开端口。

如果只是加入已有团队，阅读 [Telegram 使用指南](telegram-experience.md)。

## 1. 准备

- 安装 Git、Docker Engine 和 Docker Compose v2，确认 `docker compose version` 可用。
- 准备终端中的 OpenSSL 和 curl，后续用于生成凭据和检查服务。
- 准备可访问 Telegram、模型供应商和容器镜像源的网络。
- 在 Telegram 的 [@BotFather](https://t.me/BotFather) 中创建一个专用机器人，保存 Bot Token。
- 准备支持模型列表、流式 Chat Completions 和工具调用的模型 API，以及它的 API Key 和 Base URL。详见 [模型与配置](configuration.md)。

使用 Docker 构建时，Bun 和 Node 已包含在镜像构建流程中，宿主机无需另装。

## 2. 下载并初始化

以下命令用于全新安装。如果目录已有数据，保留原 `.env` 和 `secrets/`，按 [维护指南](maintenance.md) 操作。

```sh
git clone https://github.com/stonega/repodesk.git
cd repodesk
cp .env.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
(umask 077; set -C; openssl rand -hex 32 > secrets/encryption-key)
chmod 644 secrets/encryption-key
```

`secrets/` 仅允许部署用户访问；密钥文件需要让容器内的 `node` 用户可读，因此示例将文件设为 `644`、父目录保持 `700`。SELinux 或 rootless Docker 环境还需按宿主机策略配置读取权限。

生成一个数据库密码：

```sh
openssl rand -hex 24
```

编辑 `.env`，将输出填入 `POSTGRES_PASSWORD`，并设置：

```dotenv
POSTGRES_PASSWORD=填写刚才生成的密码
PUBLIC_ORIGIN=http://localhost:3000
APP_PORT=3000
ENCRYPTION_KEY_FILE=./secrets/encryption-key
TELEGRAM_TRANSPORT=polling
```

不要把 `.env`、`secrets/` 或备份提交到 Git。加密密钥用于解密已保存的机器人和模型凭据；已有数据库不能通过重新生成密钥来“重置”。

## 3. 启动服务

在仓库根目录运行：

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
curl --fail http://localhost:3000/readyz
```

首次构建需要下载依赖。`migrate` 和 `code-truth-token` 完成后退出是正常现象；`postgres`、`code-truth`、`app` 和 `worker` 应持续运行。Code Truth 的内部连接与令牌会自动配置，工作区启用插件后才会索引仓库。`/readyz` 还会检查 worker 就绪状态，启动后可稍等再试。

默认只在宿主机 `127.0.0.1:3000` 提供面板，数据库没有公开端口。命令细节可参阅 [Docker Compose 官方文档](https://docs.docker.com/reference/cli/docker/compose/)。

如果部署在远程服务器，先从自己的电脑建立隧道，再打开浏览器：

```sh
ssh -L 3000:127.0.0.1:3000 YOUR_USER@YOUR_SERVER
```

## 4. 完成首次设置

打开 `http://localhost:3000/setup`。

1. 创建首个管理员账号，密码至少 12 个字符。没有默认账号或默认密码。先完成这一步，再对外开放面板。
2. 创建工作区，填写名称和时区，例如 `Asia/Taipei`。
3. 按向导添加模型供应商：填写 Base URL 和 API Key，保存后从获取的列表选择聊天模型。
4. 填写 BotFather 给出的 Bot Token，核对显示的机器人身份。
5. 等待接收器就绪。模型、接收器和已启用技能准备好后，机器人自动激活；polling 模式无需注册 webhook。

向导支持中断后继续。GitHub 连接可按 [GitHub 指南](github.md) 完成；首次聊天不依赖源码索引或 Codex 执行环境。如果尚未激活，在 Setup 检查缺少的条件，并确认 Skills 中有已启用的已发布技能。

保存 Bot Token 会校验机器人身份；启用 polling 后，worker 会使用该 Token 向 Telegram 收取消息。保存模型供应商会获取模型列表，实际聊天会产生模型费用。

## 5. 加入工作区并发出第一条消息

面板管理员账号与 Telegram 身份分开管理。

1. 在面板打开 **Members & access**，复制当前显示的邀请链接。
2. 用自己的 Telegram 账号打开链接并发送 Start。此类邀请由首个使用者领取，加入为普通成员；给另一位成员邀请时复制新的链接。
3. 私聊机器人发送 `/help`，再发送“你好，介绍一下你能帮我做什么”。

也可以让用户先点击 **Request access**，由管理员在 **Access requests** 审批。详情见 [工作区与成员](administration.md)。

## 6. 接下来

- [Telegram 使用指南](telegram-experience.md)：对话、附件、状态与停止。
- [GitHub](github.md)：连接目标仓库和个人账号。
- [Code Truth](code-truth.md)：开启源码问答。
- [Codex](codex.md)：执行开发任务并生成 PR。
- [公开部署](deployment.md)：配置域名、HTTPS、webhook 和 Mini App。
- [备份与升级](maintenance.md)：开始长期使用前保护数据。

## 停止与再次启动

```sh
docker compose stop
docker compose up -d
```

`stop` 保留容器和数据。`docker compose down` 也默认保留命名数据卷；加上 `-v` 会删除数据卷，不要用于日常停止。机器人不回复时，按 [排障指南](troubleshooting.md) 检查。
