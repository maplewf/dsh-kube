# Kubernetes 面板

给 DeepSeek Harness 加一个 Kubernetes 工作台：左侧栏入口、集群与资源浏览面板，以及一组由智能体调用的 kubectl 工具。

## 它怎么拿权限

插件不实现自己的登录协议，而是完整复用 kubeconfig 的 `exec` 凭据插件：

- 每个请求都由本机 `kubectl` 发起，`KUBECONFIG` 指向插件自己的合并文件，因此 `oidc-login`、`aws eks get-token`、Azure `kubelogin` 等 provider 与终端行为一致。
- `HOME` 指向 DSH 主目录，token 缓存（`~/.kube/cache/oidc-login`）落在 DSH 主目录内；AWS SSO 凭据仍从真实登录目录的 `~/.aws` 读取（多为 Windows/OneDrive 符号链接）。
- OIDC（kubelogin）登录由面板直接驱动：按 kubeconfig 里的 `exec.command`/`args` 拉起进程，追加 `--skip-open-browser`（或设备码/键盘模式），从输出里抓出授权 URL，经 WSL 互操作用 Windows 默认浏览器打开，OAuth 回调落在 kubelogin 自己的 `127.0.0.1` 监听上。

需要用户亲自完成的那一步（在浏览器里点同意、或输入设备码）永远留给用户；插件只负责把 URL 送到浏览器、把授权码送进进程。

## 配置目录

默认配置存放在 DSH 主目录下：

- `~/.kube/dsh/configs/*.yaml`：各集群的 kubeconfig 副本（只能由插件 UI 或智能体写入）；
- `~/.kube/dsh/config`：把所有 `configs/` 文件用 `kubectl config view --flatten` 合并成的当前配置，也是 kubectl 实际读取的文件；
- `~/.kube/dsh/dsh-kube-state.json`：当前选中的集群。

面板的集群管理页可以：

- 粘贴任意 kubeconfig 内容新增一个集群（同名保存即覆盖更新）；
- 移除某个集群。

合并时多个文件会一起作为 `KUBECONFIG`（按 `:` 连接）交给 kubectl，所以同名 context 以先出现的文件为准。

## 重启与失败提示

`dsh web` 重启时 systemd 会连同 cgroup 一起杀掉进程，正在跑的 `kubectl` 因此被信号终止：没有 stderr，退出码是 -1。这类失败只代表“请求被打断”，不代表集群或 kubectl 有问题，所以后端把它归类为 `restarting`，前端不显示红色横幅，而是 1.5 秒后静默重试（最多 6 次，成功即清零）。

真正的失败仍会显示在列表上方，并且区分原因：

- 超时：`kubectl get … 超过 30 秒没有返回，已终止（30.0s）`（超时不再进退避缓存，避免旧错误反复出现）
- 被信号终止：`kubectl … 被信号 SIGKILL 终止`
- 其它：kubectl 的原始 stderr

每次超时/信号终止都会在 `dsh web` 日志里留一行 `[dsh-kube] <cluster> <args>: timeout|signal …`，用 `journalctl --user -u deepseek-harness-web.service | grep dsh-kube` 可以直接看到是哪种。

## 面板

