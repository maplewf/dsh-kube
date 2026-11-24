/**
 * dsh-kube browser half.
 *
 *  - Sidebar panel: cluster management only. Add/update a cluster by pasting
 *    its kubeconfig in a modal, remove it, and switch the current cluster.
 *  - Conversation tab: a resource browser — pick a cluster (plugin-defined name),
 *    namespace and kind, browse rows, inspect YAML / describe / logs. When a
 *    cluster needs authentication a login button is offered here (it is not
 *    offered in the sidebar).
 *
 * Plain CommonJS + React.createElement, no build step, theme tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-kube',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback, useRef, useMemo } = React
    const h = React.createElement

    const NS = 'kube'
    const PANEL_ID = 'kube'
    const CLUSTER_SCOPED = new Set([
      'nodes', 'namespaces', 'persistentvolumes', 'storageclasses', 'clusterroles',
      'clusterrolebindings', 'customresourcedefinitions', 'csidrivers',
      'priorityclasses', 'ingressclasses', 'runtimeclasses', 'rbacusers', 'rbacgroups',
    ])

    const KINDS = [
      { id: 'pods', label: 'Pods' },
      { id: 'deployments.apps', label: 'Deployments' },
      { id: 'statefulsets.apps', label: 'StatefulSets' },
      { id: 'daemonsets.apps', label: 'DaemonSets' },
      { id: 'jobs.batch', label: 'Jobs' },
      { id: 'cronjobs.batch', label: 'CronJobs' },
      { id: 'horizontalpodautoscalers.autoscaling', label: 'HPAs' },
      { id: 'verticalpodautoscalers.autoscaling.k8s.io', label: 'VPAs' },
      { id: 'services', label: 'Services' },
      { id: 'ingresses.networking.k8s.io', label: 'Ingresses' },
      { id: 'configmaps', label: 'ConfigMaps' },
      { id: 'secrets', label: 'Secrets' },
      { id: 'persistentvolumeclaims', label: 'PVCs' },
      { id: 'events', label: 'Events' },
      { id: 'nodes', label: 'Nodes' },
      { id: 'namespaces', label: 'Namespaces' },
      { id: 'serviceaccounts', label: 'ServiceAccounts' },
      { id: 'roles.rbac.authorization.k8s.io', label: 'Roles' },
      { id: 'rolebindings.rbac.authorization.k8s.io', label: 'RoleBindings' },
      { id: 'clusterroles.rbac.authorization.k8s.io', label: 'ClusterRoles' },
      { id: 'clusterrolebindings.rbac.authorization.k8s.io', label: 'ClusterRoleBindings' },
      { id: 'rbacusers', label: 'Users' },
      { id: 'rbacgroups', label: 'Groups' },
      { id: 'customresourcedefinitions', label: 'CRDs' },
    ]

    // Which 操作 entries a workload row offers. A DaemonSet has no replica count
    // (one pod per node), so `scale` is not offered for it, and the backend
    // refuses it anyway.
    const OPS_ACTIONS = {
      deployments: ['restart', 'undo', 'scale', 'delete'],
      statefulsets: ['restart', 'undo', 'scale', 'delete'],
      daemonsets: ['restart', 'undo', 'delete'],
    }
    // Every real resource offers an 操作 column with at least 删除. Only the
    // RBAC user/group pseudo-rows (aggregated from binding subjects) have no
    // object behind them, so they get no actions at all. Nodes additionally
    // get cordon/uncordon/drain (scheduling control).
    const PSEUDO_OPS = ['rbacusers', 'rbacgroups']
    const opsFor = (base) => {
      if (PSEUDO_OPS.includes(base)) return []
      if (base === 'nodes') return ['cordon', 'uncordon', 'drain', 'delete']
      return OPS_ACTIONS[base] || ['delete']
    }

    const zh = {
      'panel.title': 'Kubernetes',
      'panel.subtitle': '集群配置',
      'clusters.title': '集群',
      'page.back': '返回对话',
      'cluster.add': '添加集群',
      'cluster.edit': '编辑',
      'cluster.save': '保存集群',
      'cluster.nameLabel': '集群名称',
      'cluster.namePlaceholder': '例如 staging 或 production',
      'cluster.yamlLabel': 'kubeconfig',
      'cluster.pasteHint': '粘贴该集群的 kubeconfig YAML（apiVersion/kind/clusters/contexts）。保存同名会覆盖更新。',
      'cluster.empty': '还没有集群，先添加一个。',
      'cluster.deleteConfirm': '确定删除集群「{name}」吗？',
      'cluster.overwriteNotice': '名称相同会覆盖现有集群的配置。',
      'ctx.label': '集群',
      'ctx.empty': '还没有可用集群',
      'ns.label': '命名空间',
      'ns.all': '全部',
      'ns.selected': '个已选',
      'kind.label': '资源类型',
      'kind.search': '搜索资源类型…',
      'kind.nomatch': '没有匹配的资源类型',
      'refresh': '刷新',
      'auto.refresh': '自动刷新',
      'filter.placeholder': '按名称过滤…',
      'filter.col': '过滤…',
      'filter.all': '全部',
      'filter.selected': '项',
      'node.podsTitle': '查看该节点上的 Pod',
      'filter.nomatch': '没有匹配的值',
      'btn.switch': '切换',
      'btn.active': '当前集群',
      'btn.cancel': '取消',
      'btn.remove': '删除',
      'btn.login': '登录',
      'btn.relogin': '重新登录',
      'btn.openAgain': '再次打开浏览器',
      'btn.copy': '复制',
      'btn.copied': '已复制',
      'btn.edit': '编辑',
      'btn.save': '保存',
      'edit.confirm': '保存会把这份 YAML 应用到集群「{cluster}」，可能修改或创建资源。确定继续吗？',
      'edit.applied': '已应用到集群',
      'edit.failed': '应用失败',
      'edit.saving': '应用中…',
      'edit.blocked': '编辑中，请先保存或取消',
      'edit.secret': 'Secret 的 data 编辑时显示明文，保存时会自动做 base64 编码。',
      'btn.close': '关闭',
      'btn.clear': '清除过滤',
      'sort.toggle': '点击排序（升序/降序/取消）',
      'login.title': '登录集群',
      'login.method.browser': '浏览器登录（推荐）',
      'login.method.device': '设备码登录',
      'login.method.keyboard': '键盘输入授权码',
      'login.starting': '正在启动登录…',
      'login.waiting': '等待浏览器完成授权…',
      'login.browserOpened': '已尝试用 Windows 浏览器打开授权页',
      'login.url': '授权地址',
      'login.code': '授权码',
      'login.code.submit': '提交授权码',
      'login.success': '登录成功',
      'login.failed': '登录失败',
      'login.cancelled': '已取消',
      'login.timeout': '登录超时，请重试',
      'state.ok': '已登录',
      'state.needs-login': '需要登录',
      'state.unreachable': '不可达',
      'state.forbidden': '无权限',
      'state.timeout': '超时',
      'state.error': '出错',
      'state.unknown': '未登录',
      'auth.oidc': 'OIDC (kubelogin)',
      'auth.aws': 'AWS IAM',
      'auth.azure': 'Azure kubelogin',
      'auth.gcloud': 'gcloud',
      'auth.token': 'Token',
      'auth.cert': '客户端证书',
      'auth.exec': '自定义 exec',
      'auth.none': '无凭据',
      'col.name': '名称',
      'col.namespace': '命名空间',
      'col.ready': '就绪',
      'col.status': '状态',
      'col.age': '存在时长',
      'col.restarts': '重启次数',
      'col.image': '镜像',
      'col.extra': '其他',
      'col.logs': '日志',
      'col.pods': 'Pod',
      'col.ops': '操作',
      'ops.restart': '滚动重启',
      'ops.undo': '回滚',
      'ops.scale': '扩缩副本',
      'ops.delete': '删除',
      'ops.cordon': '封锁',
      'ops.uncordon': '解封',
      'ops.drain': '排空',
      'ops.title': '工作负载操作',
      'ops.titleResource': '资源操作',
      'ops.target': '{kind}/{name}',
      'ops.namespace': '命名空间：{namespace}',
      'ops.warn.restart': '滚动重启会按更新策略依次重建所有 Pod，期间服务可能短暂不可用。',
      'ops.warn.undo': '会生成一次新的发布，把工作负载恢复到所选版本的状态。',
      'ops.revLabel': '目标版本',
      'ops.revLoading': '正在读取可用版本…',
      'ops.revNone': '没有可回滚的历史版本',
      'ops.revHint': '只列出一个版本时说明该工作负载还没有历史发布。',
      'ops.revCauseNone': '未记录变更原因',
      'ops.warn.scale': '会调整期望副本数，扩容需要节点资源，缩容会终止多余 Pod。',
      'ops.warn.delete': '删除后该工作负载及其 Pod 都会被移除，且无法撤销。',
      'ops.warn.deleteResource': '删除后该资源会被永久移除，且无法撤销。',
      'ops.warn.cordon': '封锁后调度器不会再把新的 Pod 调度到该节点，已有的 Pod 继续运行。',
      'ops.warn.uncordon': '解封后调度器可以再次把 Pod 调度到该节点。',
      'ops.warn.drain': '排空会把该节点上的 Pod 逐出到其他节点（DaemonSet 保留、空目录数据会被删除），可能造成服务中断，且难以轻易撤销。',
      'ops.scaleLabel': '目标副本数',
      'ops.scaleHint': '当前：{current}',
      'ops.scaleInvalid': '请输入非负整数',
      'ops.run': '执行',
      'ops.busy': '执行中…',
      'ops.done': '已完成',
      'ops.failed': '操作失败',
      'col.ip': 'Pod IP',
      'col.node': '所在节点',
      'col.forwards': '端口转发',
      'pf.start.title': '端口转发',
      'pf.stop.title': '关闭端口转发',
      'pf.target': '目标端口',
      'pf.local': '本地端口',
      'pf.hint': '转发地址：http://127.0.0.1:{port}（仅本机可访问）',
      'pf.confirm': '开始转发',
      'pf.stop.confirm': '关闭转发',
      'pf.stop.message': '关闭后该本地端口立即释放。',
      'pf.notice': '转发进程与 dsh 同生命周期：dsh 重启或 kubectl 退出后自动失效。',
      'pf.starting': '处理中…',
      'pf.error': '操作失败',
      'pf.udp': 'UDP 端口不支持 kubectl port-forward',
      'pf.cell.count': '{n} 个端口',
      'pf.cell.live': '已转发 {n}',
      'pf.action': '转发',
      'pf.empty': '该 Pod 未声明端口',
      'col.class': 'Class',
      'col.host': 'Host',
      'col.schedule': 'Schedule',
      'col.suspended': '暂停',
      'col.type': '类型',
      'col.clusterip': 'ClusterIP',
      'col.externalip': 'ExternalIP',
      'col.ports': '端口',
      'col.data': '数据',
      'col.capacity': '容量',
      'col.accessmode': 'AccessMode',
      'col.storageclass': 'StorageClass',
      'col.volume': '存储卷',
      'col.reason': '原因',
      'col.count': '复现次数',
      'col.lastseen': '最近发生',
      'col.message': '消息',
      'col.object': '对象',
      'col.crdkind': 'Kind',
      'col.crdgroup': 'Group',
      'col.crdscope': 'Scope',
      'col.crdversion': '版本',
      'col.sasecrets': '密钥数',
      'col.rules': '规则数',
      'col.roleref': '角色',
      'col.subjects': '主体',
      'col.bindings': '绑定数',
      'col.roles': '角色',
      'col.scopes': '作用域',
      'col.hparef': '引用',
      'col.hpatargets': '当前 / 目标',
      'col.hparange': '副本',
      'col.hpamin': '最小副本',
      'col.hpamax': '最大副本',
      'col.hpareplicas': '当前副本',
      'col.vpamode': '模式',
      'col.vpacpu': 'CPU 推荐',
      'col.vpamem': '内存推荐',
      'col.vpaprovided': '已提供',
      'col.version': '版本',
      'col.podcount': 'Pod',
      'col.cpu': 'CPU',
      'col.memory': '内存',
      'col.type': '类型',
      'col.zone': '区域',
      'col.spec': '规格',
      'col.arch': '架构',
      'detail.yaml': 'YAML',
      'detail.describe': 'Describe',
      'detail.logs': 'Log',
      'logs.title': '日志',
      'logs.connecting': '连接中…',
      'logs.empty': '当前还没有新日志，等待输出…',
      'logs.closed': '输出已结束',
      'logs.auto': '自动滚动',
      'shell.title': '容器 Shell',
      'shell.connecting': '正在连接…',
      'shell.running': '已连接',
      'shell.closed': '已退出',
      'shell.unsupported': '无法打开 shell',
      'shell.placeholder': '输入命令，回车执行',
      'shell.send': '执行',
      'shell.starting': '正在探测 bash / sh…',
      'shell.loading': '正在加载终端…',
      'col.login': '登录',
      'logs.follow': '跟随中',
      'logs.tail': '最近 {n} 行',
      'logs.search.placeholder': '搜索日志：关键字，或 * ? 通配符，或 /正则/flags',
      'logs.search.hint': '支持 * ? 通配符与 /pattern/i 正则',
      'logs.search.hits': '匹配 {n} 行',
      'logs.search.none': '没有匹配的日志行',
      'logs.search.invalid': '正则无效',
      'logs.keep': '缓冲上限 {n}K 字符',
      'detail.empty': '点击一行查看详情',
      'detail.loading': '加载中…',
      'detail.title': '资源详情',
      'rules.loading': '正在读取规则…',
      'rules.empty': '该角色没有规则',
      'rules.name': '资源',
      'rules.apigroups': 'API 组',
      'rules.resources': '资源',
      'rules.verbs': '操作',
      'rules.resourcenames': '资源名称',
      'rules.nonresourceurls': '非资源 URL',
      'rules.open': '查看规则列表',
      'rules.title': '规则列表',
      'expand': '展开',
      'collapse': '折叠',
      'containers.ready': '就绪',
      'containers.notReady': '未就绪',
      'containers.none': '无容器',
      'view.title': 'Kubernetes',
      'view.empty': '还没有集群，请到左侧 Kubernetes 面板添加。',
      'view.hint': '只读浏览。添加/编辑集群在左侧 Kubernetes 面板；需要认证的集群可在本页登录。',
      'msg.count': '共 {n} 个',
      'msg.noRows': '没有资源',
      'msg.noMatch': '没有匹配的资源',
      'msg.stale': '刷新失败（{msg}），显示上次加载的数据',
      'msg.loginRequired': '该集群需要登录后才能读取资源。',
      'msg.podsOf': '正在显示',
      'msg.podsOfSuffix': ' 关联的 Pod',
      'msg.crdOf': '正在显示',
      'msg.crdOfMid': '下的',
      'btn.backCrds': '返回 CRDs',
      'btn.viewInstances': '查看该类型的资源',
      'msg.noKubectl': '未找到 kubectl，请检查 PATH。',
      'msg.noBrowser': '未检测到 Windows 浏览器桥接，请手动复制授权地址。',
      'msg.clustersFailed': '读取集群失败：',
    }

    const en = {
      'panel.title': 'Kubernetes',
      'panel.subtitle': 'Cluster config',
      'clusters.title': 'Clusters',
      'page.back': 'Back to conversation',
      'cluster.add': 'Add cluster',
      'cluster.edit': 'Edit',
      'cluster.save': 'Save cluster',
      'cluster.nameLabel': 'Cluster name',
      'cluster.namePlaceholder': 'e.g. staging or production',
      'cluster.yamlLabel': 'kubeconfig',
      'cluster.pasteHint': 'Paste this cluster kubeconfig YAML (apiVersion/kind/clusters/contexts). Saving with the same name overwrites it.',
      'cluster.empty': 'No cluster yet. Add one first.',
      'cluster.deleteConfirm': 'Delete cluster "{name}"?',
      'cluster.overwriteNotice': 'Saving with the same name overwrites the existing cluster config.',
      'ctx.label': 'Cluster',
      'ctx.empty': 'No cluster yet',
      'ns.label': 'Namespace',
      'ns.all': 'All',
      'ns.selected': 'selected',
      'kind.label': 'Kind',
      'kind.search': 'Search kinds…',
      'kind.nomatch': 'No matching kind',
      'refresh': 'Refresh',
      'auto.refresh': 'Auto-refresh',
      'filter.placeholder': 'Filter by name…',
      'filter.col': 'Filter…',
      'filter.all': 'All',
      'filter.selected': 'selected',
      'node.podsTitle': 'Show pods on this node',
      'filter.nomatch': 'No matching value',
      'btn.switch': 'Switch',
      'btn.active': 'Current cluster',
      'btn.cancel': 'Cancel',
      'btn.remove': 'Delete',
      'btn.login': 'Login',
      'btn.relogin': 'Login again',
      'btn.openAgain': 'Open browser again',
      'btn.copy': 'Copy',
      'btn.copied': 'Copied',
      'btn.edit': 'Edit',
      'btn.save': 'Save',
      'edit.confirm': 'Saving applies this YAML to cluster "{cluster}" and may modify or create resources. Continue?',
      'edit.applied': 'Applied to cluster',
      'edit.failed': 'Apply failed',
      'edit.saving': 'Applying…',
      'edit.blocked': 'Editing — save or cancel first',
      'edit.secret': 'Secret data is shown in plaintext while editing; it is base64-encoded automatically on save.',
      'btn.close': 'Close',
      'btn.clear': 'Clear filter',
      'sort.toggle': 'Click to sort (asc / desc / none)',
      'login.title': 'Cluster login',
      'login.method.browser': 'Browser (recommended)',
      'login.method.device': 'Device code',
      'login.method.keyboard': 'Keyboard code',
      'login.starting': 'Starting login…',
      'login.waiting': 'Waiting for the browser to finish…',
      'login.browserOpened': 'Windows browser was asked to open the authorize page',
      'login.url': 'Authorize URL',
      'login.code': 'Code',
      'login.code.submit': 'Submit code',
      'login.success': 'Signed in',
      'login.failed': 'Login failed',
      'login.cancelled': 'Cancelled',
      'login.timeout': 'Login timed out, try again',
      'state.ok': 'Signed in',
      'state.needs-login': 'Needs login',
      'state.unreachable': 'Unreachable',
      'state.forbidden': 'Forbidden',
      'state.timeout': 'Timed out',
      'state.error': 'Error',
      'state.unknown': 'Signed out',
      'auth.oidc': 'OIDC (kubelogin)',
      'auth.aws': 'AWS IAM',
      'auth.azure': 'Azure kubelogin',
      'auth.gcloud': 'gcloud',
      'auth.token': 'Token',
      'auth.cert': 'Client certificate',
      'auth.exec': 'Custom exec',
      'auth.none': 'No credentials',
      'col.name': 'Name',
      'col.namespace': 'Namespace',
      'col.ready': 'Ready',
      'col.status': 'Status',
      'col.age': 'Age',
      'col.restarts': 'Restarts',
      'col.image': 'Image',
      'col.extra': 'Extra',
      'col.logs': 'Logs',
      'col.pods': 'Pod',
      'col.ops': 'Actions',
      'ops.restart': 'Rolling restart',
      'ops.undo': 'Rollback',
      'ops.scale': 'Scale',
      'ops.delete': 'Delete',
      'ops.cordon': 'Cordon',
      'ops.uncordon': 'Uncordon',
      'ops.drain': 'Drain',
      'ops.title': 'Workload action',
      'ops.titleResource': 'Resource action',
      'ops.target': '{kind}/{name}',
      'ops.namespace': 'Namespace: {namespace}',
      'ops.warn.restart': 'Every Pod is recreated in order; the workload may be briefly unavailable.',
      'ops.warn.undo': 'Creates a new rollout that restores the workload to the chosen revision.',
      'ops.revLabel': 'Revision',
      'ops.revLoading': 'Loading available revisions…',
      'ops.revNone': 'No rollout history to roll back to',
      'ops.revHint': 'A single revision means the workload has never been through a rollout.',
      'ops.revCauseNone': 'No change-cause recorded',
      'ops.warn.scale': 'Changes the desired replica count; scaling up needs spare node capacity, scaling down terminates Pods.',
      'ops.warn.delete': 'The workload and all of its Pods are removed. This cannot be undone.',
      'ops.warn.deleteResource': 'The resource is removed permanently. This cannot be undone.',
      'ops.warn.cordon': 'No new Pods are scheduled onto the node; running Pods keep running.',
      'ops.warn.uncordon': 'Pods may be scheduled onto the node again.',
      'ops.warn.drain': 'Evicts the node\u2019s Pods to other nodes (DaemonSets stay, empty-dir data is deleted); may disrupt services and is hard to undo.',
      'ops.scaleLabel': 'Replicas',
      'ops.scaleHint': 'Current: {current}',
      'ops.scaleInvalid': 'Enter a non-negative integer',
      'ops.run': 'Run',
      'ops.busy': 'Running…',
      'ops.done': 'Done',
      'ops.failed': 'Action failed',
      'col.ip': 'Pod IP',
      'col.node': 'Node',
      'col.forwards': 'Port forward',
      'pf.start.title': 'Port forward',
      'pf.stop.title': 'Stop port forward',
      'pf.target': 'Target port',
      'pf.local': 'Local port',
      'pf.hint': 'Forward URL: http://127.0.0.1:{port} (local only)',
      'pf.confirm': 'Start',
      'pf.stop.confirm': 'Stop forwarding',
      'pf.stop.message': 'The local port is released immediately.',
      'pf.notice': 'A forward lives with dsh: it ends when dsh restarts or kubectl exits.',
      'pf.starting': 'Working…',
      'pf.error': 'Failed',
      'pf.udp': 'UDP ports cannot be port-forwarded with kubectl',
      'pf.cell.count': '{n} ports',
      'pf.cell.live': 'Forwarded {n}',
      'pf.action': 'Forward',
      'pf.empty': 'This pod declares no ports',
      'col.class': 'Class',
      'col.host': 'Host',
      'col.schedule': 'Schedule',
      'col.suspended': 'Suspended',
      'col.type': 'Type',
      'col.clusterip': 'ClusterIP',
      'col.externalip': 'ExternalIP',
      'col.ports': 'Ports',
      'col.data': 'Data',
      'col.capacity': 'Capacity',
      'col.accessmode': 'AccessMode',
      'col.storageclass': 'StorageClass',
      'col.volume': 'Volume',
      'col.reason': 'Reason',
      'col.count': 'Count',
      'col.lastseen': 'Last Seen',
      'col.message': 'Message',
      'col.object': 'Object',
      'col.crdkind': 'Kind',
      'col.crdgroup': 'Group',
      'col.crdscope': 'Scope',
      'col.crdversion': 'Versions',
      'col.version': 'Version',
      'col.podcount': 'Pod',
      'col.cpu': 'CPU',
      'col.memory': 'Memory',
      'col.type': 'Type',
      'col.zone': 'Zone',
      'col.spec': 'Spec',
      'col.arch': 'Arch',
      'col.hparef': 'Reference',
      'col.hpatargets': 'Current / target',
      'col.hparange': 'Replicas',
      'col.hpamin': 'Min pods',
      'col.hpamax': 'Max pods',
      'col.hpareplicas': 'Current replicas',
      'col.vpamode': 'Mode',
      'col.vpacpu': 'CPU target',
      'col.vpamem': 'Memory target',
      'col.vpaprovided': 'Provided',
      'detail.yaml': 'YAML',
      'detail.describe': 'Describe',
      'detail.logs': 'Log',
      'logs.title': 'Logs',
      'logs.connecting': 'Connecting…',
      'logs.empty': 'No new output yet, waiting…',
      'logs.closed': 'Stream ended',
      'logs.auto': 'Auto-scroll',
      'shell.title': 'Container shell',
      'shell.connecting': 'Connecting…',
      'shell.running': 'connected',
      'shell.closed': 'exited',
      'shell.unsupported': 'Shell unavailable',
      'shell.placeholder': 'Type a command and press Enter',
      'shell.send': 'Run',
      'shell.starting': 'Probing bash / sh…',
      'shell.loading': 'Loading terminal…',
      'col.login': 'Login',
      'logs.follow': 'following',
      'logs.tail': 'last {n} lines',
      'logs.search.placeholder': 'Search logs: text, * ? wildcards, or /regex/flags',
      'logs.search.hint': 'Supports * ? wildcards and /pattern/i regex',
      'logs.search.hits': '{n} matching line(s)',
      'logs.search.none': 'No log line matches',
      'logs.search.invalid': 'Invalid regex',
      'logs.keep': 'buffer cap {n}K chars',
      'detail.empty': 'Select a row to inspect it',
      'detail.loading': 'Loading…',
      'detail.title': 'Resource Detail',
      'rules.loading': 'Loading rules…',
      'rules.empty': 'This role has no rules',
      'rules.name': 'Resource',
      'rules.apigroups': 'API Groups',
      'rules.resources': 'Resources',
      'rules.verbs': 'Verbs',
      'rules.resourcenames': 'Resource Names',
      'rules.nonresourceurls': 'Non-resource URLs',
      'rules.open': 'View rules',
      'rules.title': 'Rules',
      'expand': 'Expand',
      'collapse': 'Collapse',
      'containers.ready': 'ready',
      'containers.notReady': 'not ready',
      'containers.none': 'No containers',
      'view.title': 'Kubernetes',
      'view.empty': 'No cluster yet. Add one in the Kubernetes panel on the left.',
      'view.hint': 'Read-only. Add/edit clusters in the Kubernetes panel on the left; sign in for an authenticated cluster right here.',
      'msg.count': '{n} item(s)',
      'msg.noRows': 'No resources',
      'msg.noMatch': 'No matching resource',
      'msg.stale': 'Refresh failed ({msg}) — showing last loaded data',
      'msg.loginRequired': 'This cluster needs a sign-in before resources can be read.',
      'msg.podsOf': 'Showing',
      'msg.podsOfSuffix': ' associated Pods',
      'msg.crdOf': 'Showing',
      'msg.crdOfMid': 'under',
      'btn.backCrds': 'Back to CRDs',
      'btn.viewInstances': 'View resources of this kind',
      'msg.noKubectl': 'kubectl was not found on PATH.',
      'msg.noBrowser': 'Windows browser bridge not detected; copy the URL manually.',
      'msg.clustersFailed': 'Could not read clusters: ',
    }

    const CSS = `
.dk-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px}
.dk-head{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dk-title{font-size:15px;font-weight:600;margin:0}
.dk-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dk-spacer{flex:1}
.dk-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap}
.dk-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.dk-btn:disabled{opacity:.5;cursor:default}
.dk-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dk-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dk-btn.ghost:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dk-link-btn{font-weight:700;text-decoration:underline;color:var(--dsw-alias-brand-primary);background:transparent !important;border-color:transparent !important}
.dk-link-btn:hover{color:var(--dsw-alias-brand-primary);opacity:.8;background:transparent !important;text-decoration:underline}
.dk-btn.danger{color:var(--dsw-alias-state-error-primary)}
.dk-btn.dark{background:#000;border-color:#000;color:#fff}
.dk-btn.dark:hover{background:#333;border-color:#333}
.dk-btn.icon{padding:0;width:28px;height:28px;justify-content:center;font-size:15px}
.dk-select.mini{width:64px;max-width:64px;padding:0 4px}
.dk-ops-wrap{position:relative;display:inline-block}
.dk-ops-trigger{width:30px;height:26px;padding:0;justify-content:center;gap:0}
.dk-caret{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--dsw-alias-label-secondary);margin-top:2px}
.dk-ops-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:40;min-width:132px;padding:4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 30px rgba(0,0,0,.4)}
.dk-ops-item{display:block;width:100%;text-align:left;padding:6px 9px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap}
.dk-ops-item:hover{background:var(--dsw-alias-bg-layer-3,#2a2a2a);color:#fff}
.dk-ops-revs{margin:10px 0}
.dk-rev-list{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.dk-rev-item{display:flex;align-items:center;gap:8px;padding:6px 9px;cursor:pointer;font-size:12px}
.dk-rev-item+.dk-rev-item{border-top:1px solid var(--dsw-alias-border-l1)}
.dk-rev-item.on{background:rgba(255,214,10,.12)}
.dk-rev-item input{accent-color:var(--dsw-alias-brand-primary);margin:0}
.dk-rev-num{font:12px/1 var(--ds-font-family-code);color:var(--dsw-alias-brand-primary);min-width:30px}
.dk-rev-cause{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-ops-panel{padding:8px 10px;margin:10px 0;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font:12px/1.55 var(--ds-font-family-code);white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto}
.dk-ops-panel.ok{border-color:#4ade80;color:#86efac;background:#101a12}
.dk-ops-panel.err{border-color:#f87171;color:#fca5a5;background:#1a1010}
.dk-auto{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.dk-auto input{margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dk-tabs{display:flex;gap:2px;padding:8px 20px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dk-tab{height:30px;padding:0 12px;border:none;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dk-tab:hover{color:var(--dsw-alias-label-primary)}
.dk-tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}
.dk-tab-chip-icon{flex:none;margin-right:4px;color:var(--dsw-alias-label-tertiary)}
.dk-body{flex:1;min-height:0;overflow:auto;padding:14px 20px 24px}
.dk-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.dk-field{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}
.dk-select,.dk-input{height:28px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;outline:none;max-width:360px}
.dk-select:focus,.dk-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dk-input.search{width:220px}
.dk-input.grow{width:100%}
.dk-multi{position:relative}
.dk-multi-btn{height:28px;min-width:120px;max-width:300px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;overflow:hidden}
.dk-multi-btn .dk-multi-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}
.dk-multi-panel{position:absolute;top:calc(100% + 4px);left:0;z-index:40;min-width:220px;max-width:320px;max-height:280px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.3);padding:6px}
.dk-multi-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px}
.dk-multi-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dk-multi-item input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dk-multi-divider{border-top:1px solid var(--dsw-alias-border-l1);margin:5px 0}
.dk-multi-item.on{background:var(--dsw-alias-bg-layer-2)}
.dk-multi-item.selected{font-weight:600}
.dk-kindpick-panel .dk-multi-item{padding:6px 8px}
.dk-textarea{width:100%;min-height:180px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/1.5 var(--ds-font-family-code);padding:10px;outline:none;resize:vertical}
.dk-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dk-field-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dk-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;border:1px solid transparent;white-space:nowrap}
.dk-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.dk-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.dk-badge.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dk-badge.idle{color:var(--dsw-alias-state-idle-primary);border-color:currentColor}
.dk-badge.plain{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.dk-badge.count{background:#ffd60a;color:#fff;font-weight:700;border-color:#ffd60a}
.dk-badge.info{color:#16a34a;border-color:rgba(22,163,74,.4)}
.dk-badge.pod{color:#fff;border-color:transparent;font-weight:600}
.dk-badge.pod.running{background:#22c55e}
.dk-badge.pod.ok{background:#22c55e}
.dk-badge.pod.completed{background:#6b7280}
.dk-badge.pod.warn{background:#f59e0b}
.dk-badge.pod.sched{background:#ffd60a;color:#fff;font-weight:700}
.dk-badge.pod.err{background:#ef4444}
.dk-badge.pod.running-text{background:none;color:#22c55e}
.dk-pf-sum{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:4px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}
.dk-pf-sum:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dk-pf-sum.on{border:1px solid rgba(22,163,74,.6);background:rgba(22,163,74,.12);color:#16a34a}
.dk-pf-list{display:flex;flex-direction:column;gap:6px}
.dk-pf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.dk-pf-row:hover{border-color:var(--dsw-alias-brand-primary)}
.dk-pf-row.on{border-color:rgba(22,163,74,.6);background:rgba(22,163,74,.1);color:#16a34a}
.dk-pf-row.off{opacity:.5;cursor:not-allowed}
.dk-table{width:100%;border-collapse:collapse}
.dk-table th{text-align:left;font-weight:600;color:#fff;font-size:12px;padding:6px 10px;border-bottom:1px solid #000;position:sticky;top:0;background:#000;z-index:1}
.dk-th-sort{cursor:pointer;user-select:none}
.dk-th-sort:hover .dk-th-label{color:#ffd60a}
.dk-th-sort.on .dk-th-label{color:#ffd60a}
.dk-th-label{display:inline-flex;align-items:center;gap:3px}
.dk-sort-arrow{font-size:11px;color:#ffd60a}
.dk-colfilter{display:inline-flex;align-items:center;margin-left:5px;vertical-align:middle}
.dk-colfilter-btn{display:inline-flex;align-items:center;gap:2px;height:15px;padding:0 2px;border:0;background:transparent;color:#6b7280;cursor:pointer;line-height:1}
.dk-colfilter-btn:hover,.dk-colfilter-btn.open{color:#ffd60a}
.dk-colfilter-btn.on{color:#ffd60a}
.dk-colfilter-count{font-size:10px;font-weight:600}
.dk-colfilter-panel{position:fixed;z-index:9999;min-width:220px;max-height:300px;overflow-y:auto;padding:8px;border-radius:8px;border:1px solid #3d3d3d;background:#111318;color:#f5f7fa;box-shadow:0 12px 34px rgba(0,0,0,.6)}
.dk-colfilter-panel .dk-multi-item{color:#f5f7fa}
.dk-colfilter-panel .dk-multi-item:hover{background:#232a36}
.dk-colfilter-panel .dk-multi-item.on{background:#232a36;color:#fff;font-weight:600}
.dk-colfilter-panel .dk-multi-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:inherit}
.dk-colfilter-panel .dk-input{background:#0a0c10;color:#f5f7fa;border-color:#3d3d3d}
.dk-colfilter-panel .dk-multi-divider{background:#2c333e}
.dk-multi-empty{padding:6px 8px;font-size:11px;color:#9aa4b2}
.dk-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;vertical-align:top}
.dk-table tbody tr:not(.dk-subrow){cursor:pointer}
.dk-table tbody tr:not(.dk-subrow):hover td{background:#ffd60a}
.dk-table tbody tr:not(.dk-subrow):hover td, .dk-table tbody tr:not(.dk-subrow):hover td *{color:#1a1a1a}
.dk-expander{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:6px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;vertical-align:middle}
.dk-expander:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.dk-subrow td{padding:4px 10px 10px 10px}
.dk-subtable{width:100%;border-collapse:collapse}
.dk-table .dk-subtable th{background:transparent;position:static;top:auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dk-table .dk-subtable td{padding:5px 10px;background:transparent;vertical-align:middle}
.dk-table .dk-subtable tbody tr:hover td{background:rgba(127,127,127,.1)}
.dk-cname{font-family:var(--ds-font-family-code);font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dk-cimg{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;max-width:360px}
.dk-loading-cell{padding:6px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dk-subrow-error{padding:6px 8px;color:var(--dsw-alias-state-error-primary);font-size:12px}
.dk-mono{font-family:var(--ds-font-family-code);font-size:inherit}
.dk-muted{color:var(--dsw-alias-label-secondary)}
.dk-error{margin:0 0 12px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
.dk-error .dk-hint{color:var(--dsw-alias-label-secondary);font-size:12px;flex-basis:100%}
.dk-stale{margin:0 0 12px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.dk-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px}
.dk-view{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;overflow:auto;padding:18px 20px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:14px;font-family:var(--dsw-font-family)}
.dk-view-card{width:100%;max-width:none;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-sidebar-fill);padding:16px;display:flex;flex-direction:column;gap:12px}
.dk-view-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dk-view-title{font-weight:500}
.dk-empty{padding:36px 16px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.dk-split{display:flex;gap:14px;align-items:flex-start;min-height:0}
.dk-main{flex:1;min-width:0}
.dk-drawer-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333;background:#000;color:#fff}
.dk-drawer-body{flex:1;min-height:0;overflow:auto;padding:10px 12px;background:#000;color:#fff}
.dk-detail-tab{display:flex;flex-direction:column;height:100%;min-height:0;background:#000;color:#fff;font-size:14px;font-family:var(--dsw-font-family)}
.dk-logs{display:flex;flex-direction:column;height:100%;min-height:0;background:#000;color:#fff;font-family:var(--dsw-font-family)}
.dk-logs-head,.dk-logs-foot{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;background:#0d0d0d;border-bottom:1px solid #333}
.dk-logs-foot{border-bottom:none;border-top:1px solid #333}
.dk-logs-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff}
.dk-logs-body{flex:1;min-height:0;overflow:auto;background:#000;padding:8px 10px;position:relative}
.dk-logs-pre{margin:0;background:transparent;border:none;color:#e5e7eb;font:12px/1.55 var(--ds-font-family-code);white-space:pre-wrap;word-break:break-word}
.dk-logs-hint{position:absolute;top:8px;left:10px;color:#6b7280;font-size:12px;pointer-events:none}
.dk-logs-searchbar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;background:#0d0d0d;border-bottom:1px solid #333}
.dk-logs-search{flex:1;min-width:0;height:26px;background:#111;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;padding:0 8px}
.dk-logs-search:focus{outline:none;border-color:#4b5563}
.dk-logs-search.invalid{border-color:#ef4444}
.dk-shell-host{flex:1;min-height:0;background:#0d0d0d;padding:6px 8px 2px;overflow:hidden}
.dk-shell-host .xterm{height:100%}
.dk-shell-host .xterm-viewport{background:#0d0d0d !important;scrollbar-width:thin}
.dk-logs-hit{background:#ffd60a;color:#111;border-radius:2px;padding:0 1px}
.dk-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dk-icon-btn:hover{background:rgba(127,127,127,.18);color:var(--dsw-alias-label-primary)}
.dk-pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.55 var(--ds-font-family-code);color:#e5e7eb}
.dk-detail-tab .dk-muted{color:#9ca3af}
.dk-detail-tab .dk-error{background:#1a1a1a;border-color:#f87171;color:#fca5a5}
.dk-detail-tab .dk-tab{color:#9ca3af}
.dk-detail-tab .dk-tab:hover{color:#fff}
.dk-detail-tab .dk-tab.active{color:#fff;border-bottom-color:#fff}
.dk-detail-tab .dk-btn.ghost{color:#d1d5db}
.dk-detail-tab .dk-btn.ghost:hover{color:#fff;background:#222}
.dk-detail-tab .dk-drawer-body{display:flex;flex-direction:column}
.dk-detail-tab .dk-yaml-view{position:relative;flex:1 1 auto;min-height:220px;margin:0}
.dk-detail-tab .dk-yaml-layer{position:absolute;inset:0;margin:0;padding:0 12px;overflow:hidden;white-space:pre-wrap;word-break:break-word;font:13px/1.55 var(--ds-font-family-code);color:#e5e7eb;tab-size:2;pointer-events:none}
.dk-detail-tab .dk-yaml-input{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;margin:0;padding:0 12px;border:0;background:transparent;color:transparent;caret-color:#4ade80;font:13px/1.55 var(--ds-font-family-code);white-space:pre-wrap;word-break:break-word;overflow:auto;resize:none;tab-size:2;outline:none}
.dk-detail-tab .dk-yaml-input::selection{background:rgba(74,222,128,.25)}
.dk-detail-tab .dk-edit-hint{font-size:12px;margin-bottom:6px}
.dk-rules-body{flex:1;min-height:0;overflow:auto;padding:10px}
.dk-rules-table{width:100%;border-collapse:collapse;font-size:12px}
.dk-rules-table th{text-align:left;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dk-rules-table td{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.dk-rules-cell{word-break:break-all;max-width:320px}
.dk-rules-matrix{min-width:760px;white-space:nowrap}
.dk-rules-matrix th,.dk-rules-matrix td{text-align:center;padding:6px 8px}
.dk-rules-matrix th:first-child,.dk-rules-matrix td:first-child{text-align:left;max-width:220px}
.dk-rules-matrix td:nth-child(2){text-align:left}
.dk-matrix-cell{font-size:12px;line-height:1}
.dk-matrix-ok{color:#4ade80;font-weight:600}
.dk-matrix-no{color:#f87171;font-weight:600}
.dk-count-link{display:inline-block;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:12px/1 var(--ds-font-family-code);text-decoration:underline;cursor:pointer}
.dk-rules-link{display:inline-block;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:12px/1 var(--ds-font-family-code);text-decoration:underline;cursor:pointer}
.dk-detail-tab .dk-pre-wrap{white-space:pre-wrap;word-break:break-word;display:block;font:12px/1.5 var(--ds-font-family-code)}
.dk-detail-tab .dk-apply-note{padding:8px 10px;margin-bottom:8px;border-radius:8px;border:1px solid #4ade80;background:#101a12;color:#86efac;font-size:12px;word-break:break-word}
.dk-sy.key{color:#7dd3fc}
.dk-sy.str{color:#86efac}
.dk-sy.num{color:#fbbf24}
.dk-sy.const{color:#f472b6}
.dk-sy.comment{color:#6b7280;font-style:italic}
.dk-sy.hdr{color:#e5e7eb;font-weight:700}
.dk-sy.punct{color:#9ca3af}
.dk-sy.muted{color:#4b5563}
.dk-row{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:flex-start}
.dk-row:last-child{border-bottom:none}
.dk-row-main{flex:1;min-width:0}
.dk-row-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dk-row-meta{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px;word-break:break-all}
.dk-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;z-index:60}
.dk-modal{width:min(600px,94vw);max-height:88vh;overflow:auto;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.35);padding:18px}
.dk-modal h3{margin:0 0 4px;font-size:14px}
.dk-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
.dk-code{background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:2px 6px;font-family:var(--ds-font-family-code);font-size:12px}
.dk-link{color:var(--dsw-alias-brand-primary);word-break:break-all;font-size:12px;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;text-align:left}
`

    function useStyles() {
      useEffect(() => {
        const id = 'dsh-kube.css'
        if (document.querySelector(`style[data-plugin-css="${id}"]`)) return
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-kube'
        style.dataset.pluginCss = id
        style.textContent = CSS
        document.head.appendChild(style)
      }, [])
    }

    /** One round-trip to a host route. */
    async function call(method, input) {
      const response = await fetch('/dsh-kube/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input || {}),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    // The detail pane lives in the right sidebar, a different React root from the
    // resource list. A window event keeps the two in sync: after a successful
    // apply the list of the same cluster/kind reloads its rows.
    const APPLIED_EVENT = 'dsh-kube:applied'
    function emitApplied(detail) {
      try { window.dispatchEvent(new CustomEvent(APPLIED_EVENT, { detail })) } catch {}
    }
    const OPEN_RULES_EVENT = 'dsh-kube:open-rules'
    function emitOpenRules(detail) {
      try { window.dispatchEvent(new CustomEvent(OPEN_RULES_EVENT, { detail })) } catch {}
    }

    function authLabel(t, auth) {
      const kind = auth?.kind || 'none'
      const key = `auth.${kind}`
      const label = t(key)
      return label === key ? kind : label
    }

    function badgeClass(state) {
      switch (state) {
        case 'ok': return 'dk-badge ok'
        case 'needs-login': return 'dk-badge warn'
        case 'forbidden':
        case 'unreachable':
        case 'timeout':
        case 'error': return 'dk-badge err'
        default: return 'dk-badge idle'
      }
    }

    // Pod phase → badge tone: Running=green, Completed=gray, everything else red.
    function podStatusTone(status) {
      const s = String(status || '').toLowerCase()
      if (s === 'running') return 'running'
      if (s === 'completed') return 'completed'
      return 'err'
    }

    function stateLabel(t, state) {
      const key = `state.${state || 'unknown'}`
      const label = t(key)
      return label === key ? String(state || '—') : label
    }

    function isKindScoped(kind) {
      return CLUSTER_SCOPED.has(String(kind).split('.')[0])
    }

    // Multi-select dropdown for namespaces. `value` is an array; an empty array
    // means "all". `options` is the full ordered list of namespaces.
    function MultiSelect({ t, label, value, options, onChange, summary, defaultNs }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const ref = useRef(null)
      useEffect(() => {
        if (!open) return
        const onDown = (event) => { if (ref.current && !ref.current.contains(event.target)) setOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])
      const all = value.length === 0
      const shown = options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()))
      const toggle = (name) => {
        onChange(all ? [name] : (value.includes(name) ? value.filter((v) => v !== name) : [...value, name]))
      }
      return h('div', { className: 'dk-multi', ref },
        h('button', { className: 'dk-multi-btn', onClick: () => setOpen((v) => !v), type: 'button' },
          h('span', { className: 'dk-multi-label' }, all ? (summary || t('ns.all')) : `${value.length} ${t('ns.selected')}`),
          h('span', null, open ? '▲' : '▼'),
        ),
        open
          ? h('div', { className: 'dk-multi-panel' },
              h('input', {
                className: 'dk-input grow', style: { marginBottom: 6 }, placeholder: t('filter.placeholder'),
                value: query, onChange: (event) => setQuery(event.target.value), autoFocus: true,
              }),
              h('div', { className: 'dk-multi-item', onClick: () => onChange(all ? [defaultNs] : []) },
                h('input', { type: 'checkbox', checked: all, readOnly: true }), h('span', null, t('ns.all')),
              ),
              h('div', { className: 'dk-multi-divider' }),
              shown.map((name) => h('div', { className: 'dk-multi-item', key: name, onClick: () => toggle(name) },
                h('input', { type: 'checkbox', checked: all || value.includes(name), readOnly: true }),
                h('span', { className: 'dk-mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
              )),
            )
          : null,
      )
    }

    /**
     * Compact multi-select used in the pod list table-header filter cells. A small
     * button shows "全部" or the number of selected values; opening it exposes a
     * searchable checkbox list, so one column can be narrowed to several discrete
     * values (Running, CrashLoopBackOff …) rather than a free-text substring.
     */
    function ColFilter({ t, value, options, onChange }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [pos, setPos] = useState(null)
      const btnRef = useRef(null)
      const panelRef = useRef(null)
      // The panel is fixed-positioned from the button's screen rect: table headers
      // are sticky (their own stacking context), so an absolutely positioned panel
      // would be clipped behind the neighbouring header cells.
      const showPanel = () => {
        const rect = btnRef.current && btnRef.current.getBoundingClientRect()
        if (rect) {
          const left = Math.max(8, Math.min(rect.left, (window.innerWidth || 1200) - 232))
          setPos({ left, top: rect.bottom + 4 })
        }
        setOpen(true)
      }
      useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          if (panelRef.current && panelRef.current.contains(event.target)) return
          if (btnRef.current && btnRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      const all = value.length === 0
      const shown = options.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()))
      const toggle = (name) => {
        onChange(all ? [name] : (value.includes(name) ? value.filter((v) => v !== name) : [...value, name]))
      }
      return h('span', { className: 'dk-colfilter' },
        h('button', {
          ref: btnRef,
          className: 'dk-colfilter-btn' + (all ? '' : ' on') + (open ? ' open' : ''),
          type: 'button',
          title: t('filter.col'),
          onClick: (event) => { event.stopPropagation(); if (open) setOpen(false); else showPanel() },
        },
          h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
            h('path', { d: 'M1 1.5h14l-5.4 6.6V15l-3.2-1.6V8.1z', fill: 'currentColor' }),
          ),
          all ? null : h('span', { className: 'dk-colfilter-count' }, String(value.length)),
        ),
        open
          ? h('div', {
              ref: panelRef,
              className: 'dk-colfilter-panel',
              style: pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : null,
              onClick: (event) => event.stopPropagation(),
            },
              h('input', {
                className: 'dk-input grow', style: { marginBottom: 6 }, placeholder: t('filter.placeholder'),
                value: query, onChange: (event) => setQuery(event.target.value), autoFocus: true,
              }),
              h('div', { className: 'dk-multi-item' + (all ? ' on' : ''), onClick: () => onChange([]) },
                h('input', { type: 'checkbox', checked: all, readOnly: true }), h('span', null, t('filter.all')),
              ),
              h('div', { className: 'dk-multi-divider' }),
              shown.length === 0
                ? h('div', { className: 'dk-multi-empty' }, t('filter.nomatch'))
                : shown.map((name) => h('div', { className: 'dk-multi-item' + (all || value.includes(name) ? ' on' : ''), key: name, onClick: () => toggle(name) },
                    h('input', { type: 'checkbox', checked: all || value.includes(name), readOnly: true }),
                    h('span', { className: 'dk-multi-text' }, name),
                  )),
            )
          : null,
      )
    }

    /**
     * Searchable resource-type picker. A plain <select> is unusable once there are
     * 25+ kinds: it cannot be filtered and browsers jump by first letter only, so
     * this is a combobox (button + filter input + arrow-key list).
     */
    function KindPicker({ t, value, options, onChange }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [active, setActive] = useState(0)
      const ref = useRef(null)
      const inputRef = useRef(null)

      useEffect(() => {
        if (!open) return
        const onDown = (event) => { if (ref.current && !ref.current.contains(event.target)) setOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      // Reset the filter each time it opens and put the caret in the input, so
      // "open + type" is the whole interaction.
      useEffect(() => {
        if (!open) return
        setQuery('')
        setActive(0)
        const timer = setTimeout(() => { try { inputRef.current?.focus() } catch {} }, 0)
        return () => clearTimeout(timer)
      }, [open])

      const q = query.trim().toLowerCase()
      const shown = q
        ? options.filter((entry) => entry.label.toLowerCase().includes(q) || entry.id.toLowerCase().includes(q))
        : options
      const current = options.find((entry) => entry.id === value) || null
      const pick = (entry) => {
        if (!entry) return
        onChange(entry.id)
        setOpen(false)
      }
      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((index) => Math.min(shown.length - 1, index + 1))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((index) => Math.max(0, index - 1))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          pick(shown[active])
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
        }
      }

      return h('div', { className: 'dk-multi dk-kindpick', ref },
        h('button', {
          className: 'dk-multi-btn', type: 'button',
          onClick: () => setOpen((open2) => !open2),
          title: current ? `${current.label} (${current.id})` : value,
        },
          h('span', { className: 'dk-multi-label' }, current ? current.label : value),
          h('span', null, open ? '▲' : '▼'),
        ),
        open
          ? h('div', { className: 'dk-multi-panel dk-kindpick-panel', onKeyDown },
              h('input', {
                ref: inputRef,
                className: 'dk-input grow', style: { marginBottom: 6 },
                placeholder: t('kind.search'), value: query,
                onChange: (event) => { setQuery(event.target.value); setActive(0) },
              }),
              shown.length === 0
                ? h('div', { className: 'dk-multi-item dk-muted' }, t('kind.nomatch'))
                : null,
              shown.map((entry, index) => h('div', {
                className: `dk-multi-item${index === active ? ' on' : ''}${entry.id === value ? ' selected' : ''}`,
                key: entry.id,
                title: entry.id,
                onMouseEnter: () => setActive(index),
                onClick: () => pick(entry),
              },
                h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.label),
                entry.id === value ? h('span', { className: 'dk-muted' }, '✓') : null,
              )),
            )
          : null,
      )
    }

    // --- port forward dialog ------------------------------------------------

    // One modal for both directions: `mode: 'start'` asks for the local port and
    // spawns `kubectl port-forward`, `mode: 'stop'` confirms closing a live one.
    function PortForwardDialog({ t, mode, forward, row, port, ports = [], forwards = [], cluster, onClose, onStart, onStop }) {
      const startMode = mode === 'start'
      const listMode = mode === 'list'
      const namespace = ((startMode || listMode) ? row?.namespace : forward?.namespace) || 'default'
      const podName = (startMode || listMode) ? row?.name : forward?.pod
      const target = Number(startMode ? port?.port : forward?.port)
      const portName = startMode ? (port?.name || '') : ''
      const label = `${target}${portName ? `(${portName})` : ''}`
      const [localPort, setLocalPort] = useState(String(target))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      // The list/start/stop modes share one component instance, and useState only
      // seeds on mount: re-seed the local port whenever the dialog switches to a
      // (new) start target, otherwise it keeps the list mode's placeholder.
      useEffect(() => {
        if (startMode) setLocalPort(String(target))
      }, [startMode, target, podName])

      const valid = /^\d+$/.test(localPort.trim()) && Number(localPort) >= 1 && Number(localPort) <= 65535

      const submit = useCallback(async () => {
        if (busy || (startMode && !valid)) return
        setBusy(true)
        setError(null)
        try {
          const result = startMode
            ? await call('forward-start', {
                cluster,
                namespace,
                pod: podName,
                port: target,
                localPort: Number(localPort),
              })
            : await call('forward-stop', { id: forward.id })
          if (!result || !result.ok) {
            setError((result && result.error) || t('pf.error'))
            return
          }
          onClose()
        } catch (failure) {
          setError(String(failure?.message || failure))
        } finally {
          setBusy(false)
        }
      }, [busy, cluster, forward, localPort, namespace, onClose, podName, startMode, t, target, valid])

      // The list mode is what the narrow table cell opens: every declared port of
      // the pod, with its forward state and the action that applies to it.
      if (mode === 'list') {
        return h('div', { className: 'dk-modal-mask', role: 'dialog', 'aria-modal': true },
          h('div', { className: 'dk-modal', style: { width: 'min(460px,94vw)' } },
            h('h3', null, t('pf.start.title')),
            h('div', { className: 'dk-muted' }, `${podName} · ${namespace}`),
            h('div', { style: { marginTop: 12 } },
              ports.length === 0
                ? h('div', { className: 'dk-muted' }, t('pf.empty'))
                : h('div', { className: 'dk-pf-list' }, ports.map((entry) => {
                    const forwarded = forwards.find((item) => item.pod === podName
                      && item.namespace === namespace && Number(item.port) === Number(entry.port))
                    const label = `${entry.port}${entry.name ? `(${entry.name})` : ''}`
                    const udp = String(entry.protocol || 'TCP').toUpperCase() === 'UDP'
                    if (forwarded) {
                      return h('button', {
                        key: entry.port,
                        className: 'dk-pf-row on',
                        title: forwarded.url,
                        onClick: () => onStop(forwarded),
                      }, h('span', null, label), h('span', { className: 'dk-mono' }, `127.0.0.1:${forwarded.localPort}`))
                    }
                    return h('button', {
                      key: entry.port,
                      className: `dk-pf-row${udp ? ' off' : ''}`,
                      disabled: udp,
                      title: udp ? t('pf.udp') : '',
                      onClick: () => onStart(entry),
                    }, h('span', null, label), h('span', { className: 'dk-muted' }, udp ? '—' : t('pf.action')))
                  }))
            ),
            h('div', { className: 'dk-muted', style: { marginTop: 8, fontSize: 11 } }, t('pf.notice')),
            h('div', { className: 'dk-actions' },
              h('button', { className: 'dk-btn ghost', onClick: onClose }, t('btn.close')),
            ),
          ),
        )
      }

      return h('div', { className: 'dk-modal-mask', role: 'dialog', 'aria-modal': true },
        h('div', { className: 'dk-modal', style: { width: 'min(460px,94vw)' } },
          h('h3', null, startMode ? t('pf.start.title') : t('pf.stop.title')),
          h('div', { className: 'dk-muted' }, `${podName} · ${namespace}`),
          h('div', { style: { marginTop: 12 } },
            h('div', null, t('pf.target'), ': ', h('span', { className: 'dk-code' }, label)),
            startMode
              ? h('div', { style: { marginTop: 10 } },
                  h('label', { className: 'dk-field-label', style: { display: 'block', marginBottom: 4 } }, t('pf.local')),
                  h('input', {
                    className: 'dk-input',
                    value: localPort,
                    inputMode: 'numeric',
                    spellCheck: false,
                    onChange: (event) => setLocalPort(event.target.value.replace(/[^\d]/g, '')),
                    onKeyDown: (event) => { if (event.key === 'Enter') submit() },
                  }),
                  h('div', { className: 'dk-muted', style: { marginTop: 6, fontSize: 11 } },
                    t('pf.hint').replace('{port}', localPort || '…')),
                )
              : h('div', { style: { marginTop: 10 } },
                  h('div', null, t('pf.local'), ': ', h('span', { className: 'dk-code' }, String(forward?.localPort ?? ''))),
                  h('div', { className: 'dk-muted', style: { marginTop: 6 } }, t('pf.stop.message')),
                ),
            h('div', { className: 'dk-muted', style: { marginTop: 8, fontSize: 11 } }, t('pf.notice')),
          ),
          error ? h('div', { className: 'dk-error', style: { marginTop: 10 } }, error) : null,
          h('div', { className: 'dk-actions' },
            h('button', { className: 'dk-btn ghost', onClick: onClose, disabled: busy }, t('btn.cancel')),
            h('button', {
              className: 'dk-btn primary',
              onClick: submit,
              disabled: busy || (startMode && !valid),
            }, busy ? t('pf.starting') : (startMode ? t('pf.confirm') : t('pf.stop.confirm'))),
          ),
        ),
      )
    }

    // --- login dialog -------------------------------------------------------

    // A button that pops up the workload actions as a menu. A plain <select>
    // always needs a selected item, which forced an awkward "操作" placeholder; a
    // popup menu has no placeholder and closes after a single pick. The row cell
    // holds no React state either (a 1450-row pod cluster would pay for it).
    function OpsMenu({ t, kind, onPick }) {
      const actions = opsFor(String(kind).split('.')[0].toLowerCase())
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      if (!actions.length) return null
      useEffect(() => {
        if (!open) return
        const close = (event) => { if (ref.current && !ref.current.contains(event.target)) setOpen(false) }
        const esc = (event) => { if (event.key === 'Escape') setOpen(false) }
        window.addEventListener('mousedown', close)
        window.addEventListener('keydown', esc)
        return () => {
          window.removeEventListener('mousedown', close)
          window.removeEventListener('keydown', esc)
        }
      }, [open])
      return h('div', { className: 'dk-ops-wrap', ref, onClick: (event) => event.stopPropagation() },
        h('button', {
          className: 'dk-btn dk-ops-trigger',
          title: t('col.ops'),
          'aria-label': t('col.ops'),
          onClick: () => setOpen((value) => !value),
        }, h('span', { className: 'dk-caret' })),
        open ? h('div', { className: 'dk-ops-menu' },
          actions.map((id) => h('button', {
            key: id,
            className: 'dk-ops-item',
            onClick: () => { setOpen(false); onPick(id) },
          }, t(`ops.${id}`))),
        ) : null,
      )
    }

    // One modal for every workload action: explains what the action does, asks for
    // a replica count when scaling, runs it, and reports kubectl's own output or
    // error verbatim. Actions that can take a while (rollout status) keep the
    // button in a busy state instead of blocking the table.
    function WorkloadOpsDialog({ t, cluster, kind, row, action, onClose, onDone }) {
      const base = String(kind).split('.')[0].toLowerCase()
      const currentReplicas = (() => {
        const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(String(row.ready || ''))
        return m ? m[2] : ''
      })()
      const [replicas, setReplicas] = useState(currentReplicas || '1')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      // Rollback target revisions, loaded from `kubectl rollout history`.
      const [revisions, setRevisions] = useState([])
      const [revLoading, setRevLoading] = useState(false)
      const [revError, setRevError] = useState(null)
      const [revSelected, setRevSelected] = useState(null)
      const settled = Boolean(result)

      const run = useCallback(async () => {
        if (busy || settled) return
        if (action === 'scale' && !/^\d+$/.test(String(replicas).trim())) {
          setError(t('ops.scaleInvalid'))
          return
        }
        if (action === 'undo' && revSelected == null) {
          setError(t('ops.revNone'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          const payload = {
            cluster,
            kind,
            name: row.name,
            namespace: row.namespace,
            action,
          }
          if (action === 'scale') payload.replicas = Number(replicas)
          if (action === 'undo') payload.revision = revSelected
          // Deletion is a general operation shared by every kind (and works for
          // cluster-scoped objects too), so it goes through the delete-resource
          // route; cordon/uncordon/drain are node scheduling ops via node-action;
          // the rest stay workload-specific.
          const isNodeOp = action === 'cordon' || action === 'uncordon' || action === 'drain'
          const route = action === 'delete' ? 'delete-resource'
            : isNodeOp ? 'node-action'
            : 'workload-action'
          const response = await call(route, isNodeOp ? { cluster, node: row.name, action } : payload)
          if (!response || !response.ok) {
            setError(response?.hint ? `${response.error}\n${response.hint}` : (response?.error || t('ops.failed')))
            return
          }
          setResult(response.text || t('ops.done'))
          onDone()
        } catch (failure) {
          setError(String(failure?.message || failure))
        } finally {
          setBusy(false)
        }
      }, [busy, settled, replicas, action, cluster, kind, row, t, onDone])

      // Esc closes while nothing is in flight; during a run the request must be
      // allowed to finish (there is no way to cancel a kubectl rollout).
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [busy, onClose])

      // For a rollback the dialog first reads the rollout history so the user can
      // pick a concrete revision. Default to the previous revision (the same
      // target as a bare `undo`); with only one revision there is nothing to
      // jump back to, so run is disabled.
      useEffect(() => {
        if (action !== 'undo') return
        let alive = true
        setRevLoading(true)
        setRevError(null)
        call('rollout-history', { cluster, kind, name: row.name, namespace: row.namespace })
          .then((response) => {
            if (!alive) return
            setRevLoading(false)
            if (!response || !response.ok || !Array.isArray(response.revisions)) {
              setRevError(response?.error || t('ops.revNone'))
              return
            }
            const list = response.revisions
            setRevisions(list)
            const target = list.length > 1 ? list[list.length - 2] : list[list.length - 1]
            setRevSelected(target ? target.revision : null)
          })
          .catch((failure) => {
            if (!alive) return
            setRevLoading(false)
            setRevError(String(failure?.message || failure))
          })
        return () => { alive = false }
      }, [action, cluster, kind, row, t])

      return h('div', { className: 'dk-modal-mask', role: 'dialog', 'aria-modal': true },
        h('div', { className: 'dk-modal', style: { width: 'min(520px,94vw)' } },
          h('h3', null, `${t(OPS_ACTIONS[base] ? 'ops.title' : 'ops.titleResource')} · ${t(`ops.${action}`)}`),
          h('div', { className: 'dk-muted', style: { lineHeight: 1.7, wordBreak: 'break-all' } },
            t('ops.target').replace('{kind}', base).replace('{name}', String(row.name || '')),
          ),
          row.namespace
            ? h('div', { className: 'dk-muted' }, t('ops.namespace').replace('{namespace}', row.namespace))
            : null,
          h('div', { style: { margin: '10px 0', lineHeight: 1.7 } },
            t((action === 'delete' && !OPS_ACTIONS[base]) ? 'ops.warn.deleteResource' : `ops.warn.${action}`)),
          action === 'scale'
            ? h('div', { className: 'dk-field', style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', null, t('ops.scaleLabel')),
                h('input', {
                  className: 'dk-input',
                  type: 'number',
                  min: 0,
                  step: 1,
                  style: { width: 100 },
                  value: replicas,
                  disabled: busy || settled,
                  autoFocus: true,
                  onChange: (event) => setReplicas(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') run() },
                }),
                h('span', { className: 'dk-muted' }, t('ops.scaleHint').replace('{current}', currentReplicas || '—')),
              )
            : null,
          action === 'undo'
            ? h('div', { className: 'dk-ops-revs' },
                h('div', { className: 'dk-muted', style: { marginBottom: 4 } }, t('ops.revLabel')),
                revLoading
                  ? h('div', { className: 'dk-muted' }, t('ops.revLoading'))
                  : revError
                    ? h('div', { className: 'dk-ops-panel err' }, revError)
                    : revisions.length === 0
                      ? h('div', { className: 'dk-muted' }, t('ops.revNone'))
                      : h('div', { className: 'dk-rev-list' },
                          revisions.map((entry) => h('label', {
                            key: entry.revision,
                            className: `dk-rev-item${revSelected === entry.revision ? ' on' : ''}`,
                          },
                            h('input', {
                              type: 'radio', name: 'dk-rev',
                              checked: revSelected === entry.revision,
                              onChange: () => setRevSelected(entry.revision),
                            }),
                            h('span', { className: 'dk-rev-num' }, `#${entry.revision}`),
                            h('span', { className: 'dk-rev-cause' },
                              entry.cause && entry.cause !== '<none>' ? entry.cause : t('ops.revCauseNone')),
                          )),
                          h('div', { className: 'dk-muted', style: { marginTop: 6 } }, t('ops.revHint')),
                        ),
              )
            : null,
          error ? h('div', { className: 'dk-ops-panel err' }, `${t('ops.failed')}\n${error}`) : null,
          result ? h('div', { className: 'dk-ops-panel ok' }, `${t('ops.done')}\n${result}`) : null,
          h('div', { className: 'dk-actions' },
            h('button', { className: 'dk-btn ghost', onClick: onClose, disabled: busy }, settled ? t('btn.close') : t('btn.cancel')),
            settled
              ? null
              : h('button', {
                  className: 'dk-btn primary',
                  onClick: run,
                  disabled: busy || (action === 'undo' && (revLoading || revisions.length === 0 || revSelected == null)),
                }, busy ? t('ops.busy') : t('ops.run')),
          ),
        ),
      )
    }

    function LoginDialog({ t, cluster, auth, bridge, onClose, onDone }) {
      const [session, setSession] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const timer = useRef(null)

      const stopPoll = () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
      }

      const poll = useCallback(async () => {
        try {
          const result = await call('login-status', { cluster })
          if (result.session) setSession(result.session)
          const status = result.session?.status
          if (status === 'succeeded') {
            stopPoll()
            onDone(result.session)
            return
          }
          if (status === 'failed' || status === 'cancelled') {
            stopPoll()
            return
          }
          timer.current = setTimeout(poll, 1200)
        } catch (failure) {
          stopPoll()
          setError(String(failure?.message || failure))
        }
      }, [cluster, onDone])

      useEffect(() => () => stopPoll(), [])

      const start = useCallback(async () => {
        stopPoll()
        setBusy(true)
        setError(null)
        setSession(null)
        try {
          // OIDC/exec clusters always log in via the browser by default.
          const result = await call('login', { cluster, method: 'browser' })
          setSession(result.session || null)
          if (!result.ok && result.error) setError(result.error)
          timer.current = setTimeout(poll, 900)
        } catch (failure) {
          setError(String(failure?.message || failure))
        } finally {
          setBusy(false)
        }
      }, [cluster, poll])

      useEffect(() => { start() }, []) // eslint-disable-line react-hooks/exhaustive-deps

      const cancel = useCallback(async () => {
        stopPoll()
        try { await call('login-cancel', { cluster }) } catch {}
        onClose()
      }, [cluster, onClose])

      const openAgain = useCallback(() => {
        const url = session?.url
        if (!url) return
        call('login', { cluster, method: 'browser' }).then((result) => {
          if (result.session) setSession(result.session)
        }).catch(() => {})
      }, [session, cluster])

      const copyUrl = useCallback(async () => {
        if (!session?.url) return
        try { await navigator.clipboard.writeText(session.url) } catch {}
      }, [session])

      const status = session?.status || (busy ? 'starting' : 'starting')
      const failed = status === 'failed' || status === 'cancelled' || status === 'succeeded'

      return h('div', { className: 'dk-modal-mask', role: 'dialog', 'aria-modal': true },
        h('div', { className: 'dk-modal' },
          h('h3', null, `${t('login.title')} · ${cluster}`),
          h('div', { className: 'dk-muted' }, `${authLabel(t, auth)}${auth?.reason ? ` · ${auth.reason}` : ''}`),

          h('div', { style: { marginTop: 12 } },
            h('div', { style: { fontWeight: 500 } }, stateLabel(t, status === 'waiting' ? 'needs-login' : status)),
            session?.message
              ? h('div', { className: 'dk-error', style: { marginTop: 8 } }, session.message)
              : null,
            session?.url
              ? h('div', { style: { marginTop: 10 } },
                  h('div', { className: 'dk-muted', style: { marginBottom: 4 } }, t('login.url')),
                  h('button', { className: 'dk-link', onClick: copyUrl, title: t('btn.copy') }, session.url),
                )
              : null,
            session?.code
              ? h('div', { style: { marginTop: 8 } }, `${t('login.code')}: `, h('span', { className: 'dk-code' }, session.code))
              : null,
            session?.browserOpened
              ? h('div', { className: 'dk-muted', style: { marginTop: 8 } }, t('login.browserOpened'))
              : (bridge === false ? h('div', { className: 'dk-muted', style: { marginTop: 8 } }, t('msg.noBrowser')) : null),
            status === 'waiting' || status === 'starting'
              ? h('div', { className: 'dk-muted', style: { marginTop: 8 } }, t('login.waiting'))
              : null,
          ),

          error ? h('div', { className: 'dk-error', style: { marginTop: 10 } }, error) : null,

          h('div', { className: 'dk-actions' },
            session?.url && !failed
              ? h('button', { className: 'dk-btn', onClick: openAgain }, t('btn.openAgain'))
              : null,
            h('button', { className: 'dk-btn', onClick: cancel }, failed ? t('btn.close') : t('btn.cancel')),
          ),
        ),
      )
    }

    // --- rightbar detail tab (resource inspector) ---------------------------

    // Body registered into `sidebar.right.pane.tab`. The seat injects the bound
    // `useTabInfo` hook as a prop; navigation.params carries the { cluster, kind, row }
    // we passed to ctx.sidebarRight.openTab('kube-detail', { params }).
    // Lightweight syntax highlighter (no dependency). Returns HTML; only used
    // with dangerouslySetInnerHTML on trusted kubectl output. mode: 'yaml' | 'describe'.
    function highlightSyntax(text, mode) {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const sp = (cls, s) => `<span class="dk-sy ${cls}">${esc(s)}</span>`
      if (!text) return ''
      const lines = String(text).split('\n')
      // Colorize a value/continuation string: quoted strings, <angle-bracket>
      // placeholders (e.g. <none>, <set to the key '...' of config map '...'>),
      // `key=value` label assignments, numbers/quantities, and known status words.
      const colorValue = (v) => {
        const re = /('[^']*'|"[^"]*")|(<[^>]*>)|([A-Za-z0-9_.\/-]+=[^,\s]+)|(?<![A-Za-z0-9])(-?\d+(?:\.\d+)?(?:[A-Za-z%]+)?)(?![A-Za-z0-9])|(\bTrue\b|\bFalse\b|\bNone\b|\bRunning\b|\bPending\b|\bReady\b|\bAvailable\b|\bProgressing\b|\bSucceeded\b|\bFailed\b|\bUnknown\b|\bCompleted\b|\bSuspended\b|\bTerminating\b)/g
        let out = ''
        let last = 0
        let m
        while ((m = re.exec(v))) {
          out += esc(v.slice(last, m.index))
          if (m[1]) out += sp('str', m[1])
          else if (m[2]) out += sp('const', m[2])
          else if (m[3]) {
            const eq = m[3].indexOf('=')
            out += sp('key', m[3].slice(0, eq)) + esc('=') + colorValue(m[3].slice(eq + 1))
          }
          else if (m[4]) out += sp('num', m[4])
          else if (m[5]) out += sp('const', m[5])
          last = m.index + m[0].length
        }
        out += esc(v.slice(last))
        return out
      }
      const out = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const tr = line.trim()
        if (!tr) { out.push(''); continue }
        if (/^=+$/.test(tr)) { out.push(sp('muted', line)); continue }

        if (mode === 'yaml') {
          if (/^#/.test(tr)) { out.push(sp('comment', line)); continue }
          if (/^---/.test(tr)) { out.push(sp('punct', line)); continue }
          // list item: "- " prefix
          const lm = line.match(/^(\s*-\s*)(.*)$/)
          if (lm) {
            // nested key:val inside a list item
            const nm = lm[2].match(/^(\s*)([^:]+?)(\s*:\s*)(.*)$/)
            if (nm && nm[4].trim()) {
              const val = /^['"]/.test(nm[4]) ? sp('str', nm[4])
                : /^(true|false|null|none|~)$/i.test(nm[4].trim()) ? sp('const', nm[4])
                : /^-?\d+([.\d]*)$/.test(nm[4].trim()) ? sp('num', nm[4]) : esc(nm[4])
              out.push(esc(lm[1]) + esc(nm[1]) + sp('key', nm[2]) + esc(nm[3]) + val)
            } else {
              out.push(esc(lm[1]) + sp('str', lm[2]))
            }
            continue
          }
          // mapping "key: value"
          const m = line.match(/^(\s*)([^:]+?)(\s*:\s*)(.*)$/)
          if (m) {
            const val = /^['"]/.test(m[4]) ? sp('str', m[4])
              : /^(true|false|null|none|~)$/i.test(m[4].trim()) ? sp('const', m[4])
              : /^-?\d+([.\d]*)$/.test(m[4].trim()) ? sp('num', m[4]) : esc(m[4])
            out.push(esc(m[1]) + sp('key', m[2]) + esc(m[3]) + val)
            continue
          }
          out.push(esc(line))
          continue
        }

        // ---- kubectl describe ----
        // Table column header row (all-caps columns) when the following line is
        // the dashed underline (e.g. "Type  Status  Reason" over "---- ------ ------").
        const nextTr = lines[i + 1] ? lines[i + 1].trim() : ''
        if (/^[A-Z][A-Za-z0-9]+(?:\s{2,}[A-Z][A-Za-z0-9 ]*)+$/.test(tr) && /^[\- ]+$/.test(nextTr)) {
          out.push(sp('hdr', line)); continue
        }
        // dashed separator rows (table underline)
        if (/^[\- ]+$/.test(tr)) { out.push(sp('muted', line)); continue }
        // Section header / nested key with no value ("Key:" alone, e.g. "Conditions:",
        // "Pod Template:", container name lines like "server:") → white bold.
        if (/^[A-Za-z][A-Za-z0-9 _./-]*:\s*$/.test(tr)) { out.push(sp('hdr', line)); continue }
        // "Key: value" — color the key blue, then colorize the value.
        const km = line.match(/^(\s*)([^:]+?)(\s*:\s*)(.*)$/)
        if (km && km[2].trim()) {
          out.push(esc(km[1]) + sp('key', km[2].trim()) + esc(km[3]) + colorValue(km[4]))
          continue
        }
        // Continuation / value-only line (e.g. a wrapped label list) → colorize inline tokens.
        out.push(colorValue(line))
      }
      return out.join('\n')
    }

    // Read and edit share ONE surface: a syntax-highlighted layer with a
    // transparent textarea on top. Read-only is the same component with the
    // textarea in readOnly mode, so switching to edit changes nothing about the
    // typography, colours, wrapping or scroll position — only the caret appears.
    // A plain <textarea> can't carry syntax colours itself, and a second styled
    // view (what this replaces) made edit mode look like a different product.
    function YamlView({ text, mode, readOnly, onChange, onCancel }) {
      const layerRef = useRef(null)
      const inputRef = useRef(null)
      const body = String(text ?? '')
      const html = highlightSyntax(body, mode)

      // Keep the highlight layer glued to the textarea: same scroll offset and,
      // because a textarea's scrollbar steals width from its text box, the same
      // content width (otherwise wrapped lines drift apart line by line).
      const sync = useCallback(() => {
        const input = inputRef.current
        const layer = layerRef.current
        if (!input || !layer) return
        const gutter = input.offsetWidth - input.clientWidth
        layer.style.paddingRight = `${12 + gutter}px`
        layer.scrollTop = input.scrollTop
        layer.scrollLeft = input.scrollLeft
      }, [])

      // Entering edit mode puts the caret in the text; leaving it hands focus back
      // to the pane so no invisible read-only textarea keeps swallowing keys.
      useEffect(() => {
        const input = inputRef.current
        if (!input) return
        if (readOnly) input.blur()
        else input.focus()
      }, [readOnly])

      useEffect(() => {
        sync()
        if (typeof ResizeObserver === 'undefined') return undefined
        const input = inputRef.current
        if (!input) return undefined
        const ro = new ResizeObserver(() => sync())
        ro.observe(input)
        return () => ro.disconnect()
      }, [sync, body])

      return h('div', { className: 'dk-yaml-view' },
        h('pre', {
          className: 'dk-yaml-layer',
          ref: layerRef,
          'aria-hidden': 'true',
          dangerouslySetInnerHTML: { __html: html },
        }),
        h('textarea', {
          className: 'dk-yaml-input',
          ref: inputRef,
          value: body,
          readOnly: !!readOnly,
          spellCheck: false,
          autoComplete: 'off',
          wrap: 'soft',
          onScroll: sync,
          onChange: onChange ? (event) => onChange(event.target.value) : undefined,
          onKeyDown: onCancel
            ? (event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel() } }
            : undefined,
        }),
      )
    }

    function DetailTab(props) {
      useStyles()
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      const cluster = params.cluster
      const kind = params.kind
      const row = params.row || {}
      const t = props.t
      const namespace = row.namespace || undefined
      const name = row.name
      // Users/Groups are synthesized from RoleBinding subjects, not real objects,
      // so there is nothing for kubectl apply to accept in their YAML.
      const pseudo = /^(rbacusers|rbacgroups)$/.test(String(kind || '').split('.')[0].toLowerCase())

      const [tab, setTab] = useState('yaml')
      const [value, setValue] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)
      const [copied, setCopied] = useState(false)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [applyError, setApplyError] = useState(null)
      const [notice, setNotice] = useState(null)

      const reload = useCallback(async () => {
        if (!cluster || !kind) return { ok: false, error: t('state.error') }
        if (tab === 'yaml') return call('yaml', { cluster, kind, name, namespace })
        return call('describe', { cluster, kind, name, namespace })
      }, [tab, cluster, kind, name, namespace, t])

      useEffect(() => {
        let alive = true
        setLoading(true)
        setError(null)
        setValue(null)
        reload().then((result) => {
          if (!alive) return
          if (!result || !result.ok) setError(result?.hint ? `${result.error}\n${result.hint}` : result?.error || t('state.error'))
          else if (tab === 'yaml') setValue(result.yaml)
          else setValue(result.description)
        }).catch((failure) => {
          if (alive) setError(String(failure?.message || failure))
        }).finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [reload, tab, t])

      // Editing only ever targets YAML; leaving the tab abandons the draft.
      const switchTab = useCallback((id) => {
        if (editing) return
        setTab(id)
      }, [editing])

      const copy = useCallback(async () => {
        if (!value) return
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {}
      }, [value])

      const secret = /^secrets$/i.test(String(kind || '').split('.')[0])
      const startEdit = useCallback(async () => {
        setApplyError(null)
        setNotice(null)
        // Start from a sanitized manifest: the read view keeps server-populated
        // metadata and (for Secrets) decodes `data` to text, neither of which is
        // valid input for kubectl apply.
        let text = value || ''
        try {
          const draftYaml = await call('yaml', { cluster, kind, name, namespace, forEdit: true })
          if (draftYaml && draftYaml.ok) text = draftYaml.yaml
          else if (draftYaml && draftYaml.error) { setApplyError(draftYaml.error); return }
        } catch (failure) {
          setApplyError(String(failure?.message || failure))
          return
        }
        setDraft(text)
        setEditing(true)
      }, [value, secret, cluster, kind, name, namespace])

      const cancelEdit = useCallback(() => {
        setEditing(false)
        setDraft('')
        setApplyError(null)
      }, [])

      const save = useCallback(async () => {
        if (saving || !draft.trim()) return
        const question = t('edit.confirm').replace('{cluster}', String(cluster || ''))
        const agreed = typeof window !== 'undefined' && window.confirm ? window.confirm(question) : true
        if (!agreed) return
        setSaving(true)
        setApplyError(null)
        setNotice(null)
        try {
          const result = await call('apply', { cluster, yaml: draft, namespace })
          if (!result || !result.ok) {
            setApplyError(result?.hint ? `${result.error}\n${result.hint}` : (result?.error || t('edit.failed')))
            return
          }
          setEditing(false)
          setDraft('')
          setNotice(`${t('edit.applied')}${result.text ? ` · ${String(result.text).split('\n').filter(Boolean)[0]}` : ''}`)
          // Show what the API server actually stored, not what was typed.
          try {
            const fresh = await call('yaml', { cluster, kind, name, namespace })
            if (fresh && fresh.ok) setValue(fresh.yaml)
          } catch {}
          emitApplied({ cluster, kind, name, namespace })
        } catch (failure) {
          setApplyError(String(failure?.message || failure))
        } finally {
          setSaving(false)
        }
      }, [saving, draft, cluster, namespace, kind, name, t])

      const tabs = [['yaml', t('detail.yaml')], ['describe', t('detail.describe')]]
      const canEdit = tab === 'yaml' && !pseudo && value !== null && !loading && !error

      return h('div', { className: 'dk-detail-tab' },
        h('div', { className: 'dk-drawer-head' },
          h('span', { className: 'dk-mono', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name || ''),
          tabs.map(([id, label]) => h('button', {
            key: id,
            className: 'dk-tab' + (tab === id ? ' active' : ''),
            style: { height: 24, borderBottomWidth: 2 },
            disabled: editing,
            title: editing ? t('edit.blocked') : undefined,
            onClick: () => switchTab(id),
          }, label)),
        ),
        h('div', { className: 'dk-drawer-body' },
          loading ? h('div', { className: 'dk-muted' }, t('detail.loading')) : null,
          error ? h('div', { className: 'dk-error' }, error) : null,
          applyError ? h('div', { className: 'dk-error dk-pre-wrap' }, `${t('edit.failed')}\n${applyError}`) : null,
          notice ? h('div', { className: 'dk-apply-note' }, notice) : null,
          !loading && !error && (editing || value !== null)
            ? [
              editing && secret ? h('div', { key: 'hint', className: 'dk-muted dk-edit-hint' }, t('edit.secret')) : null,
              h(YamlView, {
                key: 'view',
                text: editing ? draft : value,
                mode: tab === 'yaml' ? 'yaml' : 'describe',
                readOnly: !editing,
                onChange: editing ? setDraft : undefined,
                onCancel: editing ? cancelEdit : undefined,
              }),
            ]
            : null,
        ),
        h('div', { className: 'dk-drawer-head', style: { borderTop: '1px solid #333', borderBottom: 'none' } },
          h('span', { className: 'dk-muted', style: { flex: 1 } }, namespace ? `${kind} · ${namespace}` : kind),
          editing
            ? [
              h('button', { key: 'cancel', className: 'dk-btn ghost', onClick: cancelEdit, disabled: saving }, t('btn.cancel')),
              h('button', { key: 'save', className: 'dk-btn', onClick: save, disabled: saving || !draft.trim() }, saving ? t('edit.saving') : t('btn.save')),
            ]
            : [
              canEdit ? h('button', { key: 'edit', className: 'dk-btn ghost', onClick: startEdit }, t('btn.edit')) : null,
              h('button', { key: 'copy', className: 'dk-btn ghost', onClick: copy, disabled: !value }, copied ? t('btn.copied') : t('btn.copy')),
            ],
        ),
      )
    }

    // Chip title for the detail tab: a cube glyph + the resource name.
    // Icon follows the host right-sidebar chip convention: 16px, currentColor,
    // flex:none, 4px gap from the label text (same as the browser/files tabs).
    function DetailTabTitle(props) {
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      const name = params?.row?.name
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
        h(DetailIcon, { size: 16, className: 'dk-tab-chip-icon' }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name || ''),
      )
    }

    // --- pod logs: dedicated streaming tab ---------------------------------
    // Behaves like `kubectl logs -f` in a shell: the host runs one kubectl child
    // per open tab and streams raw text. With no search query the pane appends
    // every chunk straight into the DOM as a text node (no React re-render per
    // line, cost O(chunk)); with a query it renders only the matching lines,
    // coalesced to at most one rebuild every 250 ms. Closing the tab aborts the
    // fetch, which kills the child process on the host.
    const LOG_KEEP_CHARS = 400000
    const LOG_SEARCH_MAX_LINES = 3000

    function escapeLogHtml(text) {
      return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    // Query language, kept deliberately predictable:
    //   /pattern/flags -> regular expression (flags optional)
    //   containing * or ? -> glob wildcard, * = any run, ? = one character
    //   otherwise -> case-insensitive literal substring
    function buildLogMatcher(query) {
      const text = String(query || '')
      if (!text) return null
      const asRegex = /^\/(.+)\/([gimsuy]*)$/.exec(text)
      if (asRegex) {
        const flags = asRegex[2].includes('g') ? asRegex[2] : asRegex[2] + 'g'
        try {
          const re = new RegExp(asRegex[1], flags)
          return { re, test: (line) => { re.lastIndex = 0; return re.test(line) } }
        } catch (failure) {
          return { error: String(failure?.message || failure) }
        }
      }
      if (text.includes('*') || text.includes('?')) {
        const glob = text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
        try {
          const re = new RegExp(glob, 'gi')
          return { re, test: (line) => { re.lastIndex = 0; return re.test(line) } }
        } catch (failure) {
          return { error: String(failure?.message || failure) }
        }
      }
      const literal = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(literal, 'gi')
      return { re, test: (line) => { re.lastIndex = 0; return re.test(line) } }
    }

    // Highlight every match on one line. Matching runs on the raw line and the
    // pieces are escaped as they are emitted, so entities from the log text can
    // never be mistaken for markup.
    function highlightLogLine(line, matcher) {
      if (!matcher || !matcher.re) return escapeLogHtml(line)
      const re = matcher.re
      re.lastIndex = 0
      let out = ''
      let last = 0
      let guard = 0
      let hit
      while ((hit = re.exec(line)) !== null) {
        if (guard++ > 200) break
        if (hit[0] === '') { re.lastIndex += 1; continue }
        out += escapeLogHtml(line.slice(last, hit.index))
        out += `<mark class="dk-logs-hit">${escapeLogHtml(hit[0])}</mark>`
        last = hit.index + hit[0].length
      }
      out += escapeLogHtml(line.slice(last))
      return out
    }

    function LogsPane(props) {
      useStyles()
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      const cluster = params.cluster
      const pod = params.pod || params.name
      const namespace = params.namespace || undefined
      // Optional single-container target: when set, the stream is narrowed to
      // `-c <container>` on this pod.
      const container = params.container || undefined
      // Resource type the logs belong to ('pods' | 'deployments' | 'statefulsets').
      // kubectl logs accepts deployment/<name> and statefulset/<name> selectors,
      // so a workload row streams the logs of the pod(s) it owns.
      const kindBase = String(params.kind || 'pods').split('.')[0]
      const t = props.t

      const [status, setStatus] = useState('connecting') // connecting | streaming | closed | error
      const [error, setError] = useState(null)
      const [autoScroll, setAutoScroll] = useState(true)
      const [query, setQuery] = useState('')
      const [view, setView] = useState(null) // { html, count, error } while searching
      const preRef = useRef(null)
      const bodyRef = useRef(null)
      const autoRef = useRef(true)
      const bufRef = useRef('')   // raw text kept for search mode (capped)
      const charsRef = useRef(0)  // characters currently in the visible <pre>
      const queryRef = useRef('')
      const timerRef = useRef(null)
      const dirtyRef = useRef(false)

      useEffect(() => { autoRef.current = autoScroll }, [autoScroll])

      const renderSearch = () => {
        const text = queryRef.current
        if (!text) { setView(null); return }
        const matcher = buildLogMatcher(text)
        if (matcher?.error) { setView({ html: '', count: 0, error: matcher.error }); return }
        const all = bufRef.current.split('\n')
        const hits = []
        // Walk backwards so the newest matching lines win when capped, then
        // restore chronological order for display.
        for (let i = all.length - 1; i >= 0 && hits.length < LOG_SEARCH_MAX_LINES; i -= 1) {
          if (matcher.test(all[i])) hits.push(all[i])
        }
        hits.reverse()
        setView({ html: hits.map((line) => highlightLogLine(line, matcher)).join('\n'), count: hits.length, error: null })
        const el = bodyRef.current
        if (el && autoRef.current) el.scrollTop = el.scrollHeight
      }

      const scheduleSearch = () => {
        if (timerRef.current) return
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          if (!dirtyRef.current) return
          dirtyRef.current = false
          renderSearch()
        }, 250)
      }

      useEffect(() => {
        queryRef.current = query
        if (!query) {
          // Back to the fast append path: rebuild the hidden <pre> from the
          // buffer so nothing streamed during the search is lost.
          setView(null)
          const pre = preRef.current
          if (pre) pre.textContent = bufRef.current
          charsRef.current = bufRef.current.length
          return
        }
        dirtyRef.current = true
        scheduleSearch()
      }, [query])

      useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

      useEffect(() => {
        if (!cluster || !pod) return
        let alive = true
        const ac = new AbortController()
        bufRef.current = ''
        charsRef.current = 0
        if (preRef.current) preRef.current.textContent = ''
        setStatus('connecting')
        setError(null)
        const append = (text) => {
          if (!alive || !text) return
          bufRef.current += text
          if (bufRef.current.length > LOG_KEEP_CHARS) {
            const cut = bufRef.current.indexOf('\n', bufRef.current.length - LOG_KEEP_CHARS)
            bufRef.current = cut === -1 ? bufRef.current.slice(-LOG_KEEP_CHARS) : bufRef.current.slice(cut + 1)
          }
          if (queryRef.current) { dirtyRef.current = true; scheduleSearch(); return }
          const target = preRef.current
          if (!target) return
          // Resolve the live element each time: if React re-creates the <pre>
          // a captured node would be detached and the bytes would go nowhere.
          target.appendChild(document.createTextNode(text))
          charsRef.current += text.length
          while (charsRef.current > LOG_KEEP_CHARS && target.firstChild) {
            charsRef.current -= String(target.firstChild.textContent || '').length
            target.removeChild(target.firstChild)
          }
          target.setAttribute('data-bytes', String(charsRef.current))
          const el = bodyRef.current
          if (el && autoRef.current) el.scrollTop = el.scrollHeight
        }
        const stream = (async () => {
          const response = await fetch('/dsh-kube/logs-follow', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cluster, kind: kindBase, pod, namespace, container }),
            signal: ac.signal,
          })
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
          if (alive) setStatus('streaming')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            append(decoder.decode(value, { stream: true }))
          }
          append(decoder.decode())
        })()
        stream.then(() => { if (alive) setStatus('closed') }).catch((failure) => {
          if (!alive || failure?.name === 'AbortError') return
          setError(String(failure?.message || failure))
          setStatus('error')
        })
        return () => { alive = false; ac.abort() }
      }, [cluster, kindBase, pod, namespace, container])

      const searching = Boolean(query)
      const searchError = view?.error
      const statusText = status === 'streaming' ? t('logs.follow')
        : status === 'closed' ? t('logs.closed')
        : status === 'error' ? t('state.error')
        : t('logs.connecting')

      return h('div', { className: 'dk-logs' },
        h('div', { className: 'dk-drawer-head dk-logs-head' },
          h('span', { className: 'dk-mono dk-logs-title' }, container ? `${pod || ''} [${container}]` : (pod || '')),
          h('span', { className: 'dk-badge' + (status === 'streaming' ? ' ok' : '') }, statusText),
          h('label', { className: 'dk-auto' },
            h('input', {
              type: 'checkbox', checked: autoScroll,
              onChange: (event) => setAutoScroll(event.target.checked),
            }),
            h('span', null, t('logs.auto')),
          ),
        ),
        h('div', { className: 'dk-logs-searchbar' },
          h('input', {
            className: 'dk-input dk-logs-search' + (searchError ? ' invalid' : ''),
            placeholder: t('logs.search.placeholder'),
            value: query,
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Escape') setQuery('') },
          }),
          searching
            ? h('span', { className: 'dk-badge' + (searchError ? ' error' : '') },
                searchError ? t('logs.search.invalid') : t('logs.search.hits').replace('{n}', String(view?.count ?? 0)))
            : null,
        ),
        h('div', { className: 'dk-logs-body', ref: bodyRef },
          error ? h('div', { className: 'dk-error' }, error) : null,
          h('pre', { className: 'dk-logs-pre', ref: preRef, style: searching ? { display: 'none' } : null }),
          searching ? h('pre', { className: 'dk-logs-pre', dangerouslySetInnerHTML: { __html: view?.html || '' } }) : null,
          searching && view && view.count === 0 && !searchError
            ? h('div', { className: 'dk-logs-hint' }, t('logs.search.none'))
            : null,
          status === 'connecting' ? h('div', { className: 'dk-logs-hint' }, t('logs.connecting')) : null,
        ),
        h('div', { className: 'dk-drawer-head dk-logs-foot' },
          h('span', { className: 'dk-muted', style: { flex: 1 } }, namespace ? `${kindBase} · ${namespace}` : kindBase),
          h('span', { className: 'dk-muted' }, t('logs.keep').replace('{n}', String(Math.round(LOG_KEEP_CHARS / 1000)))),
        ),
      )
    }

    // Chip title for the logs tab: the log-lines glyph + the pod name.
    // Icon follows the host right-sidebar chip convention: 16px, currentColor,
    // flex:none, 4px gap from the label text (same as the browser/files tabs).
    function LogsTabTitle(props) {
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
        h(LogsIcon, { size: 16, className: 'dk-tab-chip-icon' }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          params?.container ? `${params.pod || params.name || ''} [${params.container}]` : (params?.pod || params?.name || '')),
      )
    }

    // Terminal glyph used by the container login cell and the shell tab chip.
    function ShellIcon({ size, className }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, className,
      },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M7 9.5 9.5 12 7 14.5M12 15h5' }),
      )
    }

    // --- xterm.js -----------------------------------------------------------
    // The host serves the vendored bundle from /dsh-kube/assets/, so the pane
    // needs no build step and no network access at render time.
    const TERM_ASSETS = '/dsh-kube/assets'
    let xtermLoader = null
    function loadXterm() {
      if (window.Terminal && window.FitAddon) return Promise.resolve()
      if (xtermLoader) return xtermLoader
      const script = (src) => new Promise((resolve, reject) => {
        const el = document.createElement('script')
        el.src = src
        el.async = true
        el.onload = () => resolve()
        el.onerror = () => reject(new Error(`无法加载 ${src}`))
        document.head.appendChild(el)
      })
      xtermLoader = (async () => {
        if (!document.querySelector('link[data-dk-xterm]')) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = `${TERM_ASSETS}/xterm.css`
          link.setAttribute('data-dk-xterm', '1')
          document.head.appendChild(link)
        }
        await script(`${TERM_ASSETS}/xterm.js`)
        await script(`${TERM_ASSETS}/addon-fit.js`)
        if (!window.Terminal) throw new Error('xterm.js 加载失败')
      })()
      xtermLoader.catch(() => { xtermLoader = null })
      return xtermLoader
    }

    function codeFontFamily() {
      try {
        const value = getComputedStyle(document.documentElement).getPropertyValue('--ds-font-family-code')
        if (value && value.trim()) return value.trim()
      } catch {}
      return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    }

    // Live container shell, rendered by xterm.js over a real PTY. The host keeps
    // one `kubectl exec -it -- bash|sh` process per session: keystrokes go to
    // /dsh-kube/exec-input, the pty size follows the pane (exec-resize), and the
    // byte stream arrives on /dsh-kube/exec-stream. Unmounting the pane (closing
    // the sidebar tab) POSTs /dsh-kube/exec-stop, which kills kubectl.
    function ShellPane(props) {
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      const id = String(params.id || '')
      const t = props.t
      const [status, setStatus] = useState('connecting')
      const [error, setError] = useState(null)
      const [size, setSize] = useState({ cols: Number(params.cols) || 120, rows: Number(params.rows) || 32 })
      const hostRef = useRef(null)
      const termRef = useRef(null)
      const queueRef = useRef('')
      const flushTimer = useRef(0)
      // Coalesce keystrokes into one request per short burst; a keystroke each
      // would mean one POST per character.
      const sendInput = useCallback((data) => {
        if (!id || !data) return
        queueRef.current += data
        if (flushTimer.current) return
        flushTimer.current = setTimeout(() => {
          flushTimer.current = 0
          const chunk = queueRef.current
          queueRef.current = ''
          if (!chunk) return
          call('exec-input', { id, data: chunk }).then((result) => {
            if (result && result.ok === false && result.kind === 'closed') setStatus('closed')
          }).catch(() => {})
        }, 20)
      }, [id])
      const pushSize = useCallback((cols, rows) => {
        if (!id) return
        call('exec-resize', { id, cols, rows }).catch(() => {})
      }, [id])

      useEffect(() => {
        if (!id) { setStatus('error'); setError(t('shell.unsupported')); return }
        let disposed = false
        let term = null
        let fit = null
        let observer = null
        let fitTimer = 0
        let seenCols = 0
        let seenRows = 0
        const ac = new AbortController()
        const boot = async () => {
          await loadXterm()
          if (disposed || !hostRef.current) return
          term = new window.Terminal({
            cursorBlink: true,
            fontSize: 12,
            lineHeight: 1.25,
            scrollback: 5000,
            fontFamily: codeFontFamily(),
            theme: {
              background: '#0d0d0d',
              foreground: '#e5e7eb',
              cursor: '#4ade80',
              cursorAccent: '#0d0d0d',
              selectionBackground: '#374151',
              black: '#1f2937', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
              blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb',
              brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a',
              brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f9fafb',
            },
          })
          fit = new window.FitAddon.FitAddon()
          term.loadAddon(fit)
          term.open(hostRef.current)
          try { fit.fit() } catch {}
          termRef.current = term
          seenCols = term.cols
          seenRows = term.rows
          setSize({ cols: term.cols, rows: term.rows })
          pushSize(term.cols, term.rows)
          term.onData(sendInput)
          term.focus()
          const refit = () => {
            if (disposed || !fit) return
            try { fit.fit() } catch { return }
            if (term.cols === seenCols && term.rows === seenRows) return
            seenCols = term.cols
            seenRows = term.rows
            setSize({ cols: term.cols, rows: term.rows })
            pushSize(term.cols, term.rows)
          }
          observer = new ResizeObserver(() => {
            if (fitTimer) clearTimeout(fitTimer)
            fitTimer = setTimeout(refit, 80)
          })
          observer.observe(hostRef.current)
          const response = await fetch('/dsh-kube/exec-stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
            signal: ac.signal,
          })
          if (!response.ok || !response.body) {
            const payload = await response.json().catch(() => null)
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          if (disposed) return
          setStatus('running')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (disposed) return
            term.write(decoder.decode(value, { stream: true }))
          }
          if (!disposed) { term.write(decoder.decode()); setStatus('closed') }
        }
        boot().catch((failure) => {
          if (disposed || failure?.name === 'AbortError') return
          setError(String(failure?.message || failure))
          setStatus('error')
        })
        return () => {
          disposed = true
          ac.abort()
          if (fitTimer) clearTimeout(fitTimer)
          if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = 0 }
          queueRef.current = ''
          try { observer?.disconnect() } catch {}
          try { term?.dispose() } catch {}
          termRef.current = null
        }
      }, [id, pushSize, sendInput, t])

      // Closing the tab unmounts the pane -> tear the remote shell down.
      useEffect(() => () => {
        if (!id) return
        try {
          fetch('/dsh-kube/exec-stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
            keepalive: true,
          }).catch(() => {})
        } catch {}
      }, [id])

      const statusText = status === 'running' ? t('shell.running')
        : status === 'closed' ? t('shell.closed')
        : status === 'error' ? t('state.error')
        : t('shell.connecting')
      const title = params.container ? `${params.pod || ''} [${params.container}]` : (params.pod || '')
      return h('div', { className: 'dk-logs' },
        h('div', { className: 'dk-drawer-head dk-logs-head' },
          h('span', { className: 'dk-mono dk-logs-title' }, title),
          h('span', { className: 'dk-badge' + (status === 'running' ? ' ok' : '') }, statusText),
          params.shell ? h('span', { className: 'dk-badge' }, params.shell) : null,
          h('span', { className: 'dk-badge' }, `${size.cols}×${size.rows}`),
        ),
        h('div', { className: 'dk-shell-host', ref: hostRef, onMouseDown: () => termRef.current?.focus() }),
        error ? h('div', { className: 'dk-error', style: { flex: 'none', padding: '4px 10px' } }, error) : null,
        status === 'connecting' ? h('div', { className: 'dk-logs-hint', style: { flex: 'none' } }, t('shell.connecting')) : null,
        h('div', { className: 'dk-drawer-head dk-logs-foot' },
          h('span', { className: 'dk-muted', style: { flex: 1 } },
            params.namespace ? `${params.namespace} · ${params.cluster || ''}` : (params.cluster || '')),
        ),
      )
    }

    // Chip title for a shell tab: terminal glyph + "pod [container]".
    function ShellTabTitle(props) {
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
        h(ShellIcon, { size: 16, className: 'dk-tab-chip-icon' }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          params?.container ? `${params.pod || ''} [${params.container}]` : (params?.pod || '')),
      )
    }

    // --- Role/ClusterRole rules: K9S-style rules list ----------------------
    // Clicking the 规则数 cell opens this dedicated right-sidebar tab. The host
    // returns the role's `rules` array (apiGroups/resources/verbs/resourceNames/
    // nonResourceURLs); each rule renders as a table row, grouped like K9S.
    function RulesPane(props) {
      useStyles()
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      const t = props.t
      const cluster = params.cluster
      const kind = params.kind
      const row = params.row || {}
      const name = row.name
      const namespace = row.namespace || undefined

      const [rules, setRules] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)

      useEffect(() => {
        if (!cluster || !kind || !name) return
        let alive = true
        setLoading(true)
        setError(null)
        setRules(null)
        call('rules', { cluster, kind, name, namespace })
          .then((result) => {
            if (!alive) return
            if (!result || !result.ok) {
              setError(result?.hint ? `${result.error}\n${result.hint}` : (result?.error || t('state.error')))
              return
            }
            setRules(Array.isArray(result.rules) ? result.rules : [])
          })
          .catch((failure) => {
            if (alive) setError(String(failure?.message || failure))
          })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [cluster, kind, name, namespace, t])

      const scope = namespace ? `${kind} · ${namespace}` : kind

      // --- K9S-style verb matrix ----------------------------------------------
      // Each rule is flattened into rows keyed by (apiGroup × resource); the
      // union of verbs across all matching rules drives each cell (✓ granted /
      // ✗ not granted). Column order is fixed per the requested header:
      // NAME | API-GROUP | GET | LIST | WATCH | CREATE | PATCH | UPDATE | DELETE | DEL-LIST.
      const VERB_COLS = ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete', 'deletecollection']
      const verbLabel = (verb) => (verb === 'deletecollection' ? 'DEL-LIST' : String(verb).toUpperCase())
      const buildMatrix = (rules) => {
        const map = new Map()
        for (const rule of rules) {
          const verbs = (rule.verbs || []).map((v) => String(v).toLowerCase())
          const resources = (rule.resources || []).length ? rule.resources : null
          const groups = (rule.apiGroups || []).length ? rule.apiGroups : null
          const urls = (rule.nonResourceURLs || []).length ? rule.nonResourceURLs : null
          let rlist, glist
          if (resources && resources.length) { rlist = resources; glist = groups || ['*'] }
          else if (urls && urls.length) { rlist = urls; glist = ['—'] }
          else { rlist = ['*']; glist = groups || ['*'] }
          for (const g of glist) {
            for (const r of rlist) {
              const key = `${g}\u0000${r}`
              const entry = map.get(key) || { name: r, group: g, verbs: new Set() }
              verbs.forEach((v) => entry.verbs.add(v))
              map.set(key, entry)
            }
          }
        }
        return [...map.values()].sort((a, b) =>
          a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group))
      }
      const matrix = rules === null ? [] : buildMatrix(rules)

      return h('div', { className: 'dk-detail-tab' },
        h('div', { className: 'dk-drawer-head' },
          h('span', { className: 'dk-muted' }, scope),
        ),
        h('div', { className: 'dk-rules-body' },
          loading ? h('div', { className: 'dk-muted', style: { padding: 12 } }, t('rules.loading'))
          : error ? h('div', { className: 'dk-error dk-pre-wrap' }, error)
          : rules === null ? null
          : rules.length === 0 || matrix.length === 0
            ? h('div', { className: 'dk-muted', style: { padding: 12 } }, t('rules.empty'))
            : h('table', { className: 'dk-table dk-rules-table dk-rules-matrix' },
                h('thead', null,
                  h('tr', null,
                    h('th', null, t('rules.name')),
                    h('th', null, t('rules.apigroups')),
                    VERB_COLS.map((verb) => h('th', { key: verb }, verbLabel(verb))),
                  ),
                ),
                h('tbody', null,
                  matrix.map((row, index) =>
                    h('tr', { key: index },
                      h('td', { className: 'dk-mono dk-rules-cell' }, row.name),
                      h('td', { className: 'dk-mono dk-rules-cell dk-muted' }, row.group),
                      VERB_COLS.map((verb) => {
                        const granted = row.verbs.has(verb)
                        return h('td', { key: verb, className: 'dk-matrix-cell' },
                          h('span', { className: granted ? 'dk-matrix-ok' : 'dk-matrix-no' }, granted ? '✓' : '✗'),
                        )
                      }),
                    ),
                  ),
                ),
              ),
        ),
      )
    }

    function RulesTabTitle(props) {
      const useTabInfo = props.useTabInfo
      const info = useTabInfo()
      const params = info?.tab?.navigation?.params || {}
      const name = params?.row?.name
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
        h('span', { className: 'dk-tab-chip-icon' }, '◫'),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name || ''),
      )
    }

    // --- cluster create/update modal ---------------------------------------

    function ClusterModal({ t, initial, onClose, onSaved }) {
      const [name, setName] = useState(initial?.name || '')
      const [yaml, setYaml] = useState(initial?.yaml || '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const editing = Boolean(initial && initial.name)

      const save = useCallback(async () => {
        if (!name.trim() || !yaml.trim()) return
        setBusy(true)
        setError(null)
        try {
          const result = await call('paste', { name: name.trim(), yaml })
          if (!result.ok) { setError(result.error); return }
          onSaved(result)
        } catch (failure) {
          setError(String(failure?.message || failure))
        } finally {
          setBusy(false)
        }
      }, [name, yaml, onSaved])

      return h('div', { className: 'dk-modal-mask', role: 'dialog', 'aria-modal': true },
        h('div', { className: 'dk-modal' },
          h('h3', null, editing ? `${t('cluster.edit')} · ${initial.name}` : t('cluster.add')),
          h('div', { className: 'dk-muted', style: { fontSize: 12 } }, t('cluster.pasteHint')),

          h('label', { className: 'dk-field-label', style: { marginTop: 12 } }, t('cluster.nameLabel')),
          h('input', {
            className: 'dk-input grow', placeholder: t('cluster.namePlaceholder'),
            value: name, spellCheck: false,
            onChange: (event) => setName(event.target.value),
          }),

          h('label', { className: 'dk-field-label', style: { marginTop: 12 } }, t('cluster.yamlLabel')),
          h('textarea', {
            className: 'dk-textarea', value: yaml, spellCheck: false,
            placeholder: 'apiVersion: v1\nkind: Config\nclusters:\ncontexts:\nusers:\n',
            onChange: (event) => setYaml(event.target.value),
          }),

          !editing
            ? h('div', { className: 'dk-muted', style: { fontSize: 11, marginTop: 6 } }, t('cluster.overwriteNotice'))
            : null,
          error ? h('div', { className: 'dk-error', style: { marginTop: 8 } }, error) : null,

          h('div', { className: 'dk-actions' },
            h('button', { className: 'dk-btn ghost', onClick: onClose }, t('btn.cancel')),
            h('button', { className: 'dk-btn primary', onClick: save, disabled: busy || !name.trim() || !yaml.trim() }, t('cluster.save')),
          ),
        ),
      )
    }

    // --- sidebar panel: cluster configuration management -------------------

    function ClustersPanel({ t, onBack }) {
      useStyles()
      const [boot, setBoot] = useState(null)
      const [clusters, setClusters] = useState([])
      const [notice, setNotice] = useState(null)
      const [modal, setModal] = useState(null)

      const loadBoot = useCallback(async () => {
        try {
          const result = await call('state')
          if (result.ok) setBoot(result)
          return result
        } catch (failure) {
          setNotice(String(failure?.message || failure))
          return null
        }
      }, [])

      const loadClusters = useCallback(async () => {
        try {
          const result = await call('clusters')
          if (!result.ok) { setNotice(result.error); return [] }
          setClusters(result.clusters || [])
          return result.clusters || []
        } catch (failure) {
          setNotice(String(failure?.message || failure))
          return []
        }
      }, [])

      useEffect(() => {
        loadBoot().then(() => loadClusters())
      }, [loadBoot, loadClusters])

      const reload = useCallback(async () => {
        await loadBoot()
        await loadClusters()
      }, [loadBoot, loadClusters])

      const remove = useCallback(async (name) => {
        if (!window.confirm(t('cluster.deleteConfirm').replace('{name}', name))) return
        const result = await call('remove', { name })
        if (!result.ok) setNotice(result.error)
        await reload()
      }, [reload, t])

      const openAdd = useCallback(() => setModal({ mode: 'add' }), [])
      const openEdit = useCallback(async (name) => {
        try {
          const result = await call('cluster', { cluster: name })
          if (!result.ok) { setNotice(result.error); return }
          setModal({ mode: 'edit', name: result.name, yaml: result.yaml })
        } catch (failure) {
          setNotice(String(failure?.message || failure))
        }
      }, [])
      const closeModal = useCallback(async () => {
        setModal(null)
        await reload()
      }, [reload])

      const header = h('div', { className: 'dk-head' },
        h('button', { className: 'dk-btn ghost', onClick: onBack, title: t('page.back') }, '←'),
        h('div', null,
          h('h2', { className: 'dk-title' }, t('clusters.title')),
          h('div', { className: 'dk-sub' }, t('panel.subtitle')),
        ),
        h('div', { className: 'dk-spacer' }),
        boot
          ? h('span', { className: 'dk-badge' + (boot.kubectl ? ' plain' : ' err') }, boot.kubectl ? 'kubectl ✓' : t('msg.noKubectl'))
          : null,
        h('button', { className: 'dk-btn primary', onClick: openAdd }, t('cluster.add')),
      )

      let body
      if (clusters.length === 0) {
        body = h('div', { className: 'dk-empty' },
          h('div', { style: { marginBottom: 12 } }, t('cluster.empty')),
          h('button', { className: 'dk-btn primary', onClick: openAdd }, t('cluster.add')),
        )
      } else {
        body = h('div', { className: 'dk-card', style: { padding: 0 } },
          clusters.map((entry) => h('div', { key: entry.name, className: 'dk-row', style: { padding: '12px 14px' } },
            h('div', { className: 'dk-row-main' },
              h('div', { className: 'dk-row-name dk-mono' }, entry.name),
              h('div', { className: 'dk-row-meta' },
                `${authLabel(t, entry.auth)} · ${entry.server || '—'} · ns ${entry.namespace || 'default'}`,
              ),
            ),
            h('button', { className: 'dk-btn ghost', onClick: () => openEdit(entry.name) }, t('cluster.edit')),
            h('button', { className: 'dk-btn ghost danger', onClick: () => remove(entry.name) }, t('btn.remove')),
          )),
        )
      }

      return h('div', { className: 'dk-root' },
        header,
        h('div', { className: 'dk-body' }, body),
        notice ? h('div', { className: 'dk-error', style: { margin: '0 20px 16px' } }, notice) : null,
        modal
          ? h(ClusterModal, {
              t,
              initial: modal.mode === 'edit' ? { name: modal.name, yaml: modal.yaml } : null,
              onClose: () => setModal(null),
              onSaved: closeModal,
            })
          : null,
      )
    }

    // --- conversation tab: resource browser ---------------------------------

    // The conversation view is mounted/unmounted when the user switches tabs, so
    // every return starts from fresh state and re-runs the whole refresh. Remember
    // the last snapshot (cluster, kind, namespace filter, rows) at module level so
    // switching back restores the previous content immediately instead of a blank
    // table while the refresh runs again.
    let lastViewState = null

    // Numeric sort key for a node usage cell such as "1.75/8", "1.4Gi/32Gi" or
    // "12/110": parse the *used* part of the fraction. Unparsable ("—" when the
    // usage read failed) yields -1 so it sorts to the front ascending.
    const nodeMetric = (row, key) => {
      const used = String((row && row[key]) || '').split('/')[0].trim()
      if (!used || used === '—') return -1
      if (key === 'cpu') {
        const n = parseFloat(used)
        if (!Number.isFinite(n)) return -1
        return used.endsWith('m') ? n : n * 1000
      }
      if (key === 'memory') {
        const m = /^([\d.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T)$/.exec(used)
        if (!m) return -1
        const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]]
        const n = parseFloat(m[1])
        return Number.isFinite(n) ? n * mult : -1
      }
      const n = parseInt(used, 10)
      return Number.isNaN(n) ? -1 : n
    }

    function ResourceView({ t, openDetail, openLogs, openShell, openRules }) {
      useStyles()
      const [boot, setBoot] = useState(null)
      const [clusters, setClusters] = useState([])
      const [selected, setSelected] = useState(lastViewState?.selected || '')
      const [namespaces, setNamespaces] = useState(lastViewState?.namespaces || [])
      const [nsSel, setNsSel] = useState(lastViewState?.nsSel || [])
      // The picker only ever offers built-in kinds: drilling into one CRD keeps
      // the picker on CRDs and shows that CRD's instances through crdTarget.
      const [kind, setKind] = useState(
        KINDS.some((entry) => entry.id === lastViewState?.kind)
          ? lastViewState.kind
          : 'namespaces',
      )
      // Set while the table shows instances of a CRD kind opened from the CRD
      // list: {kind, group, plural, scope}. The resource-type picker stays on
      // CRDs; this object alone decides which type the table lists.
      const [crdTarget, setCrdTarget] = useState(lastViewState?.crdTarget || null)
      const [rows, setRows] = useState(lastViewState?.rows || [])
      const [count, setCount] = useState(lastViewState?.count || 0)
      const [listError, setListError] = useState(null)
      const [loading, setLoading] = useState(false)
      const [filter, setFilter] = useState('')
      // When set to an array of pod names, the table shows only those pods
      // (the result of clicking a workload's pod column). Reset to null on any
      // kind/cluster/namespace switch.
      // Active pod-narrowing filter: {kind, name, pods, namespace} set when a
      // workload's pod column is clicked; null = no filter. Carries the source
      // workload so the banner can name <kind> <name>.
      const [podFilter, setPodFilter] = useState(null)
      // Pod list column sort: { key: 'name'|'namespace'|'status'|'age'|'ip'|'node',
      // dir: 1 asc | -1 desc } or null (no sort). Only the pod list is sortable.
      const [podSort, setPodSort] = useState(null)
      // Pod list per-column filters (status / node / ip). Only those three
      // columns are filterable; each holds an array of selected values (empty
      // array = no filter / show all), chosen via a multi-select dropdown.
      const [podColFilter, setPodColFilter] = useState({ status: [], node: [], ip: [] })
      // Node list column sort: { key: 'cpu'|'memory'|'podCount'|'arch'|'type'|'zone'|'age',
      // dir: 1 asc | -1 desc } or null. Node list per-column filters: arch/type/zone,
      // each an array of selected values (empty = show all).
      const [nodeSort, setNodeSort] = useState(null)
      const [nodeColFilter, setNodeColFilter] = useState({ arch: [], type: [], zone: [] })
      // Pod rows expanded to show their containers. Key = "ns/name", value =
      // { loading, containers, initContainers, error }. Containers are fetched
      // lazily on first expand and kept while the row stays expanded.
      const [expanded, setExpanded] = useState({})
      const [login, setLogin] = useState(null)
      // Ports declared by the pods on screen (keyed "namespace/name") and the
      // live kubectl port-forward mappings behind the 端口转发 column.
      const [podPorts, setPodPorts] = useState({})
      const [forwards, setForwards] = useState([])
      const [forwardDialog, setForwardDialog] = useState(null)
      const [shellNotice, setShellNotice] = useState(null)
      const [authNeeded, setAuthNeeded] = useState(false)
      const [clusterInfo, setClusterInfo] = useState(null)
      // The login/health badge used to read `clusters[i].state`, a snapshot taken by
      // the last `clusters` fetch — so after switching clusters the badge kept the
      // previous cluster's verdict until a manual refresh reloaded that snapshot.
      // This holds the newest *live* observation for the selected cluster (probe or
      // list result) and takes precedence over the snapshot.
      const [liveState, setLiveState] = useState(lastViewState?.liveState || null)
      const [autoRefresh, setAutoRefresh] = useState(false)
      const [refreshInterval, setRefreshInterval] = useState(30)
      const [notice, setNotice] = useState(null)
      // Opened workload action, e.g. { row, action: 'restart' }; null when closed.
      const [ops, setOps] = useState(null)
      const seq = useRef(0)
      const viewRef = useRef(null)
      // True while this view is on screen. Auto-refresh must not poll a view the
      // user cannot see (another session, another tab): that is what kept hitting
      // a cluster the user had long navigated away from.
      const visibleRef = useRef(true)
      // Last probed cluster state, so an auto tick can skip a dead cluster.
      const probeStateRef = useRef('')
      // True while a refresh pass is in flight (auto ticks must not stack).
      const busyRef = useRef(false)
      // Retry bookkeeping for a request cut short by a service restart: retry
      // quietly instead of painting a red banner over still-valid old rows.
      const retryTick = useRef(0)
      const [reloadTick, setReloadTick] = useState(0)

      const loadBoot = useCallback(async () => {
        try {
          const result = await call('state')
          if (result.ok) setBoot(result)
          return result
        } catch (failure) {
          setNotice(String(failure?.message || failure))
          return null
        }
      }, [])

      const loadClusters = useCallback(async () => {
        try {
          const result = await call('clusters')
          if (!result.ok) { setListError(result); setClusters([]); return [] }
          const list = result.clusters || []
          setClusters(list)
          setSelected((current) => {
            if (current && list.some((entry) => entry.name === current)) return current
            const active = list.find((entry) => entry.current) || list.find((entry) => entry.state?.state === 'ok')
            return (active || list[0])?.name || ''
          })
          return list
        } catch (failure) {
          setListError({ error: String(failure?.message || failure) })
          return []
        }
      }, [])

      const loadNamespaces = useCallback(async (clusterName) => {
        if (!clusterName) { setNamespaces([]); return }
        try {
          const result = await call('namespaces', { cluster: clusterName })
          setNamespaces(result.ok ? result.namespaces || [] : [])
        } catch {
          setNamespaces([])
        }
      }, [])

      // The type the table actually lists: normally the picked built-in kind,
      // but a drilled-in CRD overrides it while the picker stays on CRDs.
      const listKind = crdTarget ? `${crdTarget.plural}.${crdTarget.group}` : kind

      const loadList = useCallback(async (clusterName, kindId, nsSelection) => {
        if (!clusterName) return
        const ticket = ++seq.current
        const sel = nsSelection || []
        const allNamespaces = sel.length === 0
        setLoading(true)
        setListError(null)
        try {
          const result = await call('list', {
            cluster: clusterName,
            kind: kindId,
            namespace: allNamespaces ? undefined : sel[0],
            allNamespaces,
          })
          if (ticket !== seq.current) return
          if (result.ok) retryTick.current = 0
          if (result.ok) setLiveState({ state: 'ok', message: '' })
          if (!result.ok) {
            // The web service is restarting (or our kubectl was killed with it):
            // this is transient, so reload a moment later and show nothing.
            if (result.kind === 'restarting' || result.retry === true) {
              setListError(null)
              if (retryTick.current < 6) {
                retryTick.current += 1
                setTimeout(() => setReloadTick((n) => n + 1), 1500)
              }
              return
            }
            // Keep whatever is already on screen instead of blanking it: a failed
            // refresh (cluster hiccup, kubectl killed by timeout) must not wipe the
            // previous content the user was looking at.
            setLiveState({ state: result.kind || 'error', message: result.error || '' })
            setListError(result)
            return
          }
          let items = result.rows || []
          if (!allNamespaces) {
            // Multi-select: fetch all namespaces on the backend, then filter to the
            // selected set client-side (kubectl accepts a single -n).
            const set = new Set(sel)
            items = items.filter((row) => set.has(row.namespace))
          }
          setRows(items)
          setCount(items.length)
        } catch (failure) {
          if (ticket !== seq.current) return
          // A dropped connection while the service restarts is not a cluster error.
          const message = String(failure?.message || failure)
          if (/fetch|network|load failed|HTTP 5\d\d/i.test(message) && retryTick.current < 6) {
            retryTick.current += 1
            setTimeout(() => setReloadTick((n) => n + 1), 1500)
            return
          }
          setLiveState({ state: 'unreachable', message })
          setListError({ error: message })
        } finally {
          if (ticket === seq.current) setLoading(false)
        }
      }, [])

      // Probe whether the selected cluster needs a sign-in before reading resources.
      // A ticket guards against a slow probe (e.g. an OIDC cluster whose exec hangs
      // trying to open a browser and only resolves after the timeout) resolving after
      // the user has switched to a different cluster and wrongly toggling the button.
      const probeSeq = useRef(0)
      const probeSelected = useCallback(async (value) => {
        const ticket = ++probeSeq.current
        if (!value) { setAuthNeeded(false); setClusterInfo(null); return false }
        try {
          const result = await call('probe', { cluster: value })
          if (ticket !== probeSeq.current) return false
          const state = result?.state?.state || ''
          probeStateRef.current = state
          setLiveState(result?.state && result.state.state ? { state: result.state.state, message: result.state.message || '' } : null)
          setClusterInfo({ user: result?.user || '', version: result?.version || '' })
          // Show the login button whenever the cluster is loginable but is not in
          // a healthy state (needs-login / timeout). A healthy cluster reports ok
          // and shows no button.
          const need = Boolean(result?.loginable && state !== 'ok')
          setAuthNeeded(need)
          return need
        } catch {
          if (ticket !== probeSeq.current) return false
          setAuthNeeded(false)
          setClusterInfo(null)
          setLiveState(null)
          return false
        }
      }, [])

      const refreshAll = useCallback(async (forceList, autoTick) => {
        // A refresh against a dead cluster can take 30-60s; an interval tick that
        // fires meanwhile would stack another one on top of it. Let the running
        // pass finish and skip this tick.
        if (autoTick && busyRef.current) return null
        busyRef.current = true
        try {
          const state = await loadBoot()
          const list = await loadClusters()
          const current = selected && list.some((entry) => entry.name === selected) ? selected : list[0]?.name
          if (current) {
            const need = await probeSelected(current)
            if (!need) {
              // An unattended tick against a cluster that just timed out or is
              // unreachable would only spawn another doomed kubectl run; wait for
              // the user (or the next manual refresh) instead.
              const dead = probeStateRef.current === 'timeout' || probeStateRef.current === 'unreachable'
              if (autoTick && dead) return state
              await loadNamespaces(current)
              // A restored view can carry a namespace selection from a namespaced
              // kind while the current kind is cluster-scoped (CRDs, nodes…).
              // Sending it would filter every cluster-scoped row away.
              const scope = isKindScoped(kind) && !crdTarget ? [] : nsSel
              if (forceList || current) await loadList(current, listKind, scope)
            }
          }
          return state
        } finally {
          busyRef.current = false
        }
      }, [loadBoot, loadClusters, loadNamespaces, loadList, probeSelected, selected, listKind, kind, nsSel, crdTarget])

      useEffect(() => {
        refreshAll(true)
      }, []) // eslint-disable-line react-hooks/exhaustive-deps

      // A request that failed because the service was restarting schedules one of
      // these ticks; it re-runs the normal refresh (list included) once.
      useEffect(() => {
        if (!reloadTick) return
        refreshAll(false)
      }, [reloadTick]) // eslint-disable-line react-hooks/exhaustive-deps

      // A successful apply in a detail tab reloads this list (rows show labels,
      // generations, statuses that the edit may have changed).
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const onApplied = (event) => {
          const detail = (event && event.detail) || {}
          if (detail.cluster && detail.cluster !== selected) return
          refreshAll(false)
        }
        window.addEventListener(APPLIED_EVENT, onApplied)
        return () => window.removeEventListener(APPLIED_EVENT, onApplied)
      }, [refreshAll, selected])

      // Clicking a 规则数 cell (a static td, outside this component's render
      // context) dispatches an event; open the dedicated rules tab for the row.
      useEffect(() => {
        if (typeof window === 'undefined' || typeof openRules !== 'function') return undefined
        const onOpenRules = (event) => {
          const detail = (event && event.detail) || {}
          const row = detail.row
          if (!row || !row.name) return
          openRules(selected, listKind, row)
        }
        window.addEventListener(OPEN_RULES_EVENT, onOpenRules)
        return () => window.removeEventListener(OPEN_RULES_EVENT, onOpenRules)
      }, [selected, listKind, openRules])

      // Remember the current snapshot so the next mount (switching back to this
      // tab) restores the previous cluster/kind/filter/content immediately.
      useEffect(() => {
        lastViewState = { selected, kind, nsSel, rows, count, namespaces, clusterInfo, crdTarget, liveState }
      }, [selected, kind, nsSel, rows, count, namespaces, clusterInfo, crdTarget, liveState])

      // Auto-refresh: poll the active resource list while the toggle is on and the
      // cluster is reachable (skip when it needs a sign-in). A hidden page or a view
      // that is off screen is skipped entirely — background views must not keep
      // querying whatever cluster they still remember.
      useEffect(() => {
        if (!autoRefresh || authNeeded) return
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          if (!visibleRef.current) return
          refreshAll(true, true)
        }, refreshInterval * 1000)
        return () => clearInterval(timer)
      }, [autoRefresh, authNeeded, refreshInterval, refreshAll])

      // Refresh once when the Kubernetes tab becomes visible again after being off
      // screen. `prev` starts true so the mount-time intersection is skipped as well.
      useEffect(() => {
        const el = viewRef.current
        if (!el || typeof IntersectionObserver === 'undefined') return
        let prev = true
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const visible = entry.isIntersecting
            visibleRef.current = visible
            if (visible && !prev) refreshAll(true)
            prev = visible
          }
        })
        io.observe(el)
        return () => io.disconnect()
      }, [refreshAll])

      const switchTo = useCallback(async (value) => {
        if (!value) return
        setSelected(value)
        setAuthNeeded(false)
        setLiveState(null)
        setRows([])
        setNsSel([])
        setCrdTarget(null)
        setFilter('')
        setPodFilter(null)
        setPodSort(null)
        setPodColFilter({ status: [], node: [], ip: [] })
        setNodeSort(null)
        setNodeColFilter({ arch: [], type: [], zone: [] })
        setExpanded({})
        try { await call('switch', { cluster: value }) } catch {}
        const need = await probeSelected(value)
        if (!need) {
          await loadNamespaces(value)
          await loadList(value, kind, [])
          // The list just proved this cluster reachable, which is exactly when the
          // version/user badges can be filled in: probe again now instead of leaving
          // them blank until the next auto-refresh tick. kubeconfig view and
          // `kubectl version` are both cached, so this is a cheap call.
          await probeSelected(value)
        }
      }, [kind, loadNamespaces, loadList, probeSelected])

      const changeNamespace = useCallback((value) => {
        setNsSel(value)
        setRows([])
        setPodFilter(null)
        setPodSort(null)
        setPodColFilter({ status: [], node: [], ip: [] })
        setNodeSort(null)
        setNodeColFilter({ arch: [], type: [], zone: [] })
        setExpanded({})
        loadList(selected, listKind, value)
      }, [selected, listKind, loadList])

      const changeKind = useCallback((value) => {
        setKind(value)
        setCrdTarget(null)
        setRows([])
        setPodFilter(null)
        setPodSort(null)
        setPodColFilter({ status: [], node: [], ip: [] })
        setNodeSort(null)
        setNodeColFilter({ arch: [], type: [], zone: [] })
        setExpanded({})
        const scope = isKindScoped(value) ? [] : nsSel
        if (scope.length !== nsSel.length) setNsSel(scope)
        loadList(selected, value, scope)
      }, [selected, nsSel, loadList])

      // CRD list → that CRD's instances. The resource-type picker stays on CRDs:
      // crdTarget alone drives what the table lists, so the CRD type never has to
      // masquerade as a built-in resource type.
      const drillIntoCr = useCallback((row) => {
        const target = { kind: row.crdKind, group: row.crdGroup, plural: row.plural, scope: row.crdScope }
        const value = `${row.plural}.${row.crdGroup}`
        setCrdTarget(target)
        // The search box filters by name; a CRD name fragment typed while picking
        // the CRD ("cert", "argo"…) would hide every instance of the new type.
        setFilter('')
        setRows([])
        setPodFilter(null)
        setPodSort(null)
        setPodColFilter({ status: [], node: [], ip: [] })
        setNodeSort(null)
        setNodeColFilter({ arch: [], type: [], zone: [] })
        setExpanded({})
        // Open on all namespaces: the CRD list is cluster-scoped, so any
        // namespace selection still around belongs to an earlier kind.
        if (nsSel.length) setNsSel([])
        loadList(selected, value, [])
      }, [selected, nsSel, loadList])

      const openPods = useCallback(async (row) => {
        // Ask the backend for the pods owned by this workload, then switch the
        // list to pods and narrow it to exactly those pod names.
        try {
          const result = await call('pods-of', {
            cluster: selected,
            kind,
            name: row.name,
            namespace: row.namespace,
          })
          if (result && result.ok) {
            setCrdTarget(null)
            setKind('pods')
            setRows([])
            setPodFilter({
              kind: String(kind).split('.')[0],
              name: row.name,
              pods: result.pods || [],
              namespace: result.namespace || row.namespace || 'default',
            })
            setPodSort(null)
            setPodColFilter({ status: [], node: [], ip: [] })
            setNodeSort(null)
            setNodeColFilter({ arch: [], type: [], zone: [] })
            setExpanded({})
            const scope = [result.namespace || row.namespace || 'default']
            if (scope[0] !== nsSel[0]) setNsSel(scope)
            loadList(selected, 'pods', scope)
          } else {
            setListError(result || { kind: 'error', error: '获取关联 Pod 失败' })
          }
        } catch {
          setListError({ kind: 'error', error: '获取关联 Pod 失败' })
        }
      }, [selected, kind, nsSel, loadList])

      // Node row → its Pods column: switch to the pod list and narrow it to the
      // pods scheduled on that node. The node column filter does the narrowing
      // precisely (pod names are not unique across namespaces, so a name list
      // would over-match), and pods list always spans all namespaces.
      const openNodePods = useCallback((nodeName) => {
        setCrdTarget(null)
        setKind('pods')
        setRows([])
        setPodFilter(null)
        setPodSort(null)
        setPodColFilter({ status: [], node: nodeName ? [String(nodeName)] : [], ip: [] })
        setNodeSort(null)
        setNodeColFilter({ arch: [], type: [], zone: [] })
        setExpanded({})
        if (nsSel.length) setNsSel([])
        loadList(selected, 'pods', [])
      }, [selected, nsSel, loadList])

      const afterLogin = useCallback(async () => {
        setLogin(null)
        await probeSelected(selected)
        await loadNamespaces(selected)
        await loadList(selected, listKind, isKindScoped(kind) && !crdTarget ? [] : nsSel)
        setPodFilter(null)
        setExpanded({})
      }, [loadNamespaces, loadList, probeSelected, selected, listKind, kind, nsSel])

      const rowKey = (row) => `${row.namespace || ''}/${row.name}`

      // Lazily fetch a pod's containers on first expand, then cache them for as
      // long as the row stays expanded. Collapsing removes the entry; a fetch
      // that resolves after a collapse is dropped so it never resurrects a row
      // the user has closed.
      const toggleExpand = useCallback(async (row) => {
        const key = rowKey(row)
        const opening = !expanded[key]
        setExpanded((current) => {
          if (opening) return { ...current, [key]: { loading: true } }
          const next = { ...current }
          delete next[key]
          return next
        })
        if (!opening) return
        try {
          const result = await call('containers', { cluster: selected, pod: row.name, namespace: row.namespace })
          setExpanded((current) => {
            const entry = current[key]
            if (!entry) return current
            return {
              ...current,
              [key]: {
                ...entry,
                loading: false,
                containers: result.ok ? result.containers || [] : [],
                initContainers: result.ok ? result.initContainers || [] : [],
                error: result.ok ? null : (result.error || String(result.message || '加载容器失败')),
              },
            }
          })
        } catch (failure) {
          setExpanded((current) => {
            if (!current[key]) return current
            return { ...current, [key]: { ...current[key], loading: false, error: String(failure?.message || failure) } }
          })
        }
      }, [selected, expanded])

      const filtered = useMemo(() => {
        const needle = filter.trim().toLowerCase()
        const podList = String(kind).split('.')[0] === 'pods'
        let out = rows
        if (needle) out = out.filter((row) => String(row.name || '').toLowerCase().includes(needle))
        if (podFilter) {
          const set = new Set(podFilter.pods)
          out = out.filter((row) => set.has(row.name))
        }
        // Pod list only: per-column filters (status / node / ip) then sorting.
        // The columns are name, namespace, status, age, ip, node; age compares by
        // creationTimestamp so "2d" sorts before "5m", the other five by text.
        if (podList) {
          const colF = podColFilter || {}
          if (colF.status && colF.status.length) out = out.filter((row) => colF.status.includes(String(row.status || '')))
          if (colF.node && colF.node.length) out = out.filter((row) => colF.node.includes(String(row.node || '')))
          if (colF.ip && colF.ip.length) out = out.filter((row) => colF.ip.includes(String(row.ip || '')))
          if (podSort) {
            const { key, dir } = podSort
            out = out.slice().sort((a, b) => {
              if (key === 'age') {
                const ta = a.created ? new Date(a.created).getTime() : 0
                const tb = b.created ? new Date(b.created).getTime() : 0
                return (ta - tb) * dir
              }
              const va = String(a[key] ?? '').toLowerCase()
              const vb = String(b[key] ?? '').toLowerCase()
              return va.localeCompare(vb) * dir
            })
          }
        }
        // Node list only: per-column filters (arch / type / zone) then sorting by
        // the usage fraction's numerator, creationTimestamp for age, text otherwise.
        if (String(kind).split('.')[0] === 'nodes') {
          const colF = nodeColFilter || {}
          for (const key of ['arch', 'type', 'zone']) {
            const picked = colF[key]
            if (picked && picked.length) out = out.filter((row) => picked.includes(String(row[key] || '')))
          }
          if (nodeSort) {
            const { key, dir } = nodeSort
            out = out.slice().sort((a, b) => {
              if (key === 'age') {
                const ta = a.created ? new Date(a.created).getTime() : 0
                const tb = b.created ? new Date(b.created).getTime() : 0
                return (ta - tb) * dir
              }
              if (key === 'cpu' || key === 'memory' || key === 'podCount') {
                return (nodeMetric(a, key) - nodeMetric(b, key)) * dir
              }
              return String(a[key] ?? '').toLowerCase().localeCompare(String(b[key] ?? '').toLowerCase()) * dir
            })
          }
        }
        return out
      }, [rows, filter, podFilter, kind, podColFilter, podSort, nodeColFilter, nodeSort])

      // A drilled-in CRD kind is tracked explicitly: it is not in KINDS, so its
      // namespace scope comes from the CRD row it was opened from.
      const activeCrd = crdTarget && kind === 'customresourcedefinitions' ? crdTarget : null
      const kindIsScoped = activeCrd ? activeCrd.scope === 'Cluster' : isKindScoped(kind)
      const showNamespaceColumn = kindIsScoped ? false : (nsSel.length === 0 || nsSel.length > 1)
      // kubectl logs accepts pod, deployment/<name>, statefulset/<name> and
      // daemonset/<name> selectors, so the 日志 column applies to pods,
      // deployments, statefulsets and daemonsets alike.
      const loggableBase = String(kind).split('.')[0]
      const showLogsColumn = loggableBase === 'pods' || loggableBase === 'deployments'
        || loggableBase === 'statefulsets' || loggableBase === 'daemonsets'
      // Workloads (deployment/statefulset/daemonset/job) expose a pod column
      // that, when clicked, narrows the list to the pods they own.
      const showPodsColumn = loggableBase === 'deployments'
        || loggableBase === 'statefulsets' || loggableBase === 'daemonsets' || loggableBase === 'jobs'
      // The "其他" column only carries meaningful per-kind extras; pods,
      // workloads, services, config maps, secrets, storage and ingress show
      // nothing useful in it, so it is dropped for those kinds.
      const showExtraColumn = ![
        'pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services',
        'namespaces', 'secrets', 'configmaps', 'persistentvolumeclaims', 'nodes', 'ingresses',
      ].includes(loggableBase)
      // 就绪 column is not meaningful for namespaces, secrets/configmaps or
      // ingresses (they carry no replica/ready semantics).
      const showReadyColumn = ![
        'namespaces', 'secrets', 'configmaps', 'ingresses', 'serviceaccounts',
        'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings', 'rbacusers', 'rbacgroups',
      ].includes(loggableBase)
      // 状态 column is not shown for ingresses (its table exposes class/hosts).
      const showStatusColumn = loggableBase !== 'ingresses'
      // Every real resource gets an 操作 column (at least 删除); only the RBAC
      // user/group pseudo-rows offer no actions.
      const showOpsColumn = opsFor(loggableBase).length > 0
      // Ingress rows expose IngressClass and host(s).
      const showClassColumn = loggableBase === 'ingresses'
      const showHostColumn = loggableBase === 'ingresses'
      // Pod rows get a +/- expander that reveals their containers underneath.
      const showExpand = loggableBase === 'pods'
      // The pod list keeps the generic ready/status/age/logs columns, drops the
      // "其他" column and adds Pod IP + node.
      const isPods = loggableBase === 'pods'

      // Fetch the declared ports of the pods in scope. The backend answers with
      // one compact jsonpath line per pod, so this stays cheap next to the list.
      useEffect(() => {
        if (!isPods || !selected) { setPodPorts({}); return }
        let alive = true
        call('pod-ports', {
          cluster: selected,
          allNamespaces: nsSel.length === 0,
          namespace: nsSel[0],
        }).then((result) => {
          if (alive && result && result.ok) setPodPorts(result.ports || {})
        }).catch(() => {})
        return () => { alive = false }
      }, [isPods, selected, kind, nsSel, rows])

      const loadForwards = useCallback(async () => {
        try {
          const result = await call('forwards')
          if (result && result.ok) setForwards(result.forwards || [])
        } catch { /* keep the last known mappings */ }
      }, [])

      useEffect(() => {
        if (!isPods) return
        loadForwards()
      }, [isPods, loadForwards, rows, selected])

      // A forward also dies on its own (pod gone, kubectl exit). While one is
      // live, poll so the column stops claiming a forwarding that no longer runs.
      useEffect(() => {
        if (!isPods || forwards.length === 0) return
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          loadForwards()
        }, 5000)
        return () => clearInterval(timer)
      }, [isPods, forwards.length, loadForwards])

      // 端口转发 cell stays one narrow chip: the number of declared ports, or
      // how many of them are forwarded. The per-port 转发/关闭 actions live in the
      // dialog the chip opens, so a pod with many ports cannot stretch the table.
      const portsOf = (row) => podPorts[`${row.namespace || 'default'}/${row.name}`] || []

      const portCell = (row) => {
        const list = portsOf(row)
        if (list.length === 0) return h('span', { className: 'dk-muted' }, '—')
        const live = forwards.filter((entry) => entry.cluster === selected
          && entry.namespace === (row.namespace || 'default')
          && entry.pod === row.name).length
        return h('button', {
          className: `dk-pf-sum${live > 0 ? ' on' : ''}`,
          title: list.map((entry) => `${entry.port}${entry.name ? `(${entry.name})` : ''}`).join('  '),
          onClick: (event) => {
            event.stopPropagation()
            setForwardDialog({ mode: 'list', row })
          },
        }, live > 0
          ? t('pf.cell.live').replace('{n}', String(live))
          : t('pf.cell.count').replace('{n}', String(list.length)))
      }

      // ── Column layout ─────────────────────────────────────────────
      // Pods keep their own bespoke layout (expander, ready, status, age, IP,
      // node, port-forward, logs). Every other kind is rendered from a per-kind
      // ordered column spec so header, body and column count always agree. Each
      // spec lists names resolved through `TH` (header) and `td` (cell) below.
      const kindCols = {
        deployments:  ['name', 'ns', 'readyBadge', 'age', 'logs', 'pods', 'ops'],
        statefulsets: ['name', 'ns', 'readyBadge', 'age', 'logs', 'pods', 'ops'],
        daemonsets:   ['name', 'ns', 'readyBadge', 'age', 'logs', 'pods', 'ops'],
        jobs:         ['name', 'ns', 'readyBadge', 'jobStatus', 'age', 'pods', 'ops'],
        cronjobs:     ['name', 'ns', 'schedule', 'suspended', 'age', 'ops'],
        services:     ['name', 'ns', 'type', 'clusterIP', 'externalIP', 'ports', 'age', 'ops'],
        configmaps:   ['name', 'ns', 'data', 'age', 'ops'],
        secrets:      ['name', 'ns', 'data', 'age', 'ops'],
        persistentvolumeclaims: ['name', 'ns', 'capacity', 'status', 'accessMode', 'storageClass', 'volume', 'age', 'ops'],
        namespaces:   ['name', 'status', 'age', 'ops'],
        nodes:        ['name', 'nodeStatus', 'version', 'cpu', 'memory', 'podCount', 'arch', 'type', 'zone', 'age', 'ops'],
        ingresses:    ['name', 'ns', 'age', 'class', 'host', 'ops'],
        events:       ['name', 'ns', 'reason', 'count', 'lastSeen', 'message', 'object', 'ops'],
        serviceaccounts: ['name', 'ns', 'saSecrets', 'age', 'ops'],
        roles:        ['name', 'ns', 'ruleCount', 'age', 'ops'],
        rolebindings: ['name', 'ns', 'roleRef', 'subjects', 'age', 'ops'],
        clusterroles: ['name', 'ruleCount', 'age', 'ops'],
        clusterrolebindings: ['name', 'roleRef', 'subjects', 'age', 'ops'],
        // User/Group are aggregated from binding subjects; they carry no
        // creation timestamp, so the age column is omitted, and they have no
        // real object to delete, so no 操作 column either.
        rbacusers:    ['name', 'bindingCount', 'roleList', 'scopes'],
        rbacgroups:   ['name', 'bindingCount', 'roleList', 'scopes'],
        customresourcedefinitions: ['name', 'crdKind', 'crdGroup', 'crdScope', 'crdVersion', 'age', 'ops'],
        horizontalpodautoscalers: ['name', 'ns', 'hpaRef', 'hpaTargets', 'hpaRange', 'age', 'ops'],
        verticalpodautoscalers: ['name', 'ns', 'vpaMode', 'vpaCpu', 'vpaMem', 'vpaProvided', 'age', 'ops'],
      }
      // Ready x/y → badge: x==y && x>0 green, x==y==0 yellow, x<y red.
      const readyBadgeCell = (xy) => {
        const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(xy || '').trim())
        if (!m) return h('td', null, xy || '')
        const x = parseInt(m[1], 10)
        const y = parseInt(m[2], 10)
        const tone = (x === y && x > 0) ? 'ok' : (x === 0 && y === 0) ? 'warn' : 'err'
        return h('td', null, h('span', { className: 'dk-badge pod ' + tone }, xy))
      }
      // Job status → badge: Complete green, Suspended yellow, Running green
      // text without background, anything else red.
      const jobStatusBadgeCell = (status) => {
        const s = String(status || '')
        const low = s.toLowerCase()
        const tone = (low === 'complete' || low === 'completed') ? 'ok'
          : (low === 'suspended') ? 'warn'
          : (low === 'running') ? 'running-text'
          : 'err'
        return h('td', null, h('span', { className: 'dk-badge pod ' + tone }, s))
      }
      const td = {
        name: (row) => h('td', { className: 'dk-mono' }, row.name),
        ns: (row) => h('td', { className: 'dk-muted' }, row.namespace || '—'),
        age: (row) => h('td', { className: 'dk-muted' }, row.age || ''),
        plain: (row, key) => h('td', null, row[key] || ''),
        muted: (row, key) => h('td', { className: 'dk-muted' }, row[key] || '—'),
        mono: (row, key) => h('td', { className: 'dk-mono' }, row[key] || '—'),
        readyBadge: (row) => readyBadgeCell(row.ready),
        jobStatus: (row) => jobStatusBadgeCell(row.status),
        schedule: (row) => h('td', null, row.ready || ''),
        suspended: (row) => h('td', null, row.suspended ? 'true' : 'false'),
        type: (row) => h('td', null, row.status || ''),
        clusterIP: (row) => td.mono(row, 'ready'),
        externalIP: (row) => td.mono(row, 'externalIP'),
        ports: (row) => td.muted(row, 'ports'),
        data: (row) => h('td', null, row.status || ''),
        capacity: (row) => td.mono(row, 'ready'),
        accessMode: (row) => td.muted(row, 'accessMode'),
        storageClass: (row) => td.mono(row, 'storageClass'),
        volume: (row) => td.mono(row, 'volume'),
        status: (row) => h('td', null, row.status || ''),
        ready: (row) => h('td', null, row.ready || ''),
        // Node: status badge (Ready green, anything else red), version, pod count, spec, arch.
        nodeStatus: (row) => {
          // Multiple comma-separated states → one badge each: Ready is green,
          // SchedulingDisabled is yellow (#ffd60a), anything else is red.
          const parts = String(row.status || '').split(',').map((s) => s.trim()).filter(Boolean)
          if (!parts.length) return h('td', null, '—')
          return h('td', null, parts.map((s, i) => {
            const tone = s === 'Ready' ? 'ok' : s === 'SchedulingDisabled' ? 'sched' : 'err'
            return h('span', { className: 'dk-badge pod ' + tone, style: i > 0 ? { marginLeft: 4 } : {} }, s)
          }))
        },
        version: (row) => td.mono(row, 'ready'),
        cpu: (row) => td.mono(row, 'cpu'),
        memory: (row) => td.mono(row, 'memory'),
        type: (row) => td.plain(row, 'type'),
        zone: (row) => td.plain(row, 'zone'),
        podCount: (row) => h('td', null,
          row.podCount
            ? h('button', {
                className: 'dk-count-link', title: t('node.podsTitle'),
                onClick: (event) => { event.stopPropagation(); openNodePods(row.name) },
              }, String(row.podCount))
            : '—'),
        spec: (row) => td.mono(row, 'spec'),
        arch: (row) => td.mono(row, 'arch'),
        class: (row) => td.mono(row, 'class'),
        host: (row) => td.mono(row, 'host'),
        reason: (row) => h('td', null, row.status || ''),
        count: (row) => h('td', null, String(row.ready ?? '')),
        lastSeen: (row) => td.muted(row, 'age'),
        message: (row) => td.muted(row, 'message'),
        object: (row) => td.muted(row, 'object'),
        extra: (row) => h('td', { className: 'dk-muted' }, extraOf(row)),
        crdKind: (row) => h('td', null,
          h('button', {
            className: 'dk-btn ghost dk-link-btn',
            style: { marginTop: 0, padding: 0 },
            title: t('btn.viewInstances'),
            onClick: (event) => { event.stopPropagation(); drillIntoCr(row) },
          }, row.crdKind || '—')),
        crdGroup: (row) => td.mono(row, 'crdGroup'),
        crdScope: (row) => td.muted(row, 'crdScope'),
        crdVersion: (row) => td.mono(row, 'version'),
        saSecrets: (row) => h('td', null, String(row.secrets ?? 0)),
        ruleCount: (row) => h('td', null,
          h('button', {
            className: 'dk-rules-link',
            title: t('rules.open'),
            'aria-label': t('rules.open'),
            onClick: (event) => { event.stopPropagation(); emitOpenRules({ row }) },
          }, String(row.rules ?? 0)),
        ),
        roleRef: (row) => td.mono(row, 'status'),
        subjects: (row) => h('td', { className: 'dk-muted', title: row.subjects || '' }, row.subjects || '—'),
        bindingCount: (row) => h('td', null, String(row.bindingCount ?? 0)),
        roleList: (row) => h('td', { className: 'dk-muted', title: row.roleList || '' }, row.roleList || '—'),
        scopes: (row) => h('td', { className: 'dk-mono', title: row.scopes || '' }, row.scopes || '—'),
        hpaRef: (row) => h('td', { className: 'dk-mono', title: row.status || '' }, row.status || '—'),
        hpaTargets: (row) => h('td', { className: 'dk-mono', title: row.ready || '' }, row.ready || '—'),
        hpaRange: (row) => h('td', {
          className: 'dk-muted',
          title: `${t('col.hpamin')}: ${row.hpaMin || '—'} · ${t('col.hpamax')}: ${row.hpaMax || '—'} · ${t('col.hpareplicas')}: ${row.replicas || '—'}`,
        }, `${row.hpaMin || '—'} → ${row.hpaMax || '—'} · ${row.replicas || '—'}`),
        vpaMode: (row) => h('td', { className: 'dk-mono' }, row.status || '—'),
        vpaCpu: (row) => h('td', { className: 'dk-mono' }, row.cpu || '—'),
        vpaMem: (row) => h('td', { className: 'dk-mono' }, row.memory || '—'),
        vpaProvided: (row) => h('td', null,
          h('span', { className: `dk-badge ${String(row.ready).toLowerCase() === 'true' ? 'ok' : 'warn'}` }, row.ready || '—')),
        logs: (row) => h('td', null,
          h('button', {
            className: 'dk-icon-btn', title: t('col.logs'), 'aria-label': t('col.logs'),
            onClick: (event) => { event.stopPropagation(); openLogs(selected, kind, row) },
          }, h(LogsIcon, { size: 15 }))),
        pods: (row) => h('td', null,
          h('button', {
            className: 'dk-icon-btn', title: t('col.pods'), 'aria-label': t('col.pods'),
            onClick: (event) => { event.stopPropagation(); openPods(row) },
          }, h(PodsIcon, { size: 15 }))),
        ops: (row) => h('td', null,
          h(OpsMenu, {
            t,
            kind,
            // Every action opens the same panel: it states what the action does,
            // asks for a replica count when scaling and a target revision when
            // rolling back, then reports the result.
            onPick: (action) => setOps({ row, action }),
          })),
      }
      const TH = {
        name: () => h('th', null, t('col.name')),
        ns: () => (showNamespaceColumn ? h('th', null, t('col.namespace')) : null),
        age: () => h('th', null, t('col.age')),
        ready: () => (showReadyColumn ? h('th', null, t('col.ready')) : null),
        readyBadge: () => h('th', null, t('col.ready')),
        jobStatus: () => h('th', null, t('col.status')),
        schedule: () => h('th', null, t('col.schedule')),
        suspended: () => h('th', null, t('col.suspended')),
        type: () => h('th', null, t('col.type')),
        clusterIP: () => h('th', null, t('col.clusterip')),
        externalIP: () => h('th', null, t('col.externalip')),
        ports: () => h('th', null, t('col.ports')),
        data: () => h('th', null, t('col.data')),
        capacity: () => h('th', null, t('col.capacity')),
        accessMode: () => h('th', null, t('col.accessmode')),
        storageClass: () => h('th', null, t('col.storageclass')),
        volume: () => h('th', null, t('col.volume')),
        status: () => (showStatusColumn ? h('th', null, t('col.status')) : null),
        nodeStatus: () => h('th', null, t('col.status')),
        version: () => h('th', null, t('col.version')),
        cpu: () => h('th', null, t('col.cpu')),
        memory: () => h('th', null, t('col.memory')),
        type: () => h('th', null, t('col.type')),
        zone: () => h('th', null, t('col.zone')),
        podCount: () => h('th', null, t('col.podcount')),
        spec: () => h('th', null, t('col.spec')),
        arch: () => h('th', null, t('col.arch')),
        class: () => (showClassColumn ? h('th', null, t('col.class')) : null),
        host: () => (showHostColumn ? h('th', null, t('col.host')) : null),
        reason: () => h('th', null, t('col.reason')),
        count: () => h('th', null, t('col.count')),
        lastSeen: () => h('th', null, t('col.lastseen')),
        message: () => h('th', null, t('col.message')),
        object: () => h('th', null, t('col.object')),
        crdKind: () => h('th', null, t('col.crdkind')),
        crdGroup: () => h('th', null, t('col.crdgroup')),
        crdScope: () => h('th', null, t('col.crdscope')),
        crdVersion: () => h('th', null, t('col.crdversion')),
        saSecrets: () => h('th', null, t('col.sasecrets')),
        ruleCount: () => h('th', null, t('col.rules')),
        roleRef: () => h('th', null, t('col.roleref')),
        subjects: () => h('th', null, t('col.subjects')),
        bindingCount: () => h('th', null, t('col.bindings')),
        roleList: () => h('th', null, t('col.roles')),
        scopes: () => h('th', null, t('col.scopes')),
        hpaRef: () => h('th', null, t('col.hparef')),
        hpaTargets: () => h('th', null, t('col.hpatargets')),
        hpaRange: () => h('th', null, t('col.hparange')),
        vpaMode: () => h('th', null, t('col.vpamode')),
        vpaCpu: () => h('th', null, t('col.vpacpu')),
        vpaMem: () => h('th', null, t('col.vpamem')),
        vpaProvided: () => h('th', null, t('col.vpaprovided')),
        extra: () => (showExtraColumn ? h('th', null, t('col.extra')) : null),
        logs: () => (showLogsColumn ? h('th', { style: { width: 64 } }, t('col.logs')) : null),
        pods: () => (showPodsColumn ? h('th', { style: { width: 64 } }, t('col.pods')) : null),
        ops: () => (showOpsColumn ? h('th', { style: { width: 108 } }, t('col.ops')) : null),
      }
      const genericCols = ['name', 'ns', 'ready', 'status', 'age', 'class', 'host', 'extra', 'logs', 'pods', 'ops']
      // Custom resources have no shared schema: name/namespace/status plus the
      // values their CRD's additionalPrinterColumns produced (backend → extra).
      const crdCols = ['name', 'ns', 'status', 'extra', 'age']
      // Distinct values for the column filters, derived from the rows currently
      // loaded so each dropdown lists real choices. An empty selection in a
      // column means "show all".
      const distinctOf = (fn) => [...new Set(rows.map(fn).filter((v) => v !== null && v !== undefined && v !== ''))].sort()
      const podColOptions = useMemo(() => ({
        status: distinctOf((r) => String(r.status || '')),
        node: distinctOf((r) => String(r.node || '')),
        ip: distinctOf((r) => String(r.ip || '')),
      }), [rows])
      const nodeColOptions = useMemo(() => ({
        arch: distinctOf((r) => String(r.arch || '')),
        type: distinctOf((r) => String(r.type || '')),
        zone: distinctOf((r) => String(r.zone || '')),
      }), [rows])

      // Sortable/filterable header cell. Clicking the label cycles asc → desc → none;
      // a multi-select (when opts.filter is set) narrows that column to chosen values
      // without triggering the sort. Pod and node lists keep separate sort/filter state,
      // so the factory takes them as arguments.
      const makeTh = (sort, setSort, colFilter, setColFilter, optionsMap) => (key, label, opts = {}) => {
        const active = sort && sort.key === key
        const arrow = active ? (sort.dir === 1 ? '↑' : '↓') : ''
        const filterKey = opts.filter
        const options = filterKey ? optionsMap[filterKey] || [] : []
        return h('th', {
          className: 'dk-th-sort' + (active ? ' on' : ''),
          title: t('sort.toggle'),
          onClick: () => setSort((prev) => {
            if (!prev || prev.key !== key) return { key, dir: 1 }
            if (prev.dir === 1) return { key, dir: -1 }
            return null
          }),
        },
          h('span', { className: 'dk-th-label' }, label, active ? h('span', { className: 'dk-sort-arrow' }, arrow) : null,
            filterKey ? h(ColFilter, {
              t,
              value: colFilter[filterKey] || [],
              options,
              onChange: (next) => setColFilter({ ...colFilter, [filterKey]: next }),
            }) : null,
          ),
        )
      }
      const podTh = makeTh(podSort, setPodSort, podColFilter, setPodColFilter, podColOptions)
      // Node list: cpu/memory/podCount/arch/type/zone/age are sortable; arch/type/zone
      // additionally offer a multi-select filter.
      const nodeTh = makeTh(nodeSort, setNodeSort, nodeColFilter, setNodeColFilter, nodeColOptions)
      const NODE_SORTABLE = { cpu: 'col.cpu', memory: 'col.memory', podCount: 'col.podcount', arch: 'col.arch', type: 'col.type', zone: 'col.zone', age: 'col.age' }
      const NODE_FILTERABLE = { arch: true, type: true, zone: true }

      const spec = activeCrd ? crdCols : (kindCols[loggableBase] || genericCols)
      const isNodes = loggableBase === 'nodes'
      const columns = spec
        .map((col) => ({
          th: isNodes && NODE_SORTABLE[col]
            ? nodeTh(col, t(NODE_SORTABLE[col]), NODE_FILTERABLE[col] ? { filter: col } : {})
            : TH[col](),
          td: td[col],
        }))
        .filter((entry) => entry.th !== null)
      const colCount = isPods
        ? (1
            + (showNamespaceColumn ? 1 : 0)
            + (showReadyColumn ? 1 : 0)
            + (showStatusColumn ? 1 : 0)
            + 1 + 2 + 1 // age, Pod IP + node, 端口转发
            + (showLogsColumn ? 1 : 0)
            + (showOpsColumn ? 1 : 0))
        : columns.length
      const needsLogin = listError && listError.kind === 'needs-login'
      const hasClusters = clusters.length > 0

      let currentClusterBadge = null
      const selectedCluster = clusters.find((entry) => entry.name === selected) || null
      const selectedState = liveState || selectedCluster?.state || null
      if (selectedCluster || selectedState) {
        currentClusterBadge = h('span', { className: badgeClass(selectedState?.state) }, stateLabel(t, selectedState?.state))
      }
      const infoBadges = []
      if (clusterInfo?.version) infoBadges.push(h('span', { className: 'dk-badge info', key: 'v' }, clusterInfo.version))
      if (clusterInfo?.user) infoBadges.push(h('span', { className: 'dk-badge info', key: 'u' }, clusterInfo.user))
      const defaultNs = selectedCluster?.namespace || namespaces[0] || 'default'

      const head = h('div', { className: 'dk-view-head' },
        h(KubeIcon, { size: 16 }),
        h('span', { className: 'dk-view-title' }, t('view.title')),
        currentClusterBadge,
        ...infoBadges,
        h('div', { className: 'dk-spacer' }),
        authNeeded
          ? h('button', { className: 'dk-btn primary', onClick: () => setLogin({ cluster: selected, method: 'browser' }) }, t('btn.login'))
          : null,
        h('button', { className: 'dk-btn icon', onClick: () => refreshAll(true), title: t('refresh') }, '↻'),
        h('label', { className: 'dk-auto' },
          h('input', { type: 'checkbox', checked: autoRefresh, onChange: (event) => setAutoRefresh(event.target.checked) }),
          h('span', null, t('auto.refresh')),
        ),
        h('select', {
          className: 'dk-select mini', value: String(refreshInterval),
          onChange: (event) => setRefreshInterval(Number(event.target.value)),
        }, [10, 30, 60, 300].map((seconds) => h('option', { key: seconds, value: String(seconds) }, `${seconds}s`))),
      )

      const kindsBar = h('div', { className: 'dk-bar' },
        h('span', { className: 'dk-field' }, t('ctx.label')),
        h('select', {
          className: 'dk-select', value: selected,
          onChange: (event) => switchTo(event.target.value),
        }, clusters.map((entry) => h('option', { key: entry.name, value: entry.name }, entry.name))),

        !kindIsScoped
          ? h(React.Fragment, null,
              h('span', { className: 'dk-field' }, t('ns.label')),
              h(MultiSelect, {
                t,
                label: t('ns.label'),
                value: nsSel,
                options: namespaces,
                onChange: changeNamespace,
                defaultNs,
              }),
            )
          : null,

        h('span', { className: 'dk-field' }, t('kind.label')),
        h(KindPicker, { t, value: kind, options: KINDS, onChange: changeKind }),

        h('input', {
          className: 'dk-input search', placeholder: t('filter.placeholder'),
          value: filter, onChange: (event) => setFilter(event.target.value),
        }),
        h('span', { className: 'dk-badge count' }, t('msg.count').replace('{n}', String(filtered.length))),
      )

      let podsBanner = null
      if (podFilter !== null) {
        podsBanner = h('div', { className: 'dk-stale', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 } },
          h('span', null, t('msg.podsOf')),
          h('span', { className: 'dk-badge count' }, podFilter.kind),
          h('span', { className: 'dk-badge count' }, podFilter.name),
          h('span', null, t('msg.podsOfSuffix')),
          h('button', {
            className: 'dk-btn ghost dk-link-btn',
            style: { marginLeft: 8, marginTop: 0 },
            onClick: () => {
              setPodFilter(null)
              loadList(selected, 'pods', nsSel)
            },
          }, t('btn.clear')),
        )
      }

      let crdBanner = null
      if (activeCrd) {
        crdBanner = h('div', { className: 'dk-stale', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 } },
          h('span', null, t('msg.crdOf')),
          h('span', { className: 'dk-badge count' }, activeCrd.group),
          h('span', null, t('msg.crdOfMid')),
          h('span', { className: 'dk-badge count' }, activeCrd.kind),
          h('button', {
            className: 'dk-btn ghost dk-link-btn',
            style: { marginLeft: 8, marginTop: 0 },
            onClick: () => {
              setCrdTarget(null)
              setFilter('')
              setRows([])
              loadList(selected, 'customresourcedefinitions', [])
            },
          }, t('btn.backCrds')),
        )
      }

      let errorBanner = null
      if (listError) {
        // Only blank-with-error when there is nothing to show. If rows are already
        // on screen (stale), keep them and show a subtle notice instead of wiping
        // the view the user was just looking at.
        if (rows.length === 0) {
          errorBanner = h('div', { className: 'dk-error' },
            h('span', null, listError.error || t('state.error')),
            needsLogin
              ? h('button', { className: 'dk-btn primary', onClick: () => setLogin({ cluster: selected, method: 'browser' }) }, t('btn.login'))
              : null,
            needsLogin ? h('span', { className: 'dk-hint' }, t('msg.loginRequired')) : null,
          )
        } else {
          errorBanner = h('div', { className: 'dk-stale' },
            h('span', null, t('msg.stale').replace('{msg}', listError.error || t('state.error'))),
          )
        }
      }

      const table = filtered.length === 0
        ? h('div', { className: 'dk-empty' }, loading ? t('detail.loading') : (rows.length === 0 ? t('msg.noRows') : t('msg.noMatch')))
        : h('table', { className: 'dk-table' },
            h('thead', null,
              h('tr', null,
                isPods
                  ? [
                      podTh('name', t('col.name')),
                      showNamespaceColumn ? podTh('namespace', t('col.namespace')) : null,
                      h('th', null, t('col.ready')),
                      podTh('status', t('col.status'), { filter: 'status' }),
                      podTh('age', t('col.age')),
                      podTh('ip', t('col.ip')),
                      podTh('node', t('col.node'), { filter: 'node' }),
                      h('th', { style: { width: 96 } }, t('col.forwards')),
                      showLogsColumn ? h('th', { style: { width: 64 } }, t('col.logs')) : null,
                      showOpsColumn ? h('th', { style: { width: 108 } }, t('col.ops')) : null,
                    ]
                  : columns.map((col) => col.th),
              ),
            ),
            h('tbody', null,
              filtered.map((row) => {
                const main = h('tr', {
                  key: rowKey(row),
                  onClick: () => openDetail(selected, listKind, row),
                },
                  (isPods ? [
                    h('td', { className: 'dk-mono' },
                      h('button', {
                        className: 'dk-expander',
                        'aria-label': expanded[rowKey(row)] ? 'collapse' : 'expand',
                        title: expanded[rowKey(row)] ? t('collapse') : t('expand'),
                        onClick: (event) => { event.stopPropagation(); toggleExpand(row) },
                      }, expanded[rowKey(row)] ? '−' : '+'),
                      row.name,
                    ),
                    showNamespaceColumn ? h('td', { className: 'dk-muted' }, row.namespace || '—') : null,
                    h('td', null, row.ready || ''),
                    h('td', null, row.status
                      ? h('span', { className: 'dk-badge pod ' + podStatusTone(row.status) }, row.status)
                      : ''),
                    h('td', { className: 'dk-muted' }, row.age || ''),
                    h('td', { className: 'dk-mono' }, row.ip || '—'),
                    h('td', { className: 'dk-muted' }, row.node || '—'),
                    h('td', null, portCell(row)),
                    showLogsColumn
                      ? h('td', null,
                          h('button', {
                            className: 'dk-icon-btn',
                            title: t('col.logs'),
                            'aria-label': t('col.logs'),
                            onClick: (event) => { event.stopPropagation(); openLogs(selected, kind, row) },
                          }, h(LogsIcon, { size: 15 })),
                        )
                      : null,
                    showOpsColumn ? td.ops(row) : null,
                  ] : columns.map((col) => col.td(row))),
                )
                if (!showExpand) return main
                const entry = expanded[rowKey(row)]
                if (!entry) return h(React.Fragment, { key: rowKey(row) }, main)
                let subBody
                if (entry.loading) {
                  subBody = h('div', { className: 'dk-loading-cell' }, t('detail.loading'))
                } else if (entry.error) {
                  subBody = h('div', { className: 'dk-subrow-error' }, entry.error)
                } else {
                  const items = [...(entry.containers || []), ...(entry.initContainers || [])]
                  subBody = items.length === 0
                    ? h('div', { className: 'dk-loading-cell' }, t('containers.none'))
                    : h('table', { className: 'dk-subtable' },
                        h('thead', null,
                          h('tr', null,
                            h('th', null, t('col.name')),
                            h('th', null, t('col.ready')),
                            h('th', null, t('col.status')),
                            h('th', null, t('col.image')),
                            h('th', null, t('col.age')),
                            h('th', null, t('col.restarts')),
                            h('th', { style: { width: 48 } }, t('col.login')),
                            h('th', { style: { width: 48 } }, t('col.logs')),
                          ),
                        ),
                        h('tbody', null,
                          items.map((c) => h('tr', { key: c.name },
                            h('td', { className: 'dk-cname' }, c.init ? `${c.name} (init)` : c.name),
                            h('td', null, h('span', { className: `dk-badge ${c.ready ? 'ok' : 'warn'}` }, c.ready ? t('containers.ready') : t('containers.notReady'))),
                            h('td', null, c.state || ''),
                            h('td', { className: 'dk-cimg' }, c.image || ''),
                            h('td', { className: 'dk-muted' }, c.age || '—'),
                            h('td', null, `↻ ${c.restarts}`),
                            h('td', null,
                              h('button', {
                                className: 'dk-icon-btn',
                                title: t('col.login'),
                                'aria-label': t('col.login'),
                                onClick: (event) => { event.stopPropagation(); startShell(row, c.name) },
                              }, h(ShellIcon, { size: 15 })),
                            ),
                            h('td', null,
                              h('button', {
                                className: 'dk-icon-btn',
                                title: t('col.logs'),
                                'aria-label': t('col.logs'),
                                onClick: (event) => { event.stopPropagation(); openLogs(selected, kind, row, c.name) },
                              }, h(LogsIcon, { size: 15 })),
                            ),
                          )),
                        ),
                      )
                }
                const sub = h('tr', { key: `${rowKey(row)}::sub`, className: 'dk-subrow' },
                  h('td', { colSpan: colCount }, subBody),
                )
                return h(React.Fragment, { key: rowKey(row) }, main, sub)
              }),
            ),
          )

      // Open a shell for one container of a pod row: the host probes bash then sh
      // inside that container and either starts a session or explains why not.
      const startShell = useCallback(async (podRow, container) => {
        try {
          const namespace = podRow.namespace || (nsSel && nsSel[0]) || 'default'
          const result = await call('exec-start', {
            cluster: selected,
            namespace,
            pod: podRow.name,
            container,
          })
          if (!result || !result.ok) {
            setShellNotice((result && result.error) || t('shell.unsupported'))
            return
          }
          if (typeof openShell === 'function') openShell(result)
        } catch (failure) {
          setShellNotice(String(failure?.message || failure))
        }
      }, [selected, nsSel, openShell, t])

      let body
      if (!hasClusters) {
        body = h('div', { className: 'dk-empty' },
          h('div', { style: { marginBottom: 12 } }, t('view.empty')),
          h('button', { className: 'dk-btn primary', onClick: () => { try { window.__DSH_KUBE_OPEN_PANEL__ && window.__DSH_KUBE_OPEN_PANEL__() } catch {} } }, t('cluster.add')),
        )
      } else {
        body = h(React.Fragment, null,
          kindsBar,
          podsBanner,
          crdBanner,
          errorBanner,
          h('div', { className: 'dk-split' },
            h('div', { className: 'dk-main' }, table),
          ),
        )
      }

      return h('div', { ref: viewRef, className: 'dk-view' },
        h('div', { className: 'dk-view-card' },
          head,
          body,
        ),
        notice ? h('div', { className: 'dk-error' }, notice) : null,
        login
          ? h(LoginDialog, {
              t,
              cluster: login.cluster,
              auth: (clusters.find((entry) => entry.name === login.cluster) || {}).auth,
              bridge: boot?.browserBridge,
              onClose: () => setLogin(null),
              onDone: afterLogin,
            })
          : null,
        shellNotice
          ? h('div', { className: 'dk-modal-mask', role: 'dialog', 'aria-modal': true },
              h('div', { className: 'dk-modal', style: { width: 'min(460px,94vw)' } },
                h('h3', null, t('shell.unsupported')),
                h('div', { className: 'dk-muted', style: { lineHeight: 1.7, wordBreak: 'break-word' } }, shellNotice),
                h('div', { className: 'dk-actions' },
                  h('button', { className: 'dk-btn primary', onClick: () => setShellNotice(null) }, t('btn.close')),
                ),
              ),
            )
          : null,
        ops
          ? h(WorkloadOpsDialog, {
              t,
              cluster: selected,
              kind,
              row: ops.row,
              action: ops.action,
              onClose: () => setOps(null),
              onDone: () => {
                // Reflect the mutation in the table without waiting for a tick:
                // a deleted row disappears, a scaled one shows its new replica
                // count. Only the list is reloaded (probe/cluster state are
                // unaffected by a workload action).
                loadList(selected, listKind, isKindScoped(kind) && !crdTarget ? [] : nsSel)
              },
            })
          : null,
        forwardDialog
          ? h(PortForwardDialog, {
              t,
              mode: forwardDialog.mode,
              forward: forwardDialog.forward,
              row: forwardDialog.row,
              port: forwardDialog.port,
              ports: forwardDialog.mode === 'list' ? portsOf(forwardDialog.row) : [],
              forwards,
              cluster: selected,
              onStart: (entry) => setForwardDialog({ mode: 'start', row: forwardDialog.row, port: entry }),
              onStop: (entry) => setForwardDialog({ mode: 'stop', forward: entry }),
              onClose: () => { setForwardDialog(null); loadForwards() },
            })
          : null,
      )
    }

    function extraOf(row) {
      const parts = []
      if (row.restarts) parts.push(`↻ ${row.restarts}`)
      if (row.node) parts.push(row.node)
      if (row.roles) parts.push(row.roles)
      if (row.message) parts.push(row.message)
      if (row.extra) parts.push(row.extra)
      return parts.join(' · ')
    }

    // "Cube" glyph used by the resource-detail tab chip (distinct from the logs
    // document glyph and the Kube hexagon).
    function DetailIcon({ size, className }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, className,
      },
        h('path', { d: 'M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3Z' }),
        h('path', { d: 'M3.7 7.4 12 12l8.3-4.6M12 12v9.2' }),
      )
    }

    // Small "log lines" glyph used by the pods table logs column.
    function LogsIcon({ size, className }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, className,
      },
        h('path', { d: 'M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z' }),
        h('path', { d: 'M14 4v5h5' }),
        h('path', { d: 'M8 13h7M8 16.5h5' }),
      )
    }

    // Small "stack of pods" glyph used by the workload tables pod column.
    function PodsIcon({ size, className }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, className,
      },
        h('rect', { x: 4, y: 3, width: 16, height: 18, rx: 3 }),
        h('path', { d: 'M9 8h6M9 12h6M9 16h4' }),
      )
    }

    function KubeIcon({ size }) {
      const s = typeof size === 'number' ? size : 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M12 2.6 20.2 7.3v9.4L12 21.4 3.8 16.7V7.3Z' }),
        h('circle', { cx: 12, cy: 12, r: 3.1 }),
        h('path', { d: 'M12 5.4v3.5M12 15.1v3.5M6.3 8.9l3 1.7M14.7 13.4l3 1.7M6.3 15.1l3-1.7M14.7 10.6l3-1.7' }),
      )
    }

    function apply(ctx) {
      let t = (key) => (zh[key] !== undefined ? zh[key] : key)
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => {
          ctx.locale.register(NS, { zh, en })
        }, 'kube: dictionaries')
        try { t = ctx.locale.bind(NS) } catch {}
      }
      const translate = (key) => {
        const value = t(key)
        return value === undefined || value === null ? key : String(value)
      }

      // Allow the resource view (conversation tab) to jump to the sidebar panel.
      try {
        window.__DSH_KUBE_OPEN_PANEL__ = () => { try { ctx.layout.selectPanel(PANEL_ID) } catch {} }
      } catch {}

      const PanelPage = ({ onBack }) => h(ClustersPanel, { t: translate, onBack })

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 45,
        locale: NS,
        label: () => translate('panel.title'),
      }, KubeIcon)), 'kube: sidebar entry')

      const SessionPage = () => {
        useStyles()
        return h(ResourceView, {
          t: translate,
          openDetail: (cluster, kind, row) => {
            try {
              if (ctx.sidebarRight && typeof ctx.sidebarRight.openResource === 'function') {
                // One unique resource address per (cluster, kind, name) so the
                // tab identity (kind, address) gives the desired behaviour:
                // same resource -> focus the existing tab (revealIfOpened=true
                // default), different resource -> open a new tab.
                const name = String(row?.name || row || '')
                const addr = `dsh-resource://kube-detail/${encodeURIComponent(cluster)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`
                ctx.sidebarRight.openResource(addr, { kind: 'kube-detail', params: { cluster, kind, row } })
              } else if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
                ctx.sidebarRight.openTab('kube-detail', { params: { cluster, kind, row } })
              }
            } catch {}
          },
          openLogs: (cluster, kind, row, container) => {
            try {
              // One address per (cluster, kind, namespace, name): re-clicking the
              // same resource focuses its existing logs tab, a different one
              // opens a new tab. kubectl logs accepts deployment/<name> and
              // statefulset/<name> selectors, so pods, deployments and
              // statefulsets all stream logs through the same pane. An optional
              // container narrows the stream to a single -c <container>.
              const pod = String(row?.name || '')
              const namespace = String(row?.namespace || '')
              const kindBase = String(kind || 'pods').split('.')[0]
              const params = { cluster, kind: kindBase, pod, namespace, container: container || '' }
              if (ctx.sidebarRight && typeof ctx.sidebarRight.openResource === 'function') {
                const addr = `dsh-resource://kube-logs/${encodeURIComponent(cluster)}/${encodeURIComponent(kindBase)}/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}${container ? `/${encodeURIComponent(container)}` : ''}`
                ctx.sidebarRight.openResource(addr, { kind: 'kube-logs', params })
              } else if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
                ctx.sidebarRight.openTab('kube-logs', { params })
              }
            } catch {}
          },
          openShell: (session) => {
            try {
              // One tab per live shell session: the address carries the session
              // id (plus the pod/container for the tab title), so re-clicking
              // the same container starts a new session instead of reusing a
              // dead one.
              const params = {
                id: session.id,
                cluster: session.cluster,
                namespace: session.namespace,
                pod: session.pod,
                container: session.container,
                shell: session.shell,
                cols: session.cols,
                rows: session.rows,
              }
              const addr = `dsh-resource://kube-shell/${encodeURIComponent(session.id)}/${encodeURIComponent(session.pod || '')}/${encodeURIComponent(session.container || '')}`
              if (ctx.sidebarRight && typeof ctx.sidebarRight.openResource === 'function') {
                ctx.sidebarRight.openResource(addr, { kind: 'kube-shell', params })
              } else if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
                ctx.sidebarRight.openTab('kube-shell', { params })
              }
            } catch {}
          },
          openRules: (cluster, kind, row) => {
            try {
              // One tab per (cluster, kind, name): re-clicking the same role
              // focuses its existing rules tab, a different one opens a new tab.
              const name = String(row?.name || row || '')
              const addr = `dsh-resource://kube-rules/${encodeURIComponent(cluster)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`
              const params = { cluster, kind, row }
              if (ctx.sidebarRight && typeof ctx.sidebarRight.openResource === 'function') {
                ctx.sidebarRight.openResource(addr, { kind: 'kube-rules', params })
              } else if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
                ctx.sidebarRight.openTab('kube-rules', { params })
              }
            } catch {}
          },
        })
      }

      ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'kube',
        order: 45,
        label: () => translate('view.title'),
      }, SessionPage)), 'kube: conversation view')

      // Rightbar tab type + body + chip title for the resource inspector.
      const DETAIL_ID = 'dsh-kube-detail'
      const DETAIL_KIND = 'kube-detail'
      try {
        if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: DETAIL_ID,
            kind: DETAIL_KIND,
            title: (address) => {
              // address looks like dsh-resource://kube-detail/<cluster>/<kind>/<name>
              try {
                const segs = String(address).split('/').filter(Boolean)
                const name = segs.length ? decodeURIComponent(segs[segs.length - 1]) : ''
                return name || translate('detail.title')
              } catch { return translate('detail.title') }
            },
          }), 'kube: detail tab type')
        }
        if (ctx.slots) {
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: DETAIL_ID,
            locale: NS,
          }, (props) => h(DetailTab, { ...props, t: translate }))), 'kube: detail tab body')
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: DETAIL_ID,
          }, (props) => h(DetailTabTitle, { ...props, t: translate }))), 'kube: detail tab title')
        }
      } catch {}

      // Rightbar tab type + body + chip title for the dedicated pod logs view.
      const LOGS_ID = 'dsh-kube-logs'
      const LOGS_KIND = 'kube-logs'
      try {
        if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: LOGS_ID,
            kind: LOGS_KIND,
            title: (address) => {
              // address looks like dsh-resource://kube-logs/<cluster>/<ns>/<pod>
              try {
                const segs = String(address).split('/').filter(Boolean)
                const last = segs.length ? decodeURIComponent(segs[segs.length - 1]) : ''
                return last || translate('logs.title')
              } catch { return translate('logs.title') }
            },
          }), 'kube: logs tab type')
        }
        if (ctx.slots) {
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: LOGS_ID,
            locale: NS,
          }, (props) => h(LogsPane, { ...props, t: translate }))), 'kube: logs tab body')
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: LOGS_ID,
          }, (props) => h(LogsTabTitle, { ...props, t: translate }))), 'kube: logs tab title')
        }
      } catch {}

      // Rightbar tab type + body + chip title for the interactive container shell.
      const SHELL_ID = 'dsh-kube-shell'
      const SHELL_KIND = 'kube-shell'
      try {
        if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: SHELL_ID,
            kind: SHELL_KIND,
            title: (address) => {
              // address looks like dsh-resource://kube-shell/<id>/<pod>/<container>
              try {
                const segs = String(address).split('/').filter(Boolean)
                const pod = segs.length > 3 ? decodeURIComponent(segs[3]) : ''
                const container = segs.length > 4 ? decodeURIComponent(segs[4]) : ''
                if (pod && container) return `${pod} [${container}]`
                return pod || translate('shell.title')
              } catch { return translate('shell.title') }
            },
          }), 'kube: shell tab type')
        }
        if (ctx.slots) {
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: SHELL_ID,
            locale: NS,
          }, (props) => h(ShellPane, { ...props, t: translate }))), 'kube: shell tab body')
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: SHELL_ID,
          }, (props) => h(ShellTabTitle, { ...props, t: translate }))), 'kube: shell tab title')
        }
      } catch {}

      // Rightbar tab type + body + chip title for the Role/ClusterRole rules list.
      const RULES_ID = 'dsh-kube-rules'
      const RULES_KIND = 'kube-rules'
      try {
        if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: RULES_ID,
            kind: RULES_KIND,
            title: (address) => {
              // address looks like dsh-resource://kube-rules/<cluster>/<kind>/<name>
              try {
                const segs = String(address).split('/').filter(Boolean)
                const name = segs.length ? decodeURIComponent(segs[segs.length - 1]) : ''
                return name || translate('rules.title')
              } catch { return translate('rules.title') }
            },
          }), 'kube: rules tab type')
        }
        if (ctx.slots) {
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: RULES_ID,
            locale: NS,
          }, (props) => h(RulesPane, { ...props, t: translate }))), 'kube: rules tab body')
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: RULES_ID,
          }, (props) => h(RulesTabTitle, { ...props, t: translate }))), 'kube: rules tab title')
        }
      } catch {}

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, () => h(PanelPage, { onBack: () => { try { ctx.layout.selectPanel(null) } catch {} } }))), 'kube: main panel')
    }

    return {
      name: 'dsh-kube',
      inject: ['slots', 'locale', 'layout', 'sidebarRightTabs', 'sidebarRight'],
      apply,
    }
  },
})
