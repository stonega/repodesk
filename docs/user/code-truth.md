# 代码问答：Code Truth

Code Truth 为指定 GitHub 仓库建立源码索引，让机器人回答“代码在哪里”“调用关系是什么”等问题，并给出文件位置、分支和 commit。它不执行仓库构建，也不替代实时 Issue/PR 查询。

管理员需要先启动可选服务，再在各工作区配置仓库。只查看 GitHub PR 状态不需要本服务。

## 启动服务

在现有 RepoDesk 仓库根目录生成独立服务令牌，仅首次执行：

```sh
mkdir -p secrets
chmod 700 secrets
(umask 077; set -C; openssl rand -hex 32 > secrets/code-truth-token)
chmod 644 secrets/code-truth-token
```

令牌文件必须能被容器服务用户读取，父目录保持私有。不要覆盖已有令牌。

编辑 `.env`，在原有配置上设置：

```dotenv
COMPOSE_FILE=compose.yaml:examples/code-truth.compose.yaml
```

已经配置 Codex 等叠加文件时，保留并合并，例如：

```dotenv
COMPOSE_FILE=compose.yaml:examples/code-truth.compose.yaml:deploy/codex/compose.yaml
```

然后启动：

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

该服务只在内部网络提供接口，索引保留在 `code_truth_data` 数据卷。Compose 会将服务地址和令牌提供给 app/worker，无需在面板填写令牌。Docker 会构建服务依赖，宿主机无需额外安装 Bun。

## 配置工作区仓库

1. 私有仓库先完成 [GitHub App 连接](github.md)。
2. 打开 **Workspace → Plugins → Code Truth → Add repository**。
3. 输入标准 HTTPS GitHub URL，例如 `https://github.com/example/app.git`。
4. 可选填写仓库用途说明，帮助机器人判断何时查询该仓库。
5. 启用 Code Truth 并保存。
6. 展开 **Repository indexing status**，点击 **Sync & check indexes**；索引完成后再次检查。

仓库内部 ID 自动生成，分支跟随 GitHub 当前默认分支，无需手动设置网络或分支。就绪状态显示实际分支、commit SHA 和索引时间。每个工作区最多配置十二个不同仓库，其他工作区独立管理。

只支持 `github.com` 的 HTTPS 仓库，不支持 SSH、GitLab、本地目录或 URL 内的凭据。私有仓库使用工作区 App 的受限读取权限，不需要在面板输入个人令牌。

## 提问与检查引用

例如：

> example/app 的登录中间件在哪里？说明校验流程，并给出对应文件和行号。

核对回答的分支、commit 和代码位置。索引反映某个快照，不能证明线上最新状态。刷新失败时可能继续使用上一可用快照，查看面板时间和 commit。

使用时会触发索引检查，刷新间隔至少约五分钟；首次启用时索引可能还在准备。需要实时 PR/Issue 元数据时，让机器人使用 GitHub 查询。

## 关闭与删除

在插件页面停用会停止相关工具访问，但磁盘上的旧索引不会自动全部删除。工作区数据删除与源码副本清理分开处理；需要擦除时，先停止 Code Truth，再由管理员清理数据卷中对应的过期索引目录。

不要直接删除正在使用的快照。索引可从 GitHub 重建，前提是对应 commit 仍可获取；备份需求见 [维护指南](maintenance.md)。
