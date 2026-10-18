# 备份、升级与恢复

长期使用前确定数据备份位置、密钥保管方式和负责恢复的人。以下命令在原部署目录运行，沿用原 `.env`、Compose 项目名和叠加文件。

## 需要保留的内容

| 内容 | 原因 |
| --- | --- |
| PostgreSQL 数据与备份 | 工作区、配置、任务、历史和账务状态 |
| `secrets/encryption-key` | 解密已保存的机器人、模型和连接凭据 |
| `.env` 与部署配置 | 恢复同一数据库、地址、项目和服务拓扑 |
| Codex runner 管理令牌和状态卷 | 账号认证及任务恢复，二者需匹配 |
| Code Truth 数据卷 | 可选索引缓存，可在仓库 commit 仍可获取时重建 |

数据库备份与密钥分开保护，并保留加密的离机副本。只备份数据库不能恢复凭据；直接换密钥不会重新加密已有数据。

## 数据库备份与演练

源码安装可使用随仓库提供的脚本：

```sh
bash scripts/backup.sh
```

脚本生成权限受限的 `backups/deepx-<UTC 时间>.dump`。安排定时执行、离机复制和备份保留策略，避免只在同一块磁盘保存副本。

使用实际文件名验证恢复：

```sh
bash scripts/restore-rehearsal.sh backups/YOUR_BACKUP.dump
```

演练在临时同级数据库恢复并检查，结束后删除临时库，不覆盖当前应用数据库。完整灾难恢复还需检查密钥、runner 状态和外部操作，不能仅以演练通过代替。

## 源码 Compose 安装升级

1. 阅读目标发布说明，确认数据库和配置变化，记录当前版本、Git commit、镜像和部署配置。
2. 等待 Codex 工作结束，或明确停止后确认终止。暂停新请求，安排维护窗口。
3. 停止 app/worker；启用 runner 时也停止 runner。不要停止或删除数据库数据卷。
4. 备份数据库、密钥和相关状态，再切换到目标发布标签。
5. 从同一版本构建所有已启用的镜像并启动。不要混用旧 runner 与新应用。
6. 检查迁移、就绪、面板版本和一次小范围问答，再恢复使用。

基础命令如下；将标签替换为已审阅的真实发布标签，保留本地配置，不覆盖尚未处理的修改：

```sh
docker compose stop app worker
bash scripts/backup.sh
git fetch --tags origin
git checkout YOUR_RELEASE_TAG
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
curl --fail http://localhost:3000/readyz
```

启用 Codex 时，前述停止步骤另执行 `docker compose stop codex-runner`；切换版本后、启动前，另构建任务镜像：

```sh
docker build --target codex-job -t localhost/deepx-codex-job:local .
```

如果使用自定义镜像名，构建对应配置的 tag。Code Truth 叠加文件也应保持选中。数据库迁移由 Compose 的 `migrate` 服务执行；失败时保持写入服务停止，检查原因后处理。

升级不会代替你注册 Telegram webhook、接受 GitHub 新权限或配置 BotFather。按发布说明完成这些操作。

## 面板更新

登录后，版本旁出现更新箭头时可以查看新版本说明。查看说明不会安装更新；**Update now** 需要部署管理员明确操作，且宿主机已配置更新器。

面板安装目前适用于专用 Linux x86_64 Docker VPS。自定义 Compose、可选 Code Truth 等服务不能直接假定由更新器接管，使用上面的手动升级方式。已有专用 VPS 更新器时，保持部署目录、项目名和状态卷不变。

### 为专用 VPS 安装更新器

仅在准备使用专用 VPS 更新方式时执行。它会管理基础应用和 Docker Codex runner，不负责保留自定义 Compose 叠加服务。已有自定义部署先规划迁移，不要直接让更新器覆盖它。

宿主机需要 Node 24、Git、Docker Engine、Compose v2（支持 `up --wait`）、Bash、gzip、sha256sum 和 flock。下面按部署目录 `/opt/repodesk`、Compose 项目名 `repodesk` 举例；实际值必须与已有运行栈一致，不能因安装更新器而随意改名。

在匹配当前版本的源码目录执行：

```sh
sudo install -d -m 700 /opt/repodesk/updater
sudo install -m 700 scripts/update-host.mjs /opt/repodesk/updater/update-host.mjs
sudo install -m 700 scripts/cleanup-host.mjs /opt/repodesk/updater/cleanup-host.mjs
sudo install -d -o 1000 -g 1000 -m 700 /opt/repodesk/updates /opt/repodesk/updates/requests
sudo install -m 644 deploy/updates/repodesk-updater.service /etc/systemd/system/repodesk-updater.service
```

启用前编辑 `/etc/systemd/system/repodesk-updater.service`，核对 `WorkingDirectory`、`ExecStart` 中的 Node 路径、部署根目录、项目名和 GitHub 仓库。模板默认仓库为 `stonega/repodesk`，默认以 root 运行；使用其他服务账号时，确保它可访问 Docker、私有配置和更新队列。

fork 在 `.env` 设置 `UPDATES_GITHUB_REPOSITORY=owner/repository`，并与服务参数一致。公共仓库无需 Token；私有源或 API 限额需要时，使用 Contents/Actions 只读凭据，按服务模板的文件配置保管，勿授予部署工作流写权限。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now repodesk-updater
docker compose up -d
```

基础 Compose 将部署目录的 `updates/` 挂载给 app，与宿主机更新器共享队列。确认面板检测到更新器就绪，再安装已审阅的稳定发布。更新器会校验所选 commit 的 Verify 结果，并在宿主机构建镜像后切换服务。

面板显示 queued/running/completed/failed。更新会等待安全检查点、备份、迁移并检查就绪，可能短暂不可用。失败先读日志并修复原因，再使用 **Retry update**；不要在结果未知时重复切换或删除数据卷。

更新器服务检查使用 `systemctl status repodesk-updater` 或 `journalctl -u repodesk-updater`；详细日志保存在部署目录的 `updates/logs/`。只在受保护环境中查看，分享前脱敏。

## 灾难恢复

先停止写入，在新的数据库或卷恢复备份，提供匹配密钥和部署配置。隔离环境中先关闭对外投递，验证 schema、凭据解密和状态，再明确切换流量。

备份无法证明快照之后的外部动作是否成功。恢复后先核对处于 running/sending/unknown 的任务、Telegram 消息、GitHub PR 和费用，再恢复 worker。不要对未知写入自动重放。

迁移后不能直接假设旧镜像兼容新 schema。优先修复后向前升级；确认兼容性前不自动回退镜像或覆盖数据库。

## 日常维护

检查 `/readyz`、磁盘余量、待处理任务和未知费用/交付。清理旧镜像、缓存、索引或备份前确认保留范围，不使用 `docker compose down -v` 或全局卷清理作为常规维护。

日志查看与常见故障见 [排障指南](troubleshooting.md)。删除工作区时，按策略另处理备份和源码索引副本。