- **资源**：选集群、命名空间、资源类型（Pods/Deployments/StatefulSets/DaemonSets/Jobs/CronJobs/HPAs/VPAs/Services/Ingress/ConfigMaps/Secrets/PVC/Events/Nodes/Namespaces/ServiceAccounts/Roles/RoleBindings/ClusterRoles/ClusterRoleBindings/Users/Groups/CRDs），按名称过滤，点一行在右侧抽屉看 YAML、Describe、Pod 日志。资源类型是可搜索的组合框：点开后在输入框里打关键字（中文名或 kind 都行），↑/↓ 选择、Enter 确认、Esc 关闭。**Pod 列表**的列（名称/命名空间/状态/存在时长/Pod IP/所在节点）表头可点击排序（升序→降序→取消，活动列标黄色并带 ↑/↓ 箭头，存在时长按创建时间排序）；状态/Pod IP/所在节点三列在表头内各有一个**多选下拉菜单**（默认「全部」，点开是可搜索的复选框列表，可勾选多个离散值，如同时选 Running 和 CrashLoopBackOff），与顶部的按名称过滤叠加。
- **CRD**：资源类型下拉只列内置类型；`CRDs` 项展示集群已安装的 CustomResourceDefinition（Kind/Group/Scope/版本）。点击某行的 Kind 即进入该类型的实例列表：资源类型下拉仍停留在 `CRDs`，不会被 CRD 类型顶替；顶部横幅以黄底 badge 显示「正在显示 <group> 下的 <kind>」，可一键返回 CRDs；实例按 CRD 的 additionalPrinterColumns 展示。实例列表**不取整份 `-o json`**，而是用 `kubectl get -o custom-columns` 只投影名称/命名空间/创建时间 + CRD 声明的 printer 列（Argo Application 这类对象整份 JSON 约 24MB，接近 stdout 24MB 上限，投影后约 70KB），再由后端按 printer 列拼出「状态/其他」两列，渲染结果与 JSON 路径一致；CRD 没声明 printer 列、或投影表达式被 kubectl 拒绝时自动退回 JSON 路径。
- **容器 Shell**：展开 Pod 行后，容器子表的「登录」列有一个终端图标。点击后由后端在该容器里探测 `bash`，没有则退到 `sh`；两者都没有时弹窗说明无法打开。可用时在右侧栏新开一个 shell 标签页：后端用 PTY（node-pty，随 DSH 一起安装）启动 `kubectl exec -it -- bash -i`，所以容器里是**真实 tty**（提示符、回显、颜色、行编辑、Ctrl-C、`top`/`vim` 这类全屏程序都可用）；前端用随插件内置的 xterm.js 渲染，面板尺寸变化会同步 `stty size`。关闭该标签页会杀掉对应的 kubectl 进程。xterm 静态文件由 `/dsh-kube/assets/` 提供，不需要构建步骤或外网。
- **HPA / VPA**：HPAs 显示引用目标（`Deployment/xxx`）、当前/目标指标、副本范围（最小 → 最大 · 当前）；VPAs 显示更新模式、CPU/内存推荐值与 Provided 状态。VPA 是 CRD，集群没装时列表返回「没有提供 verticalpodautoscalers 资源类型」并缓存 5 分钟，不会每次刷新都重试。
- **YAML 编辑**：任意资源的详情里 YAML 标签页都有「编辑」按钮，改完点「保存」会先弹窗提醒「将把这份 YAML 应用到集群」，确认后才执行 `kubectl apply -f -`。失败时把 kubectl 的原始报错（schema 校验、RBAC 拒绝、不可变字段冲突等）原样显示在详情里，不改动页面其它内容；成功后重新读取该资源（显示 API server 实际存下的内容），并刷新左侧资源列表。Users/Groups 是聚合出来的伪资源，没有可供 apply 的对象，因此不提供编辑。编辑起点是后端用 js-yaml 从 `-o json` 重排出的干净清单：去掉 `status` 与 `managedFields/resourceVersion/uid/generation/creationTimestamp/selfLink`，所以嵌套对象/数组（容器、端口、resources、拓扑等）都正确展开，不再出现「字段变成 object」。**Secret 的 `data` 编辑时显示明文**（base64 解码后的值，多行值用 `|-` 块标量）；保存时后端先把每个明文值搬进 `stringData`（`data` 移除），再由 API server 负责 base64 编码——这就是「编辑明文、保存时编码」的实现，读视图（详情面板）始终显示解码后的明文，与应用后实际存下的一致。

  只读与编辑是同一个视图：底层是语法高亮层，上面叠一个文字透明的 textarea（光标绿色），所以点「编辑」时字体、配色、换行、滚动位置都不变，只是多出光标；滚动与宽度由 `ResizeObserver` 同步，Esc 取消编辑，保存/取消之外没有第二套排版。
