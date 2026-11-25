# dsh-kube

> 🌐 **中文** | [English](README.en.md)

给 DeepSeek Harness 的 Kubernetes 工作台插件 —— 在 DSH 里浏览集群、操作资源、打开容器终端，并提供一组可被智能体调用的 kubectl 工具。

---

## 目录

- [架构](#架构)
- [功能](#功能)
- [安装依赖](#安装依赖)
- [安装](#安装)
- [使用方法](#使用方法)
- [配置目录](#配置目录)
- [注意事项](#注意事项)
- [发布](#发布)

---

## 架构

插件是典型的 DSH bundle：一个**主机端**（host）加一个**浏览器端**（client），无构建步骤，直接由 DSH 加载。

```
dsh-kube/
├── index.js            # 主机端（Node/Cordis）：kubectl 执行、HTTP 路由、agent 工具
├── client.js           # 浏览器端：资源面板、终端、抽屉详情 UI
├── cordis.patch.yml    # bundle patch：把插件行插入 profile 组合
├── locale/{zh,en}.json # 界面文案（中英）
├── lib/js-yaml.cjs     # 内嵌 js-yaml（YAML 编辑的干净清单/重排）
├── assets/             # 内嵌 xterm.js 终端静态资源
├── icon.svg
└── docs/DETAIL.md      # 插件详情页文档
```

- **主机端 `index.js`**：所有 `kubectl` 调用都发生在这里，走本机 kubectl 二进制。它注册了一组 HTTP 路由（`/dsh-kube/*`，供面板调用）和一组 agent 工具（`kube_contexts`、`kube_get`、`kube_crds`、`kube_describe`、`kube_logs`、`kube_apply`、`kube_scale`、`kube_rollout`、`kube_delete`、`kube_login`）。容器终端由后端用 `node-pty`（随 DSH 安装）启动一个真实 PTY，跑 `kubectl exec -it -- bash -i`。
- **浏览器端 `client.js`**：DSH 的 web UI 侧。注册左侧导航入口、集群/资源面板、右侧抽屉（YAML/Describe/Pod 日志）、容器 shell 标签页、规则矩阵标签页。终端用内置的 xterm.js 渲染。
- **`cordis.patch.yml`**：把 `{id: kube, name: 'dsh-kube'}` 这一行插入 profile 的插件组合，从而被 DSH 实例化。

---

## 功能

### 资源浏览

支持按类型列出并过滤：Pods、Deployments、StatefulSets、DaemonSets、Jobs、CronJobs、HPAs、VPAs、Services、Ingress、ConfigMaps、Secrets、PVC、Events、Nodes、Namespaces、ServiceAccounts、Roles、RoleBindings、ClusterRoles、ClusterRoleBindings、Users/Groups、CRDs。资源类型是一个**可搜索的组合框**（中文名或 kind 都能搜，↑/↓ 选择、Enter 确认、Esc 关闭）。点一行在右侧抽屉看 YAML、Describe、Pod 日志。

### CRD

资源类型下拉只列内置类型；`CRDs` 项展示集群已安装的 CustomResourceDefinition（Kind/Group/Scope/版本）。点击某行的 Kind 即进入该类型实例列表，顶部横幅以黄底 badge 提示当前显示的 group/kind，可一键返回。实例按 CRD 的 `additionalPrinterColumns` 展示；**大列表走 `custom-columns` 投影**（24MB 的 JSON 实例列表可缩到 ~70KB），不会触到输出上限；若该 CRD 没有 printer 列或 kubectl 拒绝表达式，会自动回退完整 JSON 路径。

### 容器终端

展开 Pod 行后，容器子表「登录」列有终端图标。后端在容器里探测 `bash`（没有则退到 `sh`），用 PTY 启动 `kubectl exec -it -- bash -i`，因此是**真实 tty**（提示符、回显、颜色、行编辑、Ctrl-C、`top`/`vim` 全可用）；前端用内置 xterm.js 渲染，面板尺寸变化会同步 `stty size`。关闭标签页会杀掉对应 kubectl 进程。

### YAML 编辑

任意资源详情的 YAML 标签页都有「编辑」按钮；保存前弹窗提醒会应用到集群，确认后 `kubectl apply -f -`，失败原样显示 kubectl 报错，成功则重读该资源并刷新列表。**只读与编辑是同一个视图**（高亮层 + 文字透明的 textarea，光标绿色），编辑时排版、换行、滚动位置都不变，Esc 取消。编辑起点是后端用 js-yaml 从 `-o json` 重排的干净清单，嵌套对象/数组正确展开；**Secret 的 `data` 编辑时显示明文，保存时搬进 `stringData` 由 API server 负责 base64 编码**。Users/Groups 是聚合伪资源，不提供编辑。

### 操作列

**所有**资源类型都带一列「操作」（弹出菜单），每类至少包含「删除」；工作负载（Deployment/StatefulSet/DaemonSet）另有滚动重启/回滚/扩缩副本。回滚会先读 `kubectl rollout history` 列出版本，默认选中上一个版本，可任选一个版本 `--to-revision=N`。扩缩填目标副本数。删除统一 `kubectl delete --wait=false`（命名空间类带 `-n`，集群级如命名空间/节点/CRD 不带；不等待 Pod 排空）。面板直接显示 kubectl 输出或原始报错。Users/Groups 没有操作列。

### 节点

节点列表没有「规格」列，改为 **CPU** 与 **内存** 两列，值都是 `请求/容量`（如 `1.75/8`、`1.4Gi/32Gi`）：请求按容器聚合，**容量取 `status.capacity` 并取最近 2 的幂**（真实 `7.9` 核显示 `8`、`30.6Gi` 显示 `32Gi`），内存单位**一律二进制**（K/M/G 与 Ki/Mi/Gi 都按 1024，`32G`→`32Gi`）。**Pod 数列**变成 `已运行/可容纳`（如 `12/110`）。另有**类型**（`node.kubernetes.io/instance-type`）与**区域**（`topology.kubernetes.io/zone`）列。**状态**反映 Ready 条件；节点被 `kubectl cordon` 封锁时追加 `SchedulingDisabled`，状态逗号分隔后每个状态显示成独立徽标（Ready 绿 / SchedulingDisabled 黄 / 其它红）。节点操作新增**封锁/解封/排空**：`kubectl cordon|uncordon` 与 `kubectl drain --ignore-daemonsets --delete-emptydir-data`。

### 排序与过滤

**所有**资源类型都支持按**名称/存在时长**排序（有命名空间列时也支持命名空间）：点表头循环 升序 → 降序 → 取消。**Pod 列表**额外支持命名空间、状态、Pod IP 排序，并可对**状态**与**所在节点**做多选过滤；**节点列表**支持 CPU/内存/Pod 数/架构/类型/区域/存在时长排序，并可对**架构/类型/区域**做多选过滤。过滤入口是表头里的**漏斗图标**（显示已选数量，不占行高），点开是可搜索的复选框面板；排序用的是底层真实数值（存在时长能解析 kubectl 的 `3y323d` 这类人类文本，所以即使显示值是文字也能正确排序）。

### RBAC 与规则矩阵

ServiceAccounts 显示密钥数，Roles/ClusterRoles 显示规则数，Bindings 显示 roleRef 与 subjects。Users/Groups 由所有绑定 subjects 聚合。Roles/ClusterRoles 的**规则数**是可点击链接，在右侧栏打开 **verb 矩阵**：表头 `资源 | API 组 | GET | LIST | WATCH | CREATE | PATCH | UPDATE | DELETE | DEL-LIST`，每个 rule 按 (API 组 × 资源) 展开一行（空用 `*`），同组同资源的动词取并集；有权限打**绿勾 ✓**，否则**红叉 ✗**。

### 集群与登录

每个 context 显示认证方式（OIDC / AWS IAM / Azure / Token / 证书）、探测状态与登录按钮。登录复用 kubeconfig 的 `exec` 凭据插件（`oidc-login`、`aws eks get-token` 等），DSH 只把授权 URL 送到浏览器、把授权码送进进程，**用户亲自点同意**；登录状态徽标取自实时观测，切换集群后立即更新。

### 集群读写模式

集群管理里每个集群可用下拉框设置**读写**（默认）或**只读**（选择持久化到 `dsh-kube-state.json`）。只读模式下：所有资源列表的**操作列消失**、详情抽屉的**编辑按钮隐藏**、智能体**写工具**（`kube_apply`/`kube_scale`/`kube_rollout`/`kube_delete`）拒绝执行并返回明确错误；读操作与登录不受影响，面板顶部显示黄底「只读」徽标。

---

## 安装依赖

运行插件需要：

- **DSH**：`engines.dsh` 要求 `0.2.0-rc.2 || >=0.2.1-rc.1 <0.3.0-0`；Node `>=22`。
- **本机 `kubectl`** 可执行（在 `$PATH` 中）。所有读写都通过它完成。
- **OIDC 登录**（kubeconfig 的 `exec` 命令为 `oidc-login` 时）：需要安装 kubectl 插件 [kubelogin](https://github.com/int128/kubelogin)（命令名 `oidc-login`）并确保其在 `$PATH`。安装方法见其[安装文档](https://github.com/int128/kubelogin#installation)。
- **`node-pty`**：随 DSH 一起安装，容器终端依赖它（不需要单独装）。
- js-yaml 与 xterm.js 已内嵌在插件内，**无需外网或额外依赖**。
- Windows 下浏览器桥接依赖 WSL 的 `/mnt/c/Windows/System32/cmd.exe`；没有它时只能复制授权链接手动打开。

---

## 安装

从插件市场索引安装（git source）：在 DSH Web 里 Plugins → 实验性插件 → 自定义插件索引 → 添加索引 URL → 发现里安装 dsh-kube。装完后**重启** dsh web（`systemctl --user restart deepseek-harness-web.service`，或 Web 里的重启入口）以加载主机端；浏览器端改动只需刷新页面。

---

## 使用方法

1. 左侧导航进入 **Kubernetes** 工作台。
2. 在「集群管理」里**粘贴 kubeconfig** 新增集群（同名覆盖更新），或移除集群。kubeconfig 由你提供，插件不会读取系统默认 `~/.kube/config`。
3. 选中集群，按需点「登录」完成 OIDC 认证（授权在你浏览器里点同意）。
4. 选命名空间与资源类型，搜索/过滤，点行看详情、编辑 YAML、看日志、开终端；用「操作」列做重启/回滚/扩缩/删除。
5. 智能体工具（写操作）默认只返回「需要确认」，需显式带 `confirm: true` 才执行。

---

## 配置目录

配置存放在 DSH 主目录下（不在真实用户主目录）：

- `~/.kube/dsh/configs/*.yaml`：各集群的 kubeconfig 副本（只能由插件 UI 或智能体写入）；
- `~/.kube/dsh/config`：把 `configs/` 用 `kubectl config view --flatten` 合并成的当前配置（kubectl 实际读取）；
- `~/.kube/dsh/dsh-kube-state.json`：当前选中集群。

所有 kubectl 调用都带 `--kubeconfig`（每次读对应集群文件），token/oidc-login 缓存落在 DSH 主目录内。

---

## 注意事项

- **破坏性操作**（节点封锁/解封/排空、删除、扩缩、回滚）会影响调度与运行负载。排空会删除 `emptyDir` 数据。请在非生产集群上先演练。
- **`dsh web` 重启**时 systemd 会同 cgroup 一起杀掉进程，正在跑的 kubectl 被信号终止（退出码 -1）。这只代表“请求被打断”，不是集群问题；面板会静默重试而非报错。
- 资源不缓存，每次读取都是实时 kubectl 调用（可能较慢，取决于集群规模）。
- 依赖本机 kubectl 与 kubeconfig 的 `exec` 凭据插件。
- 不读取系统默认 `~/.kube/config`；集群配置只能由你在面板中粘贴。

---

## 发布

仓库自带 GitHub Action（`.github/workflows/release.yml`），打 `v*` tag 时自动：

1. 校验 tag 版本与 `package.json` 一致；
2. `npm pack` 打包；
3. 用 `scripts/generate-index.mjs` 生成 DSH 插件市场索引 `site/index.json`（git source，固定到该 commit）；
4. 把索引部署到 GitHub Pages；
5. 创建 GitHub Release 并附上 `.tgz`。

仓库需在 Settings → Pages 把 Source 选为 **GitHub Actions**。索引地址即 `https://<owner>.github.io/<repo>/index.json`。
