# dsh-kube

给 DeepSeek Harness 的 Kubernetes 工作台插件 —— 在 DSH 里浏览集群、操作资源、打开容器终端，并提供一组可被智能体调用的 kubectl 工具。

A Kubernetes workbench plugin for DeepSeek Harness — browse clusters and resources, operate on workloads, open in-container terminals, and expose a set of kubectl-backed tools the agent can call.

---

## 目录 / Contents

- [架构 / Architecture](#架构--architecture)
- [功能 / Features](#功能--features)
- [安装依赖 / Dependencies](#安装依赖--dependencies)
- [安装 / Installation](#安装--installation)
- [使用方法 / Usage](#使用方法--usage)
- [配置目录 / Configuration](#配置目录--configuration)
- [注意事项 / Caveats](#注意事项--caveats)
- [发布 / Publishing](#发布--publishing)

---

## 架构 / Architecture

插件是典型的 DSH bundle：一个**主机端**（host）加一个**浏览器端**（client），无构建步骤，直接由 DSH 加载。

The plugin is a standard DSH bundle with a **host** half and a **client** half — no build step, loaded directly by DSH.

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

The **host** (`index.js`) runs every `kubectl` call through the local kubectl binary. It registers HTTP routes (`/dsh-kube/*`, used by the panel) and agent tools. The **client** (`client.js`) is the browser side: sidebar entry, cluster/resource panel, right-drawer detail (YAML / Describe / Pod logs), in-container shell tab, and a rules-matrix tab. The terminal uses a real PTY via `node-pty` and renders with a vendored xterm.js.

---

## 功能 / Features

### 资源浏览 / Resource browsing

支持按类型列出并过滤：Pods、Deployments、StatefulSets、DaemonSets、Jobs、CronJobs、HPAs、VPAs、Services、Ingress、ConfigMaps、Secrets、PVC、Events、Nodes、Namespaces、ServiceAccounts、Roles、RoleBindings、ClusterRoles、ClusterRoleBindings、Users/Groups、CRDs。资源类型是一个**可搜索的组合框**（中文名或 kind 都能搜，↑/↓ 选择、Enter 确认、Esc 关闭）。点一行在右侧抽屉看 YAML、Describe、Pod 日志。

Supports listing/filtering by type across the common built-ins plus HPAs/VPAs, RBAC objects, Users/Groups, and CRDs. The resource-type box is **searchable** (by Chinese label or kind; ↑/↓ to select, Enter to confirm, Esc to close). Clicking a row opens a right drawer with YAML / Describe / Pod logs.

### CRD

资源类型下拉只列内置类型；`CRDs` 项展示集群已安装的 CustomResourceDefinition（Kind/Group/Scope/版本）。点击某行的 Kind 即进入该类型实例列表，顶部横幅以黄底 badge 提示当前显示的 group/kind，可一键返回。实例按 CRD 的 `additionalPrinterColumns` 展示。

The dropdown lists only built-in types; the `CRDs` entry shows installed CustomResourceDefinitions. Clicking a Kind drills into its instances (rendered with `additionalPrinterColumns`), with a banner showing the current group/kind and a one-click back.

### 容器终端 / In-container terminal

展开 Pod 行后，容器子表「登录」列有终端图标。后端在容器里探测 `bash`（没有则退到 `sh`），用 PTY 启动 `kubectl exec -it -- bash -i`，因此是**真实 tty**（提示符、回显、颜色、行编辑、Ctrl-C、`top`/`vim` 全可用）；前端用内置 xterm.js 渲染，面板尺寸变化会同步 `stty size`。关闭标签页会杀掉对应 kubectl 进程。

The container sub-table has a terminal icon. The backend probes `bash` (falling back to `sh`), launches a real PTY through `kubectl exec -it -- bash -i`, so you get a genuine tty; the client renders it with the vendored xterm.js and syncs `stty size` on resize. Closing the tab kills the kubectl process.

### YAML 编辑 / YAML editing

任意资源详情的 YAML 标签页都有「编辑」按钮；保存前弹窗提醒会应用到集群，确认后 `kubectl apply -f -`，失败原样显示 kubectl 报错，成功则重读该资源并刷新列表。**只读与编辑是同一个视图**（高亮层 + 文字透明的 textarea，光标绿色），编辑时排版、换行、滚动位置都不变，Esc 取消。编辑起点是后端用 js-yaml 从 `-o json` 重排的干净清单，嵌套对象/数组正确展开；**Secret 的 `data` 编辑时显示明文，保存时搬进 `stringData` 由 API server 负责 base64 编码**。Users/Groups 是聚合伪资源，不提供编辑。

Any resource's YAML tab has an **Edit** button; saving warns it will be applied to the cluster, runs `kubectl apply -f -`, surfaces kubectl errors verbatim, and on success re-reads the object and refreshes the list. Read and edit share one surface (a highlight layer under a transparent-text textarea with a green caret), so layout/line-wraps/scroll stay identical; Esc cancels. The draft is a clean re-serialization via js-yaml (nested objects/arrays render correctly); **Secret `data` is shown in plaintext while editing and moved into `stringData` on save** so the API server does the base64 encoding. Users/Groups are aggregated pseudo-resources and cannot be edited.

### 操作列 / Actions column

**所有**资源类型都带一列「操作」（弹出菜单），每类至少包含「删除」；工作负载（Deployment/StatefulSet/DaemonSet）另有滚动重启/回滚/扩缩副本。回滚会先读 `kubectl rollout history` 列出版本，默认选中上一个版本，可任选一个版本 `--to-revision=N`。扩缩填目标副本数。删除统一 `kubectl delete --wait=false`（命名空间类带 `-n`，集群级如命名空间/节点/CRD 不带；不等待 Pod 排空）。面板直接显示 kubectl 输出或原始报错。Users/Groups 没有操作列。

**Every** resource kind has an **Actions** dropdown with at least **Delete**; workloads additionally get rollout-restart / rollback / scale. Rollback reads `kubectl rollout history` and defaults to the previous revision (optionally `--to-revision=N`). Scale asks for the target replicas. Delete runs `kubectl delete --wait=false` (namespaced with `-n`, cluster-scoped without; does not wait for drain). The panel shows kubectl's output or raw error. Users/Groups have no actions.

### 节点 / Nodes

节点列表没有「规格」列，改为 **CPU** 与 **内存** 两列，值都是 `请求/容量`（如 `1.75/8`、`1.4Gi/32Gi`）：请求按容器聚合，**容量取 `status.capacity` 并取最近 2 的幂**（真实 `7.9` 核显示 `8`、`30.6Gi` 显示 `32Gi`），内存单位**一律二进制**（K/M/G 与 Ki/Mi/Gi 都按 1024，`32G`→`32Gi`）。**Pod 数列**变成 `已运行/可容纳`（如 `12/110`）。另有**类型**（`node.kubernetes.io/instance-type`）与**区域**（`topology.kubernetes.io/zone`）列。**状态**反映 Ready 条件；节点被 `kubectl cordon` 封锁时追加 `SchedulingDisabled`，状态逗号分隔后每个状态显示成独立徽标（Ready 绿 / SchedulingDisabled 黄 / 其它红）。节点操作新增**封锁/解封/排空**：`kubectl cordon|uncordon` 与 `kubectl drain --ignore-daemonsets --delete-emptydir-data`。

The Nodes list replaces the old spec column with **CPU** and **Memory** as `request/capacity` (e.g. `1.75/8`, `1.4Gi/32Gi`): requests are summed across containers, **capacity comes from `status.capacity` rounded to the nearest power of two** (7.9 cores shows `8`, 30.6Gi shows `32Gi`), and memory units are **always binary** (K/M/G and Ki/Mi/Gi all ×1024). The **Pods** column becomes `running/capacity` (e.g. `12/110`). There are also **Type** and **Zone** columns. **Status** reflects the Ready condition and appends `SchedulingDisabled` when a node is cordoned; comma-separated states render as separate badges. Node actions add **cordon / uncordon / drain**.

### RBAC 与规则矩阵 / RBAC & rules matrix

ServiceAccounts 显示密钥数，Roles/ClusterRoles 显示规则数，Bindings 显示 roleRef 与 subjects。Users/Groups 由所有绑定 subjects 聚合。Roles/ClusterRoles 的**规则数**是可点击链接，在右侧栏打开 **verb 矩阵**：表头 `资源 | API 组 | GET | LIST | WATCH | CREATE | PATCH | UPDATE | DELETE | DEL-LIST`，每个 rule 按 (API 组 × 资源) 展开一行（空用 `*`），同组同资源的动词取并集；有权限打**绿勾 ✓**，否则**红叉 ✗**。

ServiceAccounts show secret counts, Roles/ClusterRoles show rule counts, bindings show roleRef and subjects. Users/Groups are aggregated from binding subjects. The **rule count** is a clickable link that opens a K9S-style **verb matrix** in the right sidebar with columns `资源 | API 组 | GET | LIST | WATCH | CREATE | PATCH | UPDATE | DELETE | DEL-LIST`; each rule is expanded per (API group × resource) row, verbs are unioned, granted verbs show a **green ✓** and denied a **red ✗**.

### 集群与登录 / Clusters & login

每个 context 显示认证方式（OIDC / AWS IAM / Azure / Token / 证书）、探测状态与登录按钮。登录复用 kubeconfig 的 `exec` 凭据插件（`oidc-login`、`aws eks get-token` 等），DSH 只把授权 URL 送到浏览器、把授权码送进进程，**用户亲自点同意**；登录状态徽标取自实时观测，切换集群后立即更新。

Each context shows its auth method, probe status, and a login button. Login reuses the kubeconfig `exec` credential providers (`oidc-login`, `aws eks get-token`, …); DSH only hands the authorization URL to the browser and the code back into the process — **the user approves in person**. The login badge reflects live observation and updates immediately on cluster switch.

---

## 安装依赖 / Dependencies

运行插件需要：

- **DSH**：`engines.dsh` 要求 `0.2.0-rc.2 || >=0.2.1-rc.1 <0.3.0-0`；Node `>=22`。
- **本机 `kubectl`** 可执行（在 `$PATH` 中）。所有读写都通过它完成。
- **`node-pty`**：随 DSH 一起安装，容器终端依赖它（不需要单独装）。
- js-yaml 与 xterm.js 已内嵌在插件内，**无需外网或额外依赖**。
- Windows 下浏览器桥接依赖 WSL 的 `/mnt/c/Windows/System32/cmd.exe`；没有它时只能复制授权链接手动打开。

At runtime: **DSH** matching `engines.dsh` `0.2.0-rc.2 || >=0.2.1-rc.1 <0.3.0-0` and Node `>=22`; a local **`kubectl`** in `$PATH` (all reads/writes go through it); **`node-pty`** (ships with DSH) for the container terminal. js-yaml and xterm.js are vendored, so no network or extra deps. On Windows, browser bridging needs WSL's `/mnt/c/Windows/System32/cmd.exe`; without it you must copy the authorization link manually.

---

## 安装 / Installation

从插件市场索引安装（git source）：

```bash
# 在 GitHub 仓库的 Pages 页有 index.json 的情况下，DSH Web 里：
# Plugins → 实验性插件 → 自定义插件索引 → 添加 https://<owner>.github.io/dsh-kube/index.json
# 发现 → dsh-kube → 安装 → 重启 dsh web
```

装完后 **重启** dsh web（`systemctl --user restart deepseek-harness-web.service`，或 Web 里的重启入口）以加载主机端；浏览器端改动只需刷新页面。

Install from a plugin-market index (git source): add the index URL under Plugins → 实验性 plugins → custom plugin index, install, then **restart** dsh web so the host half loads (client-only changes just need a page refresh).

---

## 使用方法 / Usage

1. 左侧导航进入 **Kubernetes** 工作台。
2. 在「集群管理」里**粘贴 kubeconfig** 新增集群（同名覆盖更新），或移除集群。kubeconfig 由你提供，插件不会读取系统默认 `~/.kube/config`。
3. 选中集群，按需点「登录」完成 OIDC 认证（授权在你浏览器里点同意）。
4. 选命名空间与资源类型，搜索/过滤，点行看详情、编辑 YAML、看日志、开终端；用「操作」列做重启/回滚/扩缩/删除。
5. 智能体工具（写操作）默认只返回「需要确认」，需显式带 `confirm: true` 才执行。

1. Enter the **Kubernetes** workbench from the sidebar.
2. Under **cluster management**, **paste a kubeconfig** to add a cluster (same-name overwrites), or remove one. You provide the kubeconfig; the plugin does not read the system `~/.kube/config`.
3. Select a cluster and complete OIDC auth via **Login** (you approve in your browser).
4. Pick namespace/resource type, filter, click rows for detail / YAML edit / logs / terminal; use **Actions** for restart/rollback/scale/delete.
5. Agent write tools return a “needs confirmation” note until called with an explicit `confirm: true`.

---

## 配置目录 / Configuration

配置存放在 DSH 主目录下（不在真实用户主目录）：

- `~/.kube/dsh/configs/*.yaml`：各集群的 kubeconfig 副本（只能由插件 UI 或智能体写入）；
- `~/.kube/dsh/config`：把 `configs/` 用 `kubectl config view --flatten` 合并成的当前配置（kubectl 实际读取）；
- `~/.kube/dsh/dsh-kube-state.json`：当前选中集群。

所有 kubectl 调用都带 `--kubeconfig`（每次读对应集群文件），token/oidc-login 缓存落在 DSH 主目录内。

Config lives under the DSH home directory (not your real home): `~/.kube/dsh/configs/*.yaml` (per-cluster kubeconfig copies), `~/.kube/dsh/config` (the flattened current config kubectl actually reads), and `~/.kube/dsh/dsh-kube-state.json` (current cluster). Every kubectl call passes `--kubeconfig`; token/oidc-login caches land in the DSH home.

---

## 注意事项 / Caveats

- **破坏性操作**（节点封锁/解封/排空、删除、扩缩、回滚）会影响调度与运行负载。排空会删除 `emptyDir` 数据。请在非生产集群上先演练。
- **`dsh web` 重启**时 systemd 会同 cgroup 一起杀掉进程，正在跑的 kubectl 被信号终止（退出码 -1）。这只代表“请求被打断”，不是集群问题；面板会静默重试而非报错。
- 资源不缓存，每次读取都是实时 kubectl 调用（可能较慢，取决于集群规模）。
- 依赖本机 kubectl 与 kubeconfig 的 `exec` 凭据插件。
- 不读取系统默认 `~/.kube/config`；集群配置只能由你在面板中粘贴。

- **Destructive operations** (node cordon/uncordon/drain, delete, scale, rollback) affect scheduling and running workloads; drain deletes `emptyDir` data. Test on a non-production cluster first.
- When **`dsh web` restarts**, systemd kills the whole cgroup, so an in-flight kubectl is signal-terminated (exit code −1). That only means the request was interrupted, not a cluster problem; the panel retries silently instead of erroring.
- Resources are not cached — every read is a live kubectl call (can be slow on large clusters).
- Requires a local kubectl and the kubeconfig `exec` credential providers.
- Does not read the system `~/.kube/config`; cluster configs are pasted by you in the panel.

---

## 发布 / Publishing

仓库自带 GitHub Action（`.github/workflows/release.yml`），打 `v*` tag 时自动：

1. 校验 tag 版本与 `package.json` 一致；
2. `npm pack` 打包；
3. 用 `scripts/generate-index.mjs` 生成 DSH 插件市场索引 `site/index.json`（git source，固定到该 commit）；
4. 把索引部署到 GitHub Pages；
5. 创建 GitHub Release 并附上 `.tgz`。

仓库需在 Settings → Pages 把 Source 选为 **GitHub Actions**。索引地址即 `https://<owner>.github.io/<repo>/index.json`。

This repo ships a GitHub Action (`.github/workflows/release.yml`). On a `v*` tag it validates the version, `npm pack`s the bundle, generates the DSH plugin-market `site/index.json` (git source pinned to that commit) via `scripts/generate-index.mjs`, deploys it to GitHub Pages, and creates a GitHub Release with the `.tgz`. Enable **Settings → Pages → Source: GitHub Actions**; the index URL is `https://<owner>.github.io/<repo>/index.json`.