- **操作列**：**所有**资源类型（Pod、工作负载、服务、ConfigMap、Secret、PVC、命名空间、节点、Ingress、HPA/VPA、RBAC 相关、CRD 等）都带一列「操作」，点开后是弹出菜单，**每类至少包含「删除」**。工作负载（Deployment/StatefulSet/DaemonSet）另有「滚动重启」「回滚」「扩缩副本」；DaemonSet 没有副本数，因此不提供扩缩。唯一没有操作列的是 Users/Groups——它们是从绑定聚合出来的伪行，没有可删除的实体对象。选中后弹出确认面板：写明是哪种操作、作用于哪个 `type/name`、在哪个命名空间，以及会发生什么（非工作负载的删除用通用文案）。**回滚**会先读 `kubectl rollout history` 列出版本，默认选中上一个版本，用户可任选一个具体版本回滚（`kubectl rollout undo --to-revision=N`）；只有一个版本时无法回滚，「执行」被禁用。**扩缩**时面板里填目标副本数（默认当前值）。点「执行」才真正下发：`kubectl rollout restart|undo`、`kubectl scale --replicas`，以及统一走 `kubectl delete --wait=false` 的删除（命名空间类资源带 `-n`，集群级资源如命名空间/节点/CRD 不带；不等待 Pod 排空，避免面板卡住）。面板直接显示 kubectl 的输出或原始报错（例如缩容超过可用节点、RBAC 拒绝、指定的版本号不存在）；成功后面板显示结果，关掉时按当前集群/类型/命名空间刷新列表，被删的行消失、扩缩后的副本数立刻变化。
- **节点**：节点列表没有「规格」列，改为 **CPU** 与 **内存** 两列，值都是 `请求/容量`：CPU 形如 `1.75/8`（请求汇总为毫核后换算成核数，**容量取 `status.capacity` 并取最近 2 的幂**，如真实 `7.9` 核显示为 `8`），内存形如 `1.4Gi/32Gi`（请求按字节求和后转成 Gi/Mi/Ki，**容量取 `status.capacity` 并取最近 2 的幂**，如真实 `30.6Gi` 显示为 `32Gi`）。**不用 `status.allocatable`**——它扣掉了 kube/system-reserved 与驱逐预留，数值既偏小又不是 2 的幂。内存单位**一律用二进制（2 的幂）**：K/M/G/T/P 和 Ki/Mi/Gi/Ti/Pi 都按 1024 进制换算，所以 `32G` 显示成 `32Gi` 而不是 `29.8Gi`。若容量带小写 `m` 后缀（毫字节，如 `28725966274560m`），按 ×10⁻³ 先换算成字节再转二进制显示（`28725966274560m` → `26.8Gi`），不与大写 `M`/`Mi` 混淆。**Pod 数**列也改成 `已运行/可容纳`，如 `12/110`（已运行统计 `spec.nodeName` 等于该节点的所有命名空间 Pod，可容纳取自 `status.capacity.pods`）。节点用量统计只用一条 jsonpath 投影（`get pods -A` 每行一个 Pod：节点/CPU 请求/内存请求）而不是整份 `-o json`——后者在 qa 这类 1400+ Pod 的集群上是 45MB，超出 stdout 24MB 上限会被截断、JSON 解析失败，导致用量全显示 0；投影后只有约 80KB。若这条查询失败，用量位置显示 `—`（容量照常显示），避免把读取失败误认成「节点空闲」。**Pod** 列（`已运行/可容纳`）的值本身就是一个可点击的链接，点击跳到 Pod 资源列表，并自动用「所在节点」列的多选过滤器锁定到该节点（列表按全命名空间展示，因为同一节点上的 Pod 可能分散在多个命名空间）。**类型**列取标签 `node.kubernetes.io/instance-type`（如 `ecs.c6.xlarge`），**区域**列取标签 `topology.kubernetes.io/zone`（如 `cn-beijing-1`），节点没打这两个标签时留空。**排序与过滤**：节点列表的 CPU、内存、Pod、架构、类型、区域、存在时长 七列都可点表头排序（升序→降序→取消，活动列黄色 + ↑/↓ 箭头）。CPU/内存/Pod 按 `请求/容量` 里的**分子**数值排序（CPU 统一换算成毫核，内存换算成字节，Pod 取整数，`—` 视为最小值排在最前）；存在时长按创建时间排序；架构/类型/区域按文本排序。**架构、类型、区域**三列在表头里另有**多选下拉菜单**（复用 Pod 列的同款漏斗图标组件，默认「全部」，点开是可搜索的复选框列表，选项来自当前列表的真实取值），多列过滤与顶部按名称过滤叠加生效。**状态**列反映 Ready 条件；节点被 `kubectl cordon` 封锁（`spec.unschedulable`）时，即使 Ready 仍是 True，状态会追加 `,SchedulingDisabled`（如 `Ready,SchedulingDisabled`）。状态列用逗号分隔后**每个状态显示成一个独立徽标**：Ready 绿底白字、SchedulingDisabled 黄底（#ffd60a）白字加粗、其它（NotReady/Unknown 等）红底白字；多状态并排（如 `NotReady,SchedulingDisabled`）。节点操作新增「封锁」「解封」「排空」：封锁/解封分别下发 `kubectl cordon|uncordon <node>`，排空下发 `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`（DaemonSet 保留、空目录数据会被删除），三者都作用于集群级节点、不区分命名空间，错误（如节点上有未受管理 Pod 导致排空被拒）直接透传 kubectl 的原始输出。这些是影响调度的破坏性操作，面板会先明确提示后果。
- **RBAC**：ServiceAccounts 显示密钥数，Roles/ClusterRoles 显示规则数，RoleBindings/ClusterRoleBindings 显示 roleRef 与 subjects。Users/Groups 不是原生资源，由所有 RoleBinding/ClusterRoleBinding 的 subjects 聚合而来：一行是一个 User/Group，列含绑定数与角色/作用域，详情展示其全部绑定。Roles/ClusterRoles 的**规则数**是带下划线的可点击链接，点击后在右侧栏打开专门的「规则列表」标签页（K9S 风格的 **verb 矩阵**）：表头为 `资源 | API 组 | GET | LIST | WATCH | CREATE | PATCH | UPDATE | DELETE | DEL-LIST`，每个 rule 按 (API 组 × 资源) 展开为一行（空组/空资源用 `*`，仅含非资源 URL 的规则以 URL 为行、组显示 `—`），同组同资源跨多个 rule 的动词取并集；某动词有权限则单元格打**绿勾 ✓**，否则打**红叉 ✗**。同一角色再次点击聚焦已有标签，不同角色另开新标签。

- **集群与登录**：每个 context 的认证方式（OIDC / AWS IAM / Azure / Token / 证书）、探测状态、登录按钮。会话视图顶部的登录状态徽标取自最近一次实时观测（切换集群时的 probe、以及列表请求本身的成败），而不是上一次 `clusters` 快照，所以切换集群后状态立即更新，不必手动刷新。
- **集群管理**：粘贴 kubeconfig 新增/更新集群、移除集群。

集群状态按需探测：读资源成功即“已认证”，遇到 exec/令牌失败即“需要登录”，连不上即“不可达”。

## 智能体工具

| 工具 | 作用 |
| --- | --- |
| `kube_contexts` | 列出 context、认证方式与登录状态 |
| `kube_login` | 发起 OIDC 登录（浏览器/设备码/键盘），返回授权 URL 与状态 |
| `kube_get` | 按类型列资源（命名空间、标签选择器）；`rbacusers`/`rbacgroups` 返回从绑定聚合出的 User/Group |
| `kube_crds` | 列出集群已安装的 CRD（Kind/Group/Scope/版本） |
| `kube_describe` | describe 一个对象 |
| `kube_logs` | 读取 Pod 日志 |
| `kube_apply` | 应用 YAML（需 `confirm: true`） |
| `kube_scale` | 调整副本数（需 `confirm: true`） |
| `kube_rollout` | 重启/回滚/暂停 Deployment（需 `confirm: true`） |
| `kube_delete` | 删除对象（需 `confirm: true`） |

写操作默认只返回“需要确认”的说明，不落地；只有显式带 `confirm: true` 才执行。登录是用户动作，工具只会把 URL 交出去，不会替用户点同意。

## 已知限制

- 依赖本机 `kubectl`。
- Windows 浏览器桥接依赖 WSL 的 `/mnt/c/Windows/System32/cmd.exe`；没有它时只能复制授权链接手动打开。
- 不缓存资源，每次读取都是实时 kubectl 调用。
