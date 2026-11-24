/**
 * dsh-kube — host half.
 *
 * The plugin owns a directory of kubeconfig files, one per cluster (named by the
 * user), drives the local `kubectl` binary, and exposes:
 *  - an HTTP surface used by the Web panel (clusters, list, yaml, login …);
 *  - agent tools that share the same service methods.
 *
 * A "cluster" is a saved kubeconfig file `configs/<name>.yaml`. The plugin name is
 * the identity shown in every dropdown; internally kubectl runs with
 * `--kubeconfig <file> --context <target-context>` where the target context is the
 * file's `current-context` (or its first context). The currently selected cluster
 * is also copied to `<home>/.kube/dsh/config` (the "current cluster" file).
 *
 * Credential handling mirrors what a terminal `kubectl` would do: every exec
 * block in a kubeconfig is executed by kubectl itself, so OIDC/AWS providers
 * keep working. kubeconfig exec plugins resolve HOME (and therefore token
 * caches, ~/.aws) against a configurable real home rather than the DSH
 * service HOME, so a token obtained here is shared with the user's shell.
 *
 * OIDC sign-in is driven directly instead of through kubectl: the exec argv
 * is spawned with `--skip-open-browser` (plus a grant type), the printed URL
 * is captured, opened in the Windows browser through WSL interop, and the
 * OAuth callback lands on kubelogin's 127.0.0.1 listener.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import jsYaml from './lib/js-yaml.cjs'

export const name = 'kube'
export const inject = ['tools', 'webServer']

const CMD_EXE = '/mnt/c/Windows/System32/cmd.exe'
const MAX_STDOUT = 24 * 1024 * 1024
const MAX_STDERR = 1024 * 1024
/** After a timeout/unreachable failure, refuse new kubectl runs for this long. */
const KUBECTL_BACKOFF_MS = 15000
/** Upper bound of that backoff (a dead cluster is retried at most once a minute). */
const KUBECTL_BACKOFF_MAX_MS = 60000
// A missing resource type is stable (it only changes on install/uninstall), so a
// short negative cache keeps an auto-refreshing tab from re-probing it every tick.
const MISSING_TYPE_TTL_MS = 5 * 60 * 1000
const MISSING_TYPE_RE = /doesn't have a resource type|the server could not find the requested resource/i
const CLUSTER_SCOPED = new Set([
  'nodes', 'node', 'namespaces', 'namespace', 'ns', 'persistentvolumes', 'pv',
  'storageclasses', 'sc', 'clusterroles', 'clusterrolebindings', 'customresourcedefinitions',
  'crds', 'csidrivers', 'priorityclasses', 'ingressclasses', 'runtimeclasses',
  // Pseudo kinds: RBAC subjects aggregated from role bindings (no cluster scope
  // of their own, so they take no namespace flag).
  'rbacusers', 'rbacgroups',
  'validatingwebhookconfigurations', 'mutatingwebhookconfigurations', 'apiservices',
])

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')

/** PTY size bounds: the browser reports its own grid; clamp anything absurd. */
function clampCols(value) {
  const cols = Number(value)
  return Number.isFinite(cols) && cols >= 20 ? Math.min(500, Math.floor(cols)) : 120
}
function clampRows(value) {
  const rows = Number(value)
  return Number.isFinite(rows) && rows >= 5 ? Math.min(200, Math.floor(rows)) : 32
}

/**
 * Find the DeepSeek Harness install root from the running entry point so a
 * native module shipped inside it (node-pty) can be required from this plugin,
 * which lives outside the harness package tree.
 */
function harnessRoot() {
  let dir = ''
  try { dir = path.dirname(fs.realpathSync(process.argv[1] || '')) } catch { return null }
  for (let depth = 0; depth < 8 && dir; depth += 1) {
    const pkg = path.join(dir, 'package.json')
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'))
        if (parsed && parsed.name === '@deepseek-ai/dsh') return dir
      } catch {}
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

let ptyModule
/**
 * node-pty (the native PTY provider the harness already ships for its own
 * terminals). Loaded lazily: a plugin loaded outside a harness process simply
 * reports that interactive shells are unavailable instead of failing to load.
 */
function loadPty() {
  if (ptyModule !== undefined) return ptyModule
  const bases = []
  const root = process.env.DSH_KUBE_HARNESS_ROOT || harnessRoot()
  if (root) bases.push(path.join(root, 'package.json'))
  // Common global install roots, so a service started through a wrapper that
  // obscures argv[1] still finds the harness copy of node-pty.
  for (const guess of ['/usr/lib/node_modules/@deepseek-ai/dsh', '/usr/local/lib/node_modules/@deepseek-ai/dsh']) {
    bases.push(path.join(guess, 'package.json'))
  }
  bases.push(import.meta.url)
  for (const base of bases) {
    try {
      ptyModule = createRequire(base)('node-pty')
      return ptyModule
    } catch {}
  }
  ptyModule = null
  return ptyModule
}

/**
 * kubeconfig files often point at certificates relative to their own directory
 * (`certs/<cluster>/k8s-ca.crt`). A copy in the plugin directory would resolve
 * those against the copy, so turn them into absolute paths on import.
 */
function absolutizeCerts(text, baseDir) {
  return String(text).replace(
    /^(\s*(?:certificate-authority|client-certificate|client-key)\s*:\s*)(\S+)\s*$/gm,
    (match, prefix, value) => {
      if (!value || path.isAbsolute(value) || value.startsWith('data:')) return match
      return prefix + path.resolve(baseDir, value)
    },
  )
}

function tail(text, limit = 4000) {
  const value = String(text || '')
  return value.length > limit ? '…' + value.slice(-limit) : value
}

/**
 * Strip kubectl's client-go log chatter from stderr.
 *
 * A dead API server makes client-go retry discovery, printing lines like
 * `E1121 22:58:39.449143 480003 memcache.go:265] "Unhandled Error" err="…"`
 * every ~8 seconds until the process dies. Those lines are noise for the UI and
 * for the model: keep the meaningful diagnostics (the final one-liner, RBAC
 * messages, exec-plugin errors) and drop the klog lines.
 */
function cleanStderr(stderr) {
  const lines = String(stderr || '').split('\n')
  const kept = lines.filter((line) => {
    const text = line.trim()
    if (text === '') return false
    // klog header: level + MMDD + time + pid + file.go:line]
    if (/^[IEWF]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+\s+[\w.-]+\.go:\d+\]/.test(text)) return false
    return true
  })
  return kept.join('\n').replace(/^\s*error:\s*/gm, '').trim()
}

function humanAge(iso) {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Timestamp (RFC3339) when a container last started, read from its state. */
function startedAtOf(state) {
  if (!state) return null
  if (state.running && state.running.startedAt) return state.running.startedAt
  if (state.terminated && state.terminated.startedAt) return state.terminated.startedAt
  return null
}

/** Summarise a container's state map ({running,waiting,terminated}) into text. */
function containerStateOf(state) {
  if (!state) return '—'
  if (state.running) return 'Running'
  if (state.waiting) return `Waiting: ${state.waiting.reason || state.waiting.message || ''}`.trim()
  if (state.terminated) {
    const t = state.terminated
    return t.reason ? `Terminated: ${t.reason}` : `Terminated (${t.exitCode})`
  }
  return '—'
}

/** Classify a kubectl failure into an actionable kind. */
function classify(stderr, timedOut) {
  if (timedOut) return 'timeout'
  const text = String(stderr || '').toLowerCase()
  if (/could not open the browser|authcode-browser error|authcode-keyboard error|getting credentials|exec plugin|no auth provider|oauth2: cannot fetch token|token.*(expired|invalid)|unauthorized/.test(text)) return 'needs-login'
  if (/unable to connect to the server|connection refused|no route to host|i\/o timeout|tls handshake timeout|dial tcp|no such host/.test(text)) return 'unreachable'
  if (/forbidden/.test(text)) return 'forbidden'
  if (/not found|doesn't have a resource type|matches no resources/.test(text)) return 'not-found'
  return 'error'
}

function hintFor(kind) {
  switch (kind) {
    case 'needs-login':
      return 'The context needs a sign-in. Ask the user to click Login in the Kubernetes panel (or call kube_login); the browser step must be completed by the user — it cannot be automated.'
    case 'unreachable':
      return 'The API server is unreachable from this host: check VPN/network and the cluster endpoint.'
    case 'forbidden':
      return 'The identity is authenticated but RBAC denies this request.'
    case 'not-found':
      return 'No such resource or the kind name is wrong. Use a kubectl kind such as pods, deployments.apps, events.'
    case 'timeout':
      return 'kubectl timed out. Narrow the query (namespace/selector) or retry.'
    case 'restarting':
      return 'The dsh web service is restarting; retry in a moment.'
    case 'unsupported':
      return 'This cluster does not serve that resource type (the CRD/operator is not installed there). Pick another cluster or install it first.'
    default:
      return undefined
  }
}

/** Describe how a kubeconfig user authenticates. */
function describeAuth(user) {
  const ex = user?.exec
  if (!ex) {
    if (user?.token || user?.tokenFile) return { kind: 'token', login: false }
    if (user?.['client-certificate-data'] || user?.['client-certificate']) return { kind: 'cert', login: false }
    return { kind: 'none', login: false, reason: 'This context has no credentials' }
  }
  const command = path.basename(String(ex.command || ''))
  const args = Array.isArray(ex.args) ? ex.args : []
  if (command === 'kubectl' && args[0] === 'oidc-login') return { kind: 'oidc', login: true, provider: 'kubelogin' }
  if (command === 'kubelogin') return { kind: 'azure', login: false, reason: 'Needs the standalone kubelogin binary (not on PATH)' }
  if (command === 'aws') return { kind: 'aws', login: false, reason: 'AWS credentials come from the aws CLI' }
  if (command === 'gcloud') return { kind: 'gcloud', login: false, reason: 'gcloud credentials come from the gcloud CLI' }
  return { kind: 'exec', login: false, reason: `Unmanaged exec plugin: ${command}` }
}

function conditionOf(conditions, type) {
  return (conditions || []).find((c) => c.type === type)
}

// Node "规格" column: "<cpu>C <mem>G" (e.g. "16C 64G"). Memory capacity arrives
// as binary units like "64776604Ki"/"32Gi"; normalise down to Gi then round to
// the nearest power of two so it reads as a familiar value (64G, 32G, 16G ...).
function nodeSpec(status) {
  const cpu = status?.capacity?.cpu
  const mem = status?.capacity?.memory
  if (!cpu && !mem) return ''
  return `${cpu || ''}C ${memToG(mem)}`.trim()
}
function roundPow2(x) {
  if (x <= 0) return 0
  return Math.pow(2, Math.round(Math.log2(x)))
}
function memToG(mem) {
  const m = String(mem || '').match(/^(\d+(?:\.\d+)?)\s*([KMG]i?|B)$/i)
  if (!m) return String(mem || '')
  const n = parseFloat(m[1])
  const unit = m[2].toUpperCase()
  let g
  if (unit === 'GI' || unit === 'G') g = n
  else if (unit === 'MI' || unit === 'M') g = n / 1024
  else if (unit === 'KI' || unit === 'K') g = n / 1024 / 1024
  else g = n
  return `${roundPow2(g)}G`
}

/** Parse a Kubernetes quantity (CPU cores) into integer millicores. */
function cpuToMills(value) {
  const v = String(value || '').trim()
  if (!v) return 0
  if (/m$/i.test(v)) {
    const n = Number(v.replace(/m$/i, ''))
    return Number.isFinite(n) ? Math.round(n) : 0
  }
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 1000) : 0
}

/** Parse a Kubernetes memory quantity into bytes, always binary (power-of-2):
 *  "1Gi"/"1G", "512Mi"/"512M", "12345Ki"/"12345K" are all 1024-based, so the
 *  displayed capacity is a power of 2 rather than a decimal approximation.
 *  A lowercase trailing `m` is the milli suffix (×10^-3 of the base byte),
 *  e.g. "28725966274560m" = 28.7 GB — distinct from the uppercase M/Mi (mebi). */
function memToBytes(value) {
  const v = String(value || '').trim()
  if (!v) return 0
  // Lowercase `m` only (no case-insensitivity) → milli ×10^-3 of the byte.
  if (/^\d+(?:\.\d+)?m$/.test(v)) {
    const n = Number(v.replace(/m$/, ''))
    return Number.isFinite(n) ? n / 1000 : 0
  }
  const m = v.match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i?|B)?$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const unit = (m[2] || 'B').toUpperCase()
  const mult = { B: 1, K: 1024, KI: 1024, M: 1024 ** 2, MI: 1024 ** 2, G: 1024 ** 3, GI: 1024 ** 3, T: 1024 ** 4, TI: 1024 ** 4, P: 1024 ** 5, PI: 1024 ** 5 }[unit] || 1
  return n * mult
}

/** Render millicores as cores: "4", "1.5", "0.25", "0". */
function fmtCpu(mills) {
  if (!mills) return '0'
  if (mills % 1000 === 0) return String(mills / 1000)
  return String(Math.round((mills / 1000) * 100) / 100)
}

/** Render bytes as a compact human unit (Gi with up to one decimal, else Mi/Ki). */
function fmtMem(bytes) {
  if (!bytes) return '0'
  if (bytes >= 1024 ** 3) {
    const g = bytes / 1024 ** 3
    return `${g >= 100 ? Math.round(g) : Math.round(g * 10) / 10}Gi`
  }
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}Mi`
  return `${Math.round(bytes / 1024)}Ki`
}

/** Render a node's *capacity* (millicores) as the nearest power-of-two cores,
 *  so the "total" reads as a familiar value (8, 16, 32 …) instead of the
 *  reserved-less real value. The request (numerator) is never rounded. */
function fmtCpuCapacity(mills) {
  if (!mills) return '0'
  return String(roundPow2(mills / 1000))
}

/** Render a node's *capacity* (bytes) as the nearest power-of-two Gi/Mi/Ki, so
 *  a "32G" machine reads 32Gi rather than the real 30.6Gi. Request stays exact. */
function fmtMemCapacity(bytes) {
  if (!bytes) return '0'
  if (bytes >= 1024 ** 3) return `${roundPow2(bytes / 1024 ** 3)}Gi`
  if (bytes >= 1024 ** 2) return `${roundPow2(bytes / 1024 ** 2)}Mi`
  return `${roundPow2(bytes / 1024)}Ki`
}

/** "User:alice, Group:dev, SA:ns/bot" — compact one-line subject summary. */
function summarizeSubjects(subjects) {
  const list = (subjects || []).map((subject) => {
    const kind = subject.kind === 'ServiceAccount' ? 'SA' : subject.kind
    if (subject.kind === 'ServiceAccount') return `${kind}:${subject.namespace || 'default'}/${subject.name}`
    return `${kind}:${subject.name}`
  })
  if (list.length <= 3) return list.join(', ')
  return `${list.slice(0, 3).join(', ')} +${list.length - 3}`
}

function rowOf(kind, item) {
  const meta = item.metadata || {}
  const base = String(kind).split('.')[0].toLowerCase()
  const row = {
    name: meta.name,
    namespace: meta.namespace || null,
    created: meta.creationTimestamp,
    age: humanAge(meta.creationTimestamp),
    status: '',
    ready: '',
  }
  switch (base) {
    case 'pods': {
      const statuses = item.status?.containerStatuses || []
      const total = item.spec?.containers?.length || statuses.length
      row.ready = `${statuses.filter((c) => c.ready).length}/${total}`
      row.restarts = statuses.reduce((sum, c) => sum + (c.restartCount || 0), 0)
      row.status = item.status?.reason || item.status?.phase || 'Unknown'
      row.node = item.spec?.nodeName || null
      row.ip = item.status?.podIP || null
      break
    }
    case 'deployments':
    case 'statefulsets':
    case 'replicasets': {
      row.ready = `${item.status?.readyReplicas || 0}/${item.spec?.replicas ?? 0}`
      row.status = conditionOf(item.status?.conditions, 'Available') ? 'Available' : 'Progressing'
      break
    }
    case 'daemonsets': {
      row.ready = `${item.status?.numberReady || 0}/${item.status?.desiredNumberScheduled ?? 0}`
      row.status = item.status?.numberMisscheduled ? 'Misscheduled' : 'Ready'
      break
    }
    case 'jobs': {
      row.ready = item.status?.active ? `${item.status.active} active` : 'done'
      row.status = `${item.status?.succeeded || 0} ok / ${item.status?.failed || 0} fail`
      break
    }
    case 'cronjobs': {
      row.ready = item.spec?.schedule || ''
      row.status = item.spec?.suspend ? 'Suspended' : 'Active'
      break
    }
    case 'nodes': {
      const ready = conditionOf(item.status?.conditions, 'Ready')
      row.status = ready ? (ready.status === 'True' ? 'Ready' : 'NotReady') : 'Unknown'
      // Cordon (spec.unschedulable) does not change the Ready condition, so
      // append kubectl's canonical "SchedulingDisabled" marker to make the
      // blocked state visible in the status column.
      if (item.spec && item.spec.unschedulable) row.status += ',SchedulingDisabled'
      row.ready = item.status?.nodeInfo?.kubeletVersion || ''
      row.roles = Object.keys(meta.labels || {})
        .filter((label) => label.startsWith('node-role.kubernetes.io/'))
        .map((label) => label.split('/')[1])
        .join(',')
      row.spec = nodeSpec(item.status)
      row.arch = (meta.labels || {})['kubernetes.io/arch'] || ''
      row.type = (meta.labels || {})['node.kubernetes.io/instance-type'] || ''
      row.zone = (meta.labels || {})['topology.kubernetes.io/zone'] || ''
      break
    }
    case 'services': {
      row.status = item.spec?.type || ''
      row.ready = item.spec?.clusterIP || ''
      row.externalIP = (item.status?.loadBalancer?.ingress || [])
        .map((entry) => entry.ip || entry.hostname).filter(Boolean).join(',')
        || (item.spec?.externalIPs || []).join(',') || ''
      row.ports = (item.spec?.ports || [])
        .map((port) => `${port.port}${port.nodePort ? `:${port.nodePort}` : ''}/${port.protocol || ''}`)
        .filter((text) => text).join(', ')
      break
    }
    case 'events': {
      row.status = item.reason || ''
      row.ready = item.count ?? 1
      row.created = item.lastTimestamp || item.eventTime || meta.creationTimestamp
      row.age = humanAge(row.created)
      row.message = tail(String(item.message || ''), 240)
      row.object = item.involvedObject
        ? `${item.involvedObject.kind}/${item.involvedObject.name}`
        : ''
      break
    }
    case 'configmaps':
    case 'secrets': {
      row.status = `${Object.keys(item.data || {}).length} keys`
      break
    }
    case 'persistentvolumeclaims': {
      row.status = item.status?.phase || ''
      row.ready = item.spec?.resources?.requests?.storage || ''
      row.volume = item.spec?.volumeName || ''
      break
    }
    case 'serviceaccounts': {
      row.secrets = (item.secrets || []).length
      row.status = row.secrets ? `${row.secrets} secrets` : '无'
      break
    }
    case 'roles':
    case 'clusterroles': {
      row.rules = (item.rules || []).length
      row.status = `${row.rules} rules`
      break
    }
    case 'rolebindings':
    case 'clusterrolebindings': {
      const ref = item.roleRef || {}
      row.roleKind = ref.kind || ''
      row.role = ref.name || ''
      row.status = ref.name ? `${ref.kind}/${ref.name}` : ''
      row.subjects = summarizeSubjects(item.subjects)
      row.subjectCount = (item.subjects || []).length
      break
    }
    default: {
      // CRD-defined kinds do not share a schema: surface the common status
      // conventions (phase/state, a Ready condition) so their rows are not blank.
      const conditions = item.status?.conditions || []
      const ready = conditions.find((entry) => String(entry.type).toLowerCase() === 'ready')
      row.status = item.status?.phase || item.status?.state || ''
      row.ready = ready ? (ready.status === 'True' ? 'Ready' : String(ready.status || '')) : ''
    }
  }
  return row
}

/**
 * Read the subset of JSONPath used by CRD `additionalPrinterColumns`: dotted
 * field names, array indexes and equality filters on an array field
 * (`.status.conditions[?(@.type=="Ready")].status`). Returns undefined when the
 * expression cannot be resolved.
 */
function readJSONPath(root, expression) {
  let value = root
  let rest = String(expression || '').trim()
  if (rest.startsWith('{') || rest === '') return undefined
  while (rest.length > 0) {
    if (rest[0] === '.') { rest = rest.slice(1); continue }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0]
      const end = rest.indexOf(quote, 1)
      if (end === -1) return undefined
      const key = rest.slice(1, end)
      if (value === null || value === undefined) return undefined
      value = value[key]
      rest = rest.slice(end + 1)
      continue
    }
    const field = /^[^.[]+/.exec(rest)
    if (field) {
      const key = field[0].replace(/\\\./g, '.')
      if (value === null || value === undefined) return undefined
      value = value[key]
      rest = rest.slice(field[0].length)
      continue
    }
    const index = /^\[(\d+)\]/.exec(rest)
    if (index) {
      if (!Array.isArray(value)) return undefined
      value = value[Number(index[1])]
      rest = rest.slice(index[0].length)
      continue
    }
    const filter = /^\[\?\(@\.([A-Za-z0-9_.-]+)\s*==\s*["']([^"']*)["']\)\]/.exec(rest)
    if (filter) {
      if (!Array.isArray(value)) return undefined
      const path = filter[1].split('.')
      value = value.find((entry) => path.reduce((node, key) => (node == null ? undefined : node[key]), entry) === filter[2])
      rest = rest.slice(filter[0].length)
      continue
    }
    // Unsupported expression (functions, ranges, unions …): stop here.
    return undefined
  }
  return value
}

/** Present one additionalPrinterColumns value the way kubectl would (dates as age). */
function printerValue(value, type) {
  if (value === undefined || value === null) return ''
  if (type === 'date') return humanAge(value)
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'object' ? JSON.stringify(entry) : String(entry))).join(',')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Column layout for `kubectl get <kind>` tabular output (keyed by base kind).
 * `cols` is the ordered set of header keywords (uppercase) used to bound each
 * field. kubectl pads every column to the widest cell, so slicing each data
 * line at the header keywords' start offsets is robust even when a value
 * contains spaces (e.g. a cronjob schedule like '5  *  *  *  *').
 */
const TABLE_COLS = {
  pods:          { wide: true,  namespaced: true, cols: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', 'IP', 'NODE'] },
  deployments:   { wide: false, namespaced: true, cols: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'] },
  statefulsets:  { wide: false, namespaced: true, cols: ['NAME', 'READY', 'AGE'] },
  daemonsets:    { wide: false, namespaced: true, cols: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'] },
  jobs:          { wide: false, namespaced: true, cols: ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE'] },
  cronjobs:      { wide: false, namespaced: true, cols: ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'AGE'] },
  services:      { wide: false, namespaced: true, cols: ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'] },
  ingresses:     { wide: false, namespaced: true, cols: ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'AGE'] },
  configmaps:    { wide: false, namespaced: true, cols: ['NAME', 'DATA', 'AGE'] },
  secrets:       { wide: false, namespaced: true, cols: ['NAME', 'TYPE', 'DATA', 'AGE'] },
  persistentvolumeclaims: { wide: false, namespaced: true, cols: ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'AGE'] },
  horizontalpodautoscalers: { wide: false, namespaced: true, cols: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'] },
  verticalpodautoscalers:   { wide: false, namespaced: true, cols: ['NAME', 'MODE', 'CPU', 'MEM', 'PROVIDED', 'AGE'] },
  namespaces:    { wide: false, namespaced: false, cols: ['NAME', 'STATUS', 'AGE'] },
  nodes:         { wide: false, namespaced: false, cols: ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'] },
}

/**
 * True when `kind` names a type installed by a CRD (e.g. applications.argoproj.io)
 * rather than one of the built-in resources we know how to parse.
 */
function isCustomResourceKind(kind) {
  const text = String(kind || '')
  if (!text.includes('.')) return false
  const base = text.split('.')[0].toLowerCase()
  if (TABLE_COLS[base]) return false
  return !['events', 'customresourcedefinitions', 'crds'].includes(base)
}

/**
 * Fill a CR row with the values its CRD declares via additionalPrinterColumns,
 * so arbitrary custom resources render meaningfully without a per-type schema.
 */
function decorateCustomRow(row, item, info) {
  if (!info) return row
  row.crdKind = info.kind
  row.crdGroup = info.group
  // Name/namespace/age already have their own columns; repeating them in 其他
  // would be pure noise.
  const columns = (info.printerColumns || []).filter((column) => !/^(name|namespace|age)$/i.test(column.name))
  const parts = []
  for (const column of columns) {
    const text = printerValue(readJSONPath(item, column.jsonPath), column.type)
    if (text === '') continue
    parts.push(`${column.name}=${text}`)
  }
  if (parts.length > 0) {
    row.extra = row.extra ? `${row.extra} · ${parts.join(' · ')}` : parts.join(' · ')
    if (!row.status && columns.length > 0) {
      // The first declared column is normally the resource's readiness/status
      // (e.g. Argo's "Sync Status", cert-manager's "Ready").
      const primary = printerValue(readJSONPath(item, columns[0].jsonPath), columns[0].type)
      if (primary !== '') row.status = primary
    }
  }
  return row
}

/**
 * Split `kubectl get` output (header + rows) into cell arrays by locating each
 * header keyword's start offset. Returns null if the header isn't recognizable
 * (caller then falls back to JSON). Empty (header-only) output returns [].
 */
function splitTable(output, keywords) {
  const lines = String(output).split('\n').map((line) => line.replace(/\r/g, '')).filter((line) => line.trim() !== '')
  if (lines.length === 0) return []
  const header = lines[0]
  const starts = []
  let searchFrom = 0
  for (const kw of keywords) {
    const index = header.indexOf(kw, searchFrom)
    if (index === -1) return null
    starts.push(index)
    searchFrom = index + kw.length
  }
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const cells = starts.map((start, j) => {
      const end = j + 1 < starts.length ? starts[j + 1] : line.length
      return line.slice(start, end).trim()
    })
    rows.push(cells)
  }
  return rows
}

/** Normalize a `-o wide` cell: take the first whitespace-delimited token and drop
 *  the kubectl `<none>` placeholder for missing fields (e.g. pod IP/node before
 *  the pod is scheduled). Returns null when there is nothing usable. */
function cleanCell(value) {
  if (!value) return null
  const token = String(value).split(/\s+/)[0]
  return token && token !== '<none>' ? token : null
}

/** Build a table row from parsed cells using the same field conventions as rowOf(). */
function tabRowOf(kind, cells, keywords, allNamespaces, namespace) {
  const get = (kw) => {
    const index = keywords.indexOf(kw)
    return index >= 0 ? (cells[index] ?? '') : ''
  }
  const base = String(kind).split('.')[0].toLowerCase()
  const spec = TABLE_COLS[base]
  const row = {
    name: get('NAME'),
    namespace: spec && spec.namespaced
      ? (allNamespaces ? (get('NAMESPACE') || null) : (namespace && namespace !== '' ? namespace : 'default'))
      : null,
    created: '',
    age: get('AGE').split(/\s+/)[0] || '',
    status: '',
    ready: '',
  }
  switch (base) {
    case 'pods':
      row.ready = get('READY')
      row.status = get('STATUS')
      row.restarts = get('RESTARTS')
      row.node = cleanCell(get('NODE'))
      row.ip = cleanCell(get('IP'))
      break
    case 'deployments':
      row.ready = get('READY')
      row.status = get('READY').split('/')[0] === get('AVAILABLE') ? 'Available' : 'Progressing'
      break
    case 'statefulsets':
      row.ready = get('READY')
      row.status = 'Ready'
      break
    case 'daemonsets':
      row.ready = `${get('READY')}/${get('DESIRED')}`
      row.status = 'Ready'
      break
    case 'jobs':
      row.ready = get('COMPLETIONS')
      row.status = get('STATUS')
      break
    case 'cronjobs':
      row.ready = get('SCHEDULE')
      row.status = get('SUSPEND') === 'True' ? 'Suspended' : 'Active'
      row.suspended = get('SUSPEND') === 'True'
      break
    case 'nodes':
      row.status = get('STATUS')
      row.ready = get('VERSION')
      row.roles = get('ROLES') === '<none>' ? '' : get('ROLES')
      break
    case 'namespaces':
      row.status = get('STATUS')
      break
    case 'horizontalpodautoscalers':
      // TARGETS is the "cpu: 4%/80%" health line; the range chips show scaling bounds.
      row.ready = get('TARGETS')
      row.status = cleanCell(get('REFERENCE'))
      row.hpaMin = get('MINPODS')
      row.hpaMax = get('MAXPODS')
      row.replicas = get('REPLICAS')
      break
    case 'verticalpodautoscalers':
      row.status = get('MODE')
      row.ready = get('PROVIDED')
      row.cpu = cleanCell(get('CPU'))
      row.memory = cleanCell(get('MEM'))
      break
    case 'services':
      row.status = get('TYPE')
      row.ready = get('CLUSTER-IP')
      row.externalIP = cleanCell(get('EXTERNAL-IP'))
      row.ports = get('PORT(S)')
      break
    case 'configmaps':
    case 'secrets':
      row.status = `${get('DATA')} keys`
      break
    case 'persistentvolumeclaims':
      row.status = get('STATUS')
      row.ready = get('CAPACITY')
      row.accessMode = get('ACCESS MODES')
      row.storageClass = cleanCell(get('STORAGECLASS'))
      row.volume = cleanCell(get('VOLUME'))
      break
    case 'ingresses':
      row.class = cleanCell(get('CLASS'))
      row.host = cleanCell(get('HOSTS'))
      break
    default:
      row.status = ''
  }
  return row
}

function formatRows(headers, rows) {
  if (rows.length === 0) return '(no items)'
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index] ?? '').length),
  ))
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

/** Kill a spawned process together with any exec plugin it started. */
function killTree(child) {
  if (!child || child.pid === undefined) return
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  try { child.kill('SIGKILL') } catch {}
}

function safeName(name) {
  return String(name || 'cluster').trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'cluster'
}

class KubeService {
  constructor(options) {
    this.dir = options.configDir
    this.home = options.home
    this.awsHome = options.awsHome
    this.root = path.dirname(this.dir)
    this.merged = path.join(this.root, 'config')
    // kubectl caches API discovery under ~/.kube/cache. In this setup $HOME/.kube
    // is a symlink into a Windows mount, where the thousands of small cache files
    // cost seconds of syscalls (a fully-qualified kind went 0.5s → 14s). Keep the
    // cache on the DSH workspace instead, next to the kubeconfigs.
    this.cacheDir = path.join(this.root, 'cache')
    this.statePath = path.join(this.root, 'dsh-kube-state.json')
    this.kubectlBin = options.kubectl
    this.loginTimeoutMs = options.loginTimeoutMs
    this.auth = new Map()
    this.sessions = new Map()
    this.clusterViews = new Map()
    /** Live `kubectl port-forward` processes, keyed by forward id (in-memory:
     * they die with dsh, and a restart always starts from an empty map). */
    this.forwards = new Map()
    this.forwardSeq = 0
    this.versions = new Map()
    // Per-cluster backoff for dead clusters: a view that keeps polling an
    // unreachable cluster must not spawn kubectl (and its 8s discovery retry
    // chatter) over and over. Keyed by cluster name: { kind, error, until }.
    this.backoff = new Map()
    /** Consecutive timeout/unreachable failures per cluster (drives the backoff growth). */
    this.failStreak = new Map()
    /**
     * Installed CRDs per cluster: { at, list, byKind }. `byKind` maps
     * `<plural>.<group>` to the CRD entry so custom resource listings can pick
     * the right printer columns without another discovery round-trip.
     */
    this.crdsCache = new Map()
    // `${cluster}:${base}` → { at, label } for kinds the cluster does not serve.
    this.unsupported = new Map()
    /** Role/ClusterRole bindings per cluster, for the aggregated User/Group views. */
    this.rbacCache = new Map()
    /** Live `kubectl exec` shells (interactive container terminals), keyed by id. */
    this.shells = new Map()
    this.shellSeq = 0
    this.closing = false
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.cacheDir, { recursive: true })
  }

  state() {
    try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) || {} } catch { return {} }
  }

  saveState(patch) {
    const next = { ...this.state(), ...patch }
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      fs.writeFileSync(this.statePath, JSON.stringify(next), { mode: 0o600 })
    } catch {}
    return next
  }

  files() {
    try {
      return fs.readdirSync(this.dir)
        .filter((entry) => /\.(ya?ml|json)$/i.test(entry))
        .sort()
        .map((entry) => {
          const full = path.join(this.dir, entry)
          return { name: entry, path: full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs }
        })
    } catch {
      return []
    }
  }

  signature() {
    return this.files().map((file) => `${file.name}:${file.mtime}`).join('|')
  }

  clusterFile(cluster) {
    return path.join(this.dir, `${safeName(cluster)}.yaml`)
  }

  clusterNames() {
    return this.files().map((file) => file.name.replace(/\.(ya?ml|json)$/i, ''))
  }

  env(extra = {}) {
    const env = {
      ...process.env,
      HOME: this.home,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    }
    delete env.KUBECONFIG
    // AWS SSO credentials live in the real login home, not the DSH home.
    if (this.awsHome) {
      const credentials = path.join(this.awsHome, '.aws', 'credentials')
      const settings = path.join(this.awsHome, '.aws', 'config')
      if (fs.existsSync(credentials)) env.AWS_SHARED_CREDENTIALS_FILE = credentials
      if (fs.existsSync(settings)) env.AWS_CONFIG_FILE = settings
    }
    return { ...env, ...extra }
  }

  /** Run kubectl with argv (no shell), bounded output and deadline. */
  run(args, { timeoutMs = 30000, input, env } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        // Own process group: kubectl's exec plugins inherit our pipes, so a plain
        // child.kill() leaves the plugin alive and 'close' never fires.
        child = spawn(this.kubectlBin, args, { env: env || this.env(), cwd: this.home, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      } catch (error) {
        resolve({ code: -1, stdout: '', stderr: String(error?.message || error), timedOut: false })
        return
      }
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let signal = null
      const startedAt = Date.now()
      const finish = (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut, signal, ms: Date.now() - startedAt })
      }
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { if (stdout.length < MAX_STDOUT) stdout += chunk })
      child.stderr.on('data', (chunk) => { if (stderr.length < MAX_STDERR) stderr += chunk })
      child.on('error', (error) => { stderr += `\n${error?.message || error}`; finish(-1) })
      child.on('close', (code, exitSignal) => {
        signal = exitSignal || null
        finish(typeof code === 'number' ? code : -1)
      })
      if (input !== undefined) { try { child.stdin.write(input) } catch {} }
      try { child.stdin.end() } catch {}
    })
  }

  async hasKubectl() {
    if (this.kubectlOk === undefined) {
      const result = await this.run(['version', '--client', '-o', 'json'], { timeoutMs: 8000 })
      this.kubectlOk = result.code === 0
    }
    return this.kubectlOk
  }

  /** Resolve a cluster's kubeconfig into its JSON view (current-context, users, …). */
  async clusterView(cluster) {
    const file = this.clusterFile(cluster)
    if (!fs.existsSync(file)) throw new Error(`集群 "${cluster}" 不存在`)
    const stat = fs.statSync(file)
    const key = `${file}:${stat.mtimeMs}`
    const cached = this.clusterViews.get(key)
    if (cached) return cached
    const result = await this.run(['config', 'view', '--kubeconfig', file, '--raw', '-o', 'json'], { timeoutMs: 20000 })
    if (result.code !== 0) throw new Error(tail(result.stderr || '读取 kubeconfig 失败', 900))
    let value
    try { value = JSON.parse(result.stdout) } catch { throw new Error('kubeconfig 不是合法 YAML/JSON') }
    this.clusterViews.set(key, value)
    return value
  }

  targetContext(view) {
    if (!view) return null
    if (view['current-context']) return view['current-context']
    return view.contexts?.[0]?.name || null
  }

  /** Resolve the target context name for a cluster (cached view). */
  async targetContextFor(cluster) {
    const view = await this.clusterView(cluster)
    const ctx = this.targetContext(view)
    if (!ctx) throw new Error(`集群 "${cluster}" 的 kubeconfig 没有 context`)
    return ctx
  }

  /** Per-cluster info list (the plugin-defined names). */
  async clusters() {
    const current = this.state().current || null
    const out = []
    for (const name of this.clusterNames()) {
      const row = {
        name,
        current: name === current,
        auth: { kind: 'none', login: false },
        server: '',
        namespace: 'default',
        state: this.auth.get(name) || { state: 'unknown' },
        login: this.sessions.get(name) ? this.publicSession(this.sessions.get(name)) : null,
        error: null,
      }
      try {
        const view = await this.clusterView(name)
        const ctx = this.targetContext(view)
        const context = (view.contexts || []).find((entry) => entry.name === ctx)?.context || {}
        const user = (view.users || []).find((entry) => entry.name === context.user)?.user || {}
        const cluster = (view.clusters || []).find((entry) => entry.name === context.cluster)?.cluster || {}
        row.server = cluster.server || ''
        row.namespace = context.namespace || cluster.namespace || 'default'
        row.context = ctx
        row.auth = describeAuth(user)
      } catch (error) {
        row.error = String(error?.message || error)
      }
      out.push(row)
    }
    return out
  }

  async userFor(cluster) {
    const view = await this.clusterView(cluster)
    const ctx = this.targetContext(view)
    const context = (view.contexts || []).find((entry) => entry.name === ctx)?.context || {}
    const user = (view.users || []).find((entry) => entry.name === context.user)?.user || {}
    return { user, context, ctx }
  }

  async kubectl(cluster, args, { timeoutMs = 30000, input } = {}) {
    const file = this.clusterFile(cluster)
    if (!fs.existsSync(file)) throw new Error(`集群 "${cluster}" 不存在`)
    // Skip re-running kubectl against a cluster that just proved unreachable.
    // Without this, every poll of a dead cluster spawns kubectl, which then
    // retries API discovery every ~8s until our timeout kills it.
    const backoff = this.backoff.get(cluster)
    if (backoff && Date.now() < backoff.until) {
      return { ok: false, kind: backoff.kind, error: backoff.error, hint: hintFor(backoff.kind), cached: true }
    }
    if (args[0] === 'get') {
      const key = `${cluster}:${String(args[1] || '').split('.')[0].toLowerCase()}`
      const missing = this.unsupported.get(key)
      if (missing && Date.now() - missing.at < MISSING_TYPE_TTL_MS) {
        return { ok: false, kind: 'unsupported', error: `集群「${cluster}」没有提供 ${missing.label} 资源类型`, hint: hintFor('unsupported'), cached: true }
      }
    }
    const ctx = await this.targetContextFor(cluster)
    const result = await this.run(['--kubeconfig', file, '--context', ctx, '--cache-dir', this.cacheDir, ...args], { timeoutMs, input })
    if (result.code === 0) {
      this.backoff.delete(cluster)
      this.failStreak.delete(cluster)
      if (this.auth.get(cluster)?.state !== 'ok') this.auth.set(cluster, { state: 'ok', at: Date.now() })
      return { ok: true, stdout: result.stdout }
    }
    // A resource type this cluster never installed (VPA without the CRD, an
    // operator that was uninstalled) is a normal state, not a broken cluster:
    // report it as `unsupported` so the UI can say so instead of showing a
    // kubectl stack trace, and remember it briefly to skip the doomed calls.
    const requested = args[0] === 'get' ? String(args[1] || '').split('.')[0].toLowerCase() : ''
    if (requested && MISSING_TYPE_RE.test(String(result.stderr || ''))) {
      const label = (String(result.stderr).match(/resource type\s+"([^"]+)"/i) || [])[1] || requested
      this.unsupported.set(`${cluster}:${requested}`, { at: Date.now(), label })
      return { ok: false, kind: 'unsupported', error: `集群「${cluster}」没有提供 ${label} 资源类型`, hint: hintFor('unsupported') }
    }

    // A run cut short by our own shutdown — or by the service manager killing the
    // cgroup on restart — exits on a signal and writes nothing to stderr, which
    // used to surface as the meaningless "kubectl exited with code -1". Name it
    // for what it is so the UI can retry quietly instead of showing a banner.
    if (this.closing || (!result.timedOut && result.code === -1 && result.signal && !cleanStderr(result.stderr).trim())) {
      // Do not record this in `auth`: it is transient, and a "restarting" badge
      // would outlive the restart.
      return { ok: false, kind: 'restarting', error: '服务正在重启，请求被中断', hint: hintFor('restarting'), retry: true }
    }
    const kind = classify(result.stderr, result.timedOut)
    this.auth.set(cluster, { state: kind, message: tail(cleanStderr(result.stderr), 400), at: Date.now() })
    const label = args.join(' ')
    const took = result.ms ? `（${(result.ms / 1000).toFixed(1)}s）` : ''
    const detail = tail(cleanStderr(result.stderr), 1200)
    const fallback = result.timedOut
      ? `kubectl ${label} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已终止${took}`
      : result.code === -1
        ? `kubectl ${label} 被信号 ${result.signal || '未知'} 终止${took}`
        : `kubectl exited with code ${result.code}`
    if (result.timedOut || result.code === -1) {
      console.warn(`[dsh-kube] ${cluster} ${label}: ${result.timedOut ? 'timeout' : `signal ${result.signal || '?'}`} ${took}`)
    }
    const error = detail
      ? (result.timedOut ? `${fallback}：${detail}` : detail)
      : fallback
    // Unreachable hosts: hold callers off instead of letting every poll re-run a
    // doomed kubectl (each run also spams discovery retries for ~30-60s). The wait
    // doubles per consecutive failure, capped at KUBECTL_BACKOFF_MAX_MS.
    // A timeout is NOT backed off: it is usually one slow call (discovery refresh,
    // an exec plugin blocking), and caching the error only keeps the banner alive.
    // needs-login is not backed off either — the user may sign in at any moment.
    if (kind === 'unreachable') {
      const streak = (this.failStreak.get(cluster) || 0) + 1
      this.failStreak.set(cluster, streak)
      const wait = Math.min(KUBECTL_BACKOFF_MS * Math.pow(2, streak - 1), KUBECTL_BACKOFF_MAX_MS)
      this.backoff.set(cluster, { kind, error, until: Date.now() + wait })
    }
    return { ok: false, kind, error, hint: hintFor(kind) }
  }

  // ---- cluster config management -----------------------------------------

  sources() {
    return this.files().map(({ name, size, mtime }) => ({ name, size, mtime }))
  }

  /** Create or update a cluster from a pasted kubeconfig (name = plugin cluster name). */
  async addSource(name, content) {
    fs.mkdirSync(this.dir, { recursive: true })
    const text = String(content || '')
    if (!/apiVersion\s*:/.test(text) || !/kind\s*:/.test(text)) throw new Error('内容不像 kubeconfig（缺少 apiVersion/kind）')
    const safe = safeName(name)
    const file = this.clusterFile(safe)
    fs.writeFileSync(file, text, { mode: 0o600 })
    this.clusterViews.clear()
    return { name: safe }
  }

  async removeSource(name) {
    const safe = safeName(name)
    const file = this.clusterFile(safe)
    if (!file.startsWith(this.dir) || !fs.existsSync(file)) throw new Error('集群不存在')
    fs.unlinkSync(file)
    this.clusterViews.clear()
    if (this.state().current === safe) this.saveState({ current: null })
    return { removed: safe }
  }

  /** Raw YAML of a saved cluster (used to pre-fill the edit modal). */
  clusterYaml(cluster) {
    const file = this.clusterFile(cluster)
    if (!fs.existsSync(file)) throw new Error(`集群 "${cluster}" 不存在`)
    return { name: safeName(cluster), yaml: fs.readFileSync(file, 'utf8') }
  }

  /** Select a cluster as the current one and copy its config to `.kube/dsh/config`. */
  async switchCluster(cluster) {
    const name = safeName(cluster)
    const file = this.clusterFile(name)
    if (!fs.existsSync(file)) throw new Error(`集群 "${name}" 不存在`)
    fs.mkdirSync(path.dirname(this.merged), { recursive: true })
    fs.writeFileSync(this.merged, fs.readFileSync(file), { mode: 0o600 })
    this.saveState({ current: name })
    // Picking a cluster is an explicit "try it now": drop any backoff so the
    // first call after the switch really runs.
    this.backoff.delete(name)
    this.failStreak.delete(name)
    return { current: name }
  }

  // ---- resource access ----------------------------------------------------

  async namespaces(cluster) {
    // 10s: a dead API server makes kubectl hang for the whole deadline (and log a
    // discovery retry every ~8s), so fail fast and let the backoff take over.
    const result = await this.kubectl(cluster, ['get', 'namespaces', '-o', 'json'], { timeoutMs: 10000 })
    if (!result.ok) return result
    const parsed = JSON.parse(result.stdout)
    return { ok: true, namespaces: (parsed.items || []).map((item) => item.metadata?.name).filter(Boolean).sort() }
  }

  /**
   * Installed CRDs for a cluster, cached for 60s. The cache also indexes every
   * entry by `<plural>.<group>` so custom resource listings can read the printer
   * columns their CRD declares without another discovery round-trip.
   *
   * `-o json` is not used: a CRD carries its full OpenAPI schema and a cluster
   * with hundreds of CRDs answers with tens of MB, which overruns the stdout
   * budget. A jsonpath projection of the fields we need is ~200KB instead.
   */
  async crds(cluster, { refresh = false } = {}) {
    const cached = this.crdsCache.get(cluster)
    if (!refresh && cached && Date.now() - cached.at < 60000) {
      return { ok: true, crds: cached.list }
    }
    const template = '{range .items[*]}'
      + '{.metadata.name}{"\\t"}{.spec.names.kind}{"\\t"}{.spec.names.plural}{"\\t"}{.spec.names.singular}'
      + '{"\\t"}{.spec.group}{"\\t"}{.spec.scope}{"\\t"}{.metadata.creationTimestamp}'
      + '{"\\t"}{range .spec.names.shortNames[*]}{.}{","}{end}'
      + '{"\\t"}{range .status.conditions[?(@.type=="Established")]}{.status}{end}'
      + '{"\\t"}{range .spec.versions[*]}'
      + '{.name}{"~"}{.served}{"~"}{.storage}{"~"}'
      + '{range .additionalPrinterColumns[*]}{.name}{"^"}{.jsonPath}{"^"}{.type}{"^"}{.priority}{","}{end}{"|"}'
      + '{end}{"\\n"}{end}'
    const result = await this.kubectl(cluster, ['get', 'customresourcedefinitions', '-o', `jsonpath=${template}`], { timeoutMs: 30000 })
    if (!result.ok) return result
    const list = []
    const byKind = new Map()
    for (const line of String(result.stdout).split('\n')) {
      if (!line.trim()) continue
      const fields = line.replace(/\r$/, '').split('\t')
      if (fields.length < 10) continue
      const [name, kindName, plural, singular, group, scope, created, shortNames, establishedText, versionsText] = fields
      const versions = []
      for (const chunk of String(versionsText || '').split('|')) {
        if (!chunk) continue
        const parts = chunk.split('~')
        const version = {
          name: parts[0] || '',
          served: parts[1] !== 'false',
          storage: parts[2] === 'true',
          printerColumns: [],
        }
        for (const column of String(parts[3] || '').split(',')) {
          if (!column) continue
          const pieces = column.split('^')
          if (pieces.length < 2) continue
          version.printerColumns.push({
            name: pieces[0],
            jsonPath: pieces[1],
            type: pieces[2] || 'string',
            priority: Number(pieces[3] || 0),
          })
        }
        versions.push(version)
      }
      const served = versions.filter((entry) => entry.served)
      const storage = versions.find((entry) => entry.storage)
      // Prefer the storage version's columns: that is the shape kubectl prints.
      const display = storage && storage.served ? storage : (served[0] || versions[0])
      const established = establishedText === 'True'
      const entry = {
        name: name || `${plural}.${group}`,
        group: group || '',
        kind: kindName || '',
        plural: plural || '',
        singular: singular || '',
        shortNames: String(shortNames || '').split(',').filter(Boolean),
        scope: scope || '',
        versions: served.map((item) => item.name).filter(Boolean),
        allVersions: versions.map((item) => item.name).filter(Boolean),
        storageVersion: storage?.name || '',
        version: display?.name || '',
        // priority > 0 columns are the "wide" extras: kubectl hides them from the
        // default table, so drop them from the inline extra summary too.
        printerColumns: (display?.printerColumns || [])
          .filter((column) => column.jsonPath && !column.priority),
        established,
        status: established ? 'Established' : 'NotEstablished',
        created: created || '',
        age: humanAge(created),
      }
      list.push(entry)
      if (entry.plural && entry.group) byKind.set(`${entry.plural}.${entry.group}`.toLowerCase(), entry)
    }
    list.sort((a, b) => a.name.localeCompare(b.name))
    this.crdsCache.set(cluster, { at: Date.now(), list, byKind })
    return { ok: true, crds: list }
  }

  /** Cached CRD metadata for a custom kind (`<plural>.<group>`), when indexed. */
  crdInfo(cluster, kind) {
    const cached = this.crdsCache.get(cluster)
    if (!cached) return null
    return cached.byKind.get(String(kind).toLowerCase()) || null
  }

  /** Populate the CRD index before listing a custom resource (best effort). */
  async ensureCrds(cluster) {
    const cached = this.crdsCache.get(cluster)
    if (cached && Date.now() - cached.at < 60000) return
    await this.crds(cluster)
  }

  /** CRD definitions themselves (`kubectl get crd`), shaped like other list rows. */
  async listCrds(cluster) {
    const result = await this.crds(cluster)
    if (!result.ok) return result
    const rows = result.crds.map((entry) => ({
      name: entry.name,
      namespace: null,
      created: entry.created,
      age: entry.age,
      status: entry.status,
      ready: entry.versions.join(','),
      version: entry.versions.join(', '),
      crdKind: entry.kind,
      crdGroup: entry.group,
      crdScope: entry.scope,
      plural: entry.plural,
      shortNames: entry.shortNames,
      extra: entry.shortNames.length > 0 ? entry.shortNames.join(', ') : '',
    }))
    return { ok: true, count: rows.length, rows }
  }

  /**
   * Role bindings of both scopes, cached briefly: the aggregated User/Group
   * views walk every binding, and switching between the two must not re-run
   * kubectl twice.
   */
  async rbacBindings(cluster, { refresh = false } = {}) {
    const cached = this.rbacCache.get(cluster)
    if (!refresh && cached && Date.now() - cached.at < 60000) return { ok: true, bindings: cached.bindings }
    const result = await this.kubectl(
      cluster,
      ['get', 'rolebindings.rbac.authorization.k8s.io,clusterrolebindings.rbac.authorization.k8s.io', '-A', '-o', 'json'],
      { timeoutMs: 60000 },
    )
    if (!result.ok) return result
    let parsed
    try { parsed = JSON.parse(result.stdout) } catch {
      return { ok: false, kind: 'error', error: 'kubectl 返回了非 JSON 输出' }
    }
    const bindings = (parsed.items || []).map((item) => ({
      kind: item.kind === 'ClusterRoleBinding' ? 'ClusterRoleBinding' : 'RoleBinding',
      name: item.metadata?.name || '',
      namespace: item.metadata?.namespace || '',
      roleKind: item.roleRef?.kind || '',
      role: item.roleRef?.name || '',
      subjects: item.subjects || [],
    }))
    this.rbacCache.set(cluster, { at: Date.now(), bindings })
    return { ok: true, bindings }
  }

  /**
   * One row per User (or Group) that appears as a binding subject, with the
   * roles it is bound to and the scopes those bindings live in. This is not a
   * Kubernetes resource: it is derived from RoleBinding/ClusterRoleBinding.
   */
  async listSubjectAggregates(cluster, subjectKind) {
    const loaded = await this.rbacBindings(cluster)
    if (!loaded.ok) return loaded
    const wanted = subjectKind === 'Group' ? 'Group' : 'User'
    const byName = new Map()
    for (const binding of loaded.bindings) {
      for (const subject of binding.subjects) {
        if (String(subject.kind) !== wanted || !subject.name) continue
        let entry = byName.get(subject.name)
        if (!entry) {
          entry = { name: subject.name, subjectKind: wanted, bindings: [] }
          byName.set(subject.name, entry)
        }
        entry.bindings.push(binding)
      }
    }
    const rows = [...byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const roles = [...new Set(entry.bindings.map((binding) => binding.role).filter(Boolean))]
        const scopes = [...new Set(entry.bindings.map((binding) => binding.namespace || '*'))]
        return {
          name: entry.name,
          subjectKind: entry.subjectKind,
          bindingCount: entry.bindings.length,
          roleList: roles.length <= 3 ? roles.join(', ') : `${roles.slice(0, 3).join(', ')} +${roles.length - 3}`,
          scopes: scopes.length <= 3 ? scopes.join(', ') : `${scopes.slice(0, 3).join(', ')} +${scopes.length - 3}`,
          status: '',
          created: '',
          age: '',
        }
      })
    return { ok: true, count: rows.length, rows }
  }

  /** Detail record of one aggregated subject, used by the YAML/describe panel. */
  async subjectRecord(cluster, subjectKind, resourceName) {
    const loaded = await this.rbacBindings(cluster)
    if (!loaded.ok) return loaded
    const wanted = subjectKind === 'Group' ? 'Group' : 'User'
    const bindings = []
    for (const binding of loaded.bindings) {
      for (const subject of binding.subjects) {
        if (String(subject.kind) === wanted && subject.name === resourceName) {
          bindings.push({
            type: binding.kind,
            namespace: binding.namespace || null,
            name: binding.name,
            roleRef: `${binding.roleKind}/${binding.role}`,
          })
        }
      }
    }
    if (bindings.length === 0) {
      return { ok: false, kind: 'not_found', error: `${wanted}「${resourceName}」没有出现在任何 RoleBinding/ClusterRoleBinding 中` }
    }
    const roles = [...new Set(bindings.map((binding) => binding.roleRef.split('/')[1]).filter(Boolean))]
    return { ok: true, record: { kind: wanted, name: resourceName, bindings, roles } }
  }

  /** Fall back to the full-object JSON path (events and unlisted kinds). */
  async listJson(cluster, kind, scope, selectorArgs) {
    const result = await this.kubectl(cluster, ['get', kind, ...scope, ...selectorArgs, '-o', 'json'], { timeoutMs: 60000 })
    if (!result.ok) return result
    let parsed
    try { parsed = JSON.parse(result.stdout) } catch {
      // Natural exec trigger (e.g. oidc-login) can write a browser URL / auth error
      // instead of JSON. Surface a clean needs-login instead of a confusing parse error.
      if (/could not open the browser|authcode|please visit the following url|exec plugin/.test(String(result.stdout + result.stderr).toLowerCase())) {
        this.auth.set(cluster, { state: 'needs-login', at: Date.now() })
        return { ok: false, kind: 'needs-login', error: '登录已过期，请重新登录', hint: hintFor('needs-login') }
      }
      return { ok: false, kind: 'error', error: 'kubectl 返回了非 JSON 输出' }
    }
    const info = this.crdInfo(cluster, kind)
    const rows = (parsed.items || []).map((item) => decorateCustomRow(rowOf(kind, item), item, info))
    return { ok: true, count: rows.length, rows }
  }

  async list(cluster, kind, { namespace, allNamespaces, selector } = {}) {
    const scope = allNamespaces ? ['-A'] : scopeArgs(kind, namespace)
    const selectorArgs = selector ? ['-l', selector] : []
    const base = String(kind).split('.')[0].toLowerCase()
    const spec = TABLE_COLS[base]

    // Nodes need data the tabular output lacks (capacity CPU/mem, arch label,
    // pod count), so fetch them as JSON and enrich each row.
    if (base === 'nodes') {
      return this.listNodes(cluster)
    }

    // CRD definitions get their own shaped rows (kind/group/scope/versions).
    if (base === 'customresourcedefinitions' || base === 'crds') {
      return this.listCrds(cluster)
    }

    // User/Group are RBAC subjects, not resources: aggregate them from bindings.
    if (base === 'rbacusers' || base === 'rbacgroups') {
      return this.listSubjectAggregates(cluster, base === 'rbacgroups' ? 'Group' : 'User')
    }

    // Custom resources are parsed from JSON, which needs the CRD index for the
    // declared printer columns; load it before the first such listing.
    if (isCustomResourceKind(kind)) {
      await this.ensureCrds(cluster)
    }

    // Tabular path for common kinds: output is ~100x smaller than `-o json`, so
    // huge collections (pods/secrets across all namespaces) no longer exceed the
    // MAX_STDOUT buffer and no longer need a 24MB JSON parse.
    if (spec) {
      const result = await this.kubectl(
        cluster,
        ['get', kind, ...scope, ...selectorArgs, ...(spec.wide ? ['-o', 'wide'] : [])],
        { timeoutMs: 30000 },
      )
      if (!result.ok) return result
      const keywords = []
      if (spec.namespaced && allNamespaces) keywords.push('NAMESPACE')
      keywords.push(...spec.cols)
      const cellsList = splitTable(result.stdout, keywords)
      if (cellsList) {
        const rows = cellsList.map((cells) => tabRowOf(kind, cells, keywords, allNamespaces, namespace))
        return { ok: true, count: rows.length, rows }
      }
      // header not found (no resources / different output) → fall back to JSON
      return this.listJson(cluster, kind, scope, selectorArgs)
    }
    return this.listJson(cluster, kind, scope, selectorArgs)
  }

  async listNodes(cluster) {
    const result = await this.kubectl(cluster, ['get', 'nodes', '-o', 'json'], { timeoutMs: 30000 })
    if (!result.ok) return result
    let parsed
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return { ok: false, kind: 'error', error: 'kubectl 返回了非 JSON 输出' }
    }
    const rows = (parsed.items || []).map((item) => rowOf('nodes', item))
    // Per-node capacity totals (CPU/memory/pods). We read the machine's *real*
    // capacity from status.capacity — NOT status.allocatable, which subtracts
    // kube-reserved/system-reserved/eviction overhead and is therefore never a
    // clean power of 2. The capacity is rounded to the nearest power of two so
    // a node advertised as "32G / 8 cores" reads 32Gi / 8.
    const cap = {}
    for (const item of parsed.items || []) {
      const c = (item.status && item.status.capacity) || {}
      cap[item.metadata.name] = {
        cpu: cpuToMills(c.cpu),
        memory: memToBytes(c.memory),
        pods: parseInt(c.pods || '0', 10) || 0,
      }
    }
    // Aggregate per-node pod count + summed CPU/memory requests (all namespaces).
    const pods = await this.kubectl(cluster, ['get', 'pods', '-A', '-o', 'json'], { timeoutMs: 60000 })
    if (pods.ok) {
      let podJson = null
      try { podJson = JSON.parse(pods.stdout) } catch { podJson = null }
      const used = {}
      if (podJson && Array.isArray(podJson.items)) {
        for (const pod of podJson.items) {
          const node = pod.spec && pod.spec.nodeName
          if (!node) continue
          const entry = used[node] || (used[node] = { count: 0, cpu: 0, memory: 0 })
          entry.count += 1
          for (const c of (pod.spec && pod.spec.containers) || []) {
            const r = (c.resources && c.resources.requests) || {}
            entry.cpu += cpuToMills(r.cpu)
            entry.memory += memToBytes(r.memory)
          }
        }
      }
      for (const r of rows) {
        const a = cap[r.name] || { cpu: 0, memory: 0, pods: 0 }
        const u = used[r.name] || { count: 0, cpu: 0, memory: 0 }
        r.cpu = `${fmtCpu(u.cpu)}/${fmtCpuCapacity(a.cpu)}`
        r.memory = `${fmtMem(u.memory)}/${fmtMemCapacity(a.memory)}`
        r.podCount = `${u.count}/${a.pods}`
      }
    }
    return { ok: true, count: rows.length, rows }
  }

  async objectYaml(cluster, kind, resourceName, namespace, { raw = false, forEdit = false } = {}) {
    const base = String(kind).split('.')[0].toLowerCase()
    if (forEdit) {
      // The editor starts from a manifest that kubectl apply accepts cleanly:
      // server-populated metadata and the status block are dropped. Secret
      // `data` is shown **decoded as plaintext** (per user preference); on save
      // the apply path re-encodes it via `stringData`, so the editor never has
      // to deal with base64 blobs.
      const command = ['get', kind, resourceName, ...scopeArgs(kind, namespace), '-o', 'json']
      const fetched = await this.kubectl(cluster, command, { timeoutMs: 30000 })
      if (!fetched.ok) return fetched
      let obj
      try { obj = JSON.parse(fetched.stdout) } catch { return { ok: false, kind: 'error', error: 'kubectl 返回了非 JSON 输出' } }
      delete obj.status
      if (obj.metadata && typeof obj.metadata === 'object') {
        for (const field of ['managedFields', 'resourceVersion', 'uid', 'generation', 'creationTimestamp', 'selfLink']) {
          delete obj.metadata[field]
        }
      }
      if (base === 'secrets' && obj.data && typeof obj.data === 'object') {
        for (const key of Object.keys(obj.data)) {
          try {
            obj.data[key] = Buffer.from(String(obj.data[key] || ''), 'base64').toString('utf8')
          } catch { /* keep the original value if decoding fails */ }
        }
      }
      return { ok: true, yaml: jsYaml.dump(obj, YAML_DUMP_OPTS) }
    }
    if (base === 'rbacusers' || base === 'rbacgroups') {
      const record = await this.subjectRecord(cluster, base === 'rbacgroups' ? 'Group' : 'User', resourceName)
      if (!record.ok) return record
      return { ok: true, yaml: jsYaml.dump(record.record, YAML_DUMP_OPTS) }
    }
    if (base === 'secrets') {
      // Secrets carry their payload as base64 in `data`. Fetch the object as
      // JSON, decode every `data` entry to UTF-8 text, then re-emit as YAML so
      // the detail panel shows the real values (including multi-line ones,
      // rendered as `|`/`|-` block scalars) instead of the encoded blobs.
      // `raw` returns the untouched object instead: the editor must start from a
      // manifest kubectl apply accepts, and decoded text is not valid base64.
      if (!raw) {
        const args = ['get', kind, resourceName, ...scopeArgs(kind, namespace), '-o', 'json']
        const result = await this.kubectl(cluster, args, { timeoutMs: 30000 })
        if (!result.ok) return result
        try {
          const obj = JSON.parse(result.stdout)
          if (obj.metadata) delete obj.metadata.managedFields
          if (obj.data && typeof obj.data === 'object') {
            for (const key of Object.keys(obj.data)) {
              try {
                obj.data[key] = Buffer.from(String(obj.data[key] || ''), 'base64').toString('utf8')
              } catch { /* keep the original value if decoding fails */ }
            }
          }
          return { ok: true, yaml: jsYaml.dump(obj, YAML_DUMP_OPTS) }
        } catch (failure) {
          return { ok: false, kind: 'error', error: 'kubectl 返回了非 JSON 输出' }
        }
      }
    }
    const args = ['get', kind, resourceName, ...scopeArgs(kind, namespace), '-o', 'yaml']
    const result = await this.kubectl(cluster, args, { timeoutMs: 30000 })
    if (!result.ok) return result
    const text = stripManagedFields(result.stdout)
    return { ok: true, yaml: text }
  }

  /**
   * Apply an edited manifest with `kubectl apply -f -`. This is the write path
   * behind the detail pane's YAML editor: it takes the whole document from the
   * user, so a failed apply returns kubectl's own message untouched (schema
   * errors, RBAC denials, immutable field conflicts) for the UI to show.
   */
  async applyYaml(cluster, manifest, { namespace } = {}) {
    const text = String(manifest || '')
    if (!/\bapiVersion\s*:/.test(text) || !/\bkind\s*:/.test(text)) {
      return { ok: false, kind: 'invalid', error: '内容不像 Kubernetes 资源（缺少 apiVersion 或 kind）' }
    }
    // Secrets are edited in plaintext (the editor shows `data` decoded). Before
    // applying, move every `data` value into `stringData` so the API server
    // base64-encodes it server-side — this is the "encode on save" behaviour.
    let payload = text
    const parsed = safeParseYaml(text)
    if (parsed && String(parsed.kind || '').toLowerCase() === 'secret'
        && (parsed.data && typeof parsed.data === 'object')) {
      parsed.stringData = { ...(parsed.stringData || {}), ...parsed.data }
      delete parsed.data
      payload = jsYaml.dump(parsed, YAML_DUMP_OPTS)
    }
    const args = ['apply', '-f', '-']
    if (namespace) args.push('-n', namespace)
    const result = await this.kubectl(cluster, args, { timeoutMs: 120000, input: payload })
    if (!result.ok) return result
    return { ok: true, text: String(result.stdout || '').trim() || '(applied)' }
  }

  async describe(cluster, kind, resourceName, namespace) {
    const base = String(kind).split('.')[0].toLowerCase()
    if (base === 'rbacusers' || base === 'rbacgroups') {
      const record = await this.subjectRecord(cluster, base === 'rbacgroups' ? 'Group' : 'User', resourceName)
      if (!record.ok) return record
      const { record: subject } = record
      const lines = [
        `Name:         ${subject.name}`,
        `Subject:      ${subject.kind}`,
        `Roles:        ${subject.roles.join(', ') || '—'}`,
        `Bindings:     ${subject.bindings.length}`,
        '',
        'Bindings:',
      ]
      for (const binding of subject.bindings) {
        const where = binding.namespace ? `namespace/${binding.namespace}` : 'cluster-wide'
        lines.push(`  ${binding.type}/${binding.name} (${where}) → ${binding.roleRef}`)
      }
      return { ok: true, description: lines.join('\n') }
    }
    const args = ['describe', kind, resourceName, ...scopeArgs(kind, namespace)]
    const result = await this.kubectl(cluster, args, { timeoutMs: 40000 })
    if (!result.ok) return result
    return { ok: true, description: tail(result.stdout, 16000) }
  }

  /**
   * The policy rules of a Role/ClusterRole, returned as a structured list (one
   * item per rule) for the K9S-style rules panel. Each rule carries the api
   * groups, resources, verbs, optional resource names and non-resource URLs.
   */
  async rulesOf(cluster, kind, name, namespace) {
    const base = String(kind).split('.')[0].toLowerCase()
    if (base !== 'roles' && base !== 'clusterroles') {
      return { ok: false, kind: 'invalid', error: `不支持读取 ${base} 的规则` }
    }
    const result = await this.kubectl(cluster, ['get', kind, name, ...scopeArgs(kind, namespace), '-o', 'json'], { timeoutMs: 30000 })
    if (!result.ok) return result
    let obj
    try { obj = JSON.parse(result.stdout) } catch { return { ok: false, kind: 'error', error: 'kubectl 返回了非 JSON 输出' } }
    const rules = (obj.rules || []).map((rule) => ({
      verbs: rule.verbs || [],
      apiGroups: rule.apiGroups || [],
      resources: rule.resources || [],
      resourceNames: rule.resourceNames || [],
      nonResourceURLs: rule.nonResourceURLs || [],
    }))
    return { ok: true, kind: base, name, rules }
  }

  /**
   * Return the pod names owned by a workload (deployment/statefulset/daemonset/
   * job). The pods a workload runs are the ones matching its `spec.selector
   * .matchLabels` (for a deployment those are the pod-template labels the
   * ReplicaSet also carries). We fetch the workload object, read that label
   * map, then list pods with `-l k=v,...`. Falls back to "all pods in the
   * namespace" when the workload carries no selector.
   */
  async podsOf(cluster, kind, resourceName, namespace) {
    const base = String(kind).split('.')[0].toLowerCase()
    const ns = namespace && namespace !== '' ? namespace : 'default'
    const selResult = await this.kubectl(cluster, ['get', kind, resourceName, ...scopeArgs(kind, ns), '-o', 'json'], { timeoutMs: 30000 })
    if (!selResult.ok) return selResult
    let labels = {}
    try {
      const obj = JSON.parse(selResult.stdout)
      labels = (obj.spec && obj.spec.selector && obj.spec.selector.matchLabels) || {}
    } catch { labels = {} }
    const pairs = Object.keys(labels).map((k) => `${k}=${labels[k]}`)
    const args = ['get', 'pods', ...scopeArgs('pods', ns)]
    if (pairs.length) args.push('-l', pairs.join(','))
    args.push('-o', 'name')
    const result = await this.kubectl(cluster, args, { timeoutMs: 30000 })
    if (!result.ok) return result
    const pods = String(result.stdout || '').split('\n')
      .map((s) => s.trim().replace(/^pod\//, ''))
      .filter((s) => s !== '')
    return { ok: true, pods, namespace: ns }
  }

  /**
   * One mutating workload operation from the resource list's 操作 dropdown:
   * `restart` / `undo` / `status` (kubectl rollout), `scale` (kubectl scale) and
   * `delete`. Validation lives here rather than in the route so the panel, the
   * agent tools and any future caller get the same refusals and wording.
   */
  async workloadAction(cluster, input = {}) {
    const kind = String(input.kind || '')
    const base = kind.split('.')[0].toLowerCase()
    const workload = { deployments: 'deployment', statefulsets: 'statefulset', daemonsets: 'daemonset' }[base]
    if (!workload) return { ok: false, kind: 'invalid', error: `不支持对 ${kind || '该资源'} 执行操作` }
    const resourceName = String(input.name || '').trim()
    if (!resourceName) return { ok: false, kind: 'invalid', error: '缺少资源名称' }
    const action = String(input.action || '').trim()
    if (!['restart', 'undo', 'scale', 'delete'].includes(action)) {
      return { ok: false, kind: 'invalid', error: `未知操作「${action}」` }
    }
    const namespace = input.namespace && input.namespace !== '' ? String(input.namespace) : 'default'
    const target = `${workload}/${resourceName}`
    // A DaemonSet runs exactly one pod per node: there are no replicas to change.
    if (action === 'scale' && base === 'daemonsets') {
      return { ok: false, kind: 'invalid', error: 'DaemonSet 每台节点固定一个 Pod，没有副本数可以扩缩' }
    }
    let replicas = null
    if (action === 'scale') {
      replicas = Number(input.replicas)
      if (!Number.isInteger(replicas) || replicas < 0) {
        return { ok: false, kind: 'invalid', error: '副本数必须是非负整数' }
      }
    }
    const args = {
      restart: ['rollout', 'restart', target, '-n', namespace],
      // undo with no revision rolls back to the previous one; the dialog fetches
      // rollout history and passes a chosen revision via --to-revision.
      undo: ['rollout', 'undo', target, '-n', namespace, ...(Number.isInteger(input.revision) ? ['--to-revision', String(input.revision)] : [])],
      scale: ['scale', target, '-n', namespace, '--replicas', String(replicas)],
      // --wait=false: a workload delete can block for minutes while pods drain;
      // the API call only needs the deletion accepted, not completed.
      delete: ['delete', target, '-n', namespace, '--wait=false'],
    }[action]
    const result = await this.kubectl(cluster, args, { timeoutMs: 60000 })
    if (!result.ok) return result
    return {
      ok: true,
      action,
      replicas,
      text: String(result.stdout || '').trim() || '(done)',
    }
  }

  /**
   * Delete any kind of object by name. Namespaced kinds get `-n <namespace>`;
   * cluster-scoped kinds (node, namespace, clusterrole, CRD, …) are deleted
   * without a namespace flag. RBAC users/groups are pseudo-rows aggregated from
   * binding subjects, not real objects, so they have nothing to delete. The
   * kubectl error (if any) is surfaced verbatim.
   */
  async deleteResource(cluster, kind, name, namespace) {
    const base = String(kind || '').split('.')[0].toLowerCase()
    if (base === 'rbacusers' || base === 'rbacgroups') {
      return { ok: false, kind: 'invalid', error: '用户/组是从绑定聚合出来的，没有可删除的实体对象' }
    }
    if (!String(name || '').trim()) return { ok: false, kind: 'invalid', error: '缺少资源名称' }
    const clusterScoped = CLUSTER_SCOPED.has(base)
    if (!clusterScoped && (!namespace || String(namespace).trim() === '')) {
      return { ok: false, kind: 'invalid', error: '命名空间类资源必须指定 namespace' }
    }
    const scope = clusterScoped ? [] : ['-n', String(namespace)]
    const result = await this.kubectl(cluster, ['delete', `${kind}/${name}`, ...scope, '--wait=false'], { timeoutMs: 60000 })
    if (!result.ok) return result
    return { ok: true, text: String(result.stdout || '').trim() || '(deleted)' }
  }

  /**
   * Node scheduling operations: cordon / uncordon / drain. These are
   * cluster-scoped (no namespace). `drain` uses conservative flags that let a
   * DaemonSet stay and force-remove emptydir data; kubectl's own refusal (pods
   * with local storage, unmanaged pods, …) is surfaced verbatim. This is a
   * destructive, real-cluster operation — callers must confirm first.
   */
  async nodeAction(cluster, node, action) {
    const name = String(node || '').trim()
    if (!name) return { ok: false, kind: 'invalid', error: '缺少节点名称' }
    if (!['cordon', 'uncordon', 'drain'].includes(action)) {
      return { ok: false, kind: 'invalid', error: `未知操作「${action}」` }
    }
    const args = action === 'drain'
      ? ['drain', name, '--ignore-daemonsets', '--delete-emptydir-data']
      : [action, name]
    const result = await this.kubectl(cluster, args, { timeoutMs: action === 'drain' ? 180000 : 30000 })
    if (!result.ok) return result
    const verb = { cordon: '已封锁', uncordon: '已解封', drain: '已排空' }[action]
    return { ok: true, action, text: String(result.stdout || '').trim() || `节点 ${name} ${verb}` }
  }

  /**
   * List the rollout revisions of a workload (deployment/statefulset/daemonset),
   * parsing `kubectl rollout history` into {revision, cause} sorted ascending so
   * the rollback dialog can offer a concrete revision to jump to.
   */
  async rolloutHistory(cluster, kind, name, namespace) {
    const base = String(kind || '').split('.')[0].toLowerCase()
    const workload = { deployments: 'deployment', statefulsets: 'statefulset', daemonsets: 'daemonset' }[base]
    if (!workload) return { ok: false, kind: 'invalid', error: `不支持对 ${kind || '该资源'} 查看回滚版本` }
    if (!String(name || '').trim()) return { ok: false, kind: 'invalid', error: '缺少资源名称' }
    const ns = namespace && namespace !== '' ? String(namespace) : 'default'
    const result = await this.kubectl(cluster, ['rollout', 'history', `${workload}/${name}`, '-n', ns], { timeoutMs: 30000 })
    if (!result.ok) return result
    const revisions = []
    for (const rawLine of String(result.stdout || '').split('\n')) {
      const line = rawLine.trim()
      // Skip the "deployment.apps/<name>" title and the "REVISION  CHANGE-CAUSE"
      // header; every remaining line is "<n>  <change-cause>".
      const m = /^(\d+)\s+(.*)$/.exec(line)
      if (m) revisions.push({ revision: Number(m[1]), cause: (m[2] || '').trim() })
    }
    revisions.sort((a, b) => a.revision - b.revision)
    return { ok: true, revisions, text: String(result.stdout || '').trim() }
  }

  /**
   * Return the containers of a single pod (regular + init), with a light
   * status (ready / restarts / state) so the expandable pod row can render a
   * per-container sub-list without shipping the whole pod object.
   */
  async containers(cluster, pod, namespace) {
    const ns = namespace && namespace !== '' ? namespace : 'default'
    const result = await this.kubectl(cluster, ['get', 'pods', pod, ...scopeArgs('pods', ns), '-o', 'json'], { timeoutMs: 30000 })
    if (!result.ok) return result
    let obj
    try { obj = JSON.parse(result.stdout) } catch {
      return { ok: false, kind: 'error', error: 'kubectl 返回了非 JSON 输出' }
    }
    const statusByName = {}
    const statuses = (obj.status && obj.status.containerStatuses) || []
    const initStatuses = (obj.status && obj.status.initContainerStatuses) || []
    for (const cs of [...statuses, ...initStatuses]) {
      statusByName[cs.name] = {
        ready: cs.ready,
        restarts: cs.restartCount || 0,
        state: containerStateOf(cs.state || {}),
        age: humanAge(startedAtOf(cs.state || {})),
      }
    }
    const collect = (list, init) => (list || []).map((c) => {
      const st = statusByName[c.name] || { ready: false, restarts: 0, state: '—', age: '' }
      return { name: c.name, image: c.image || '', ready: st.ready, restarts: st.restarts, state: st.state, age: st.age || '', init }
    })
    const containers = collect(obj.spec && obj.spec.containers, false)
    const initContainers = collect(obj.spec && obj.spec.initContainers, true)
    return { ok: true, containers, initContainers, namespace: ns }
  }

  // ---- container shell (kubectl exec) -------------------------------------

  /**
   * Pick the shell a container offers: bash when the image has it, else sh,
   * else null. The probe runs the shell's own `-c` so a distroless image that
   * has neither binary fails cleanly instead of leaving a dead session behind.
   */
  async detectShell(cluster, namespace, pod, container) {
    const file = this.clusterFile(cluster)
    if (!fs.existsSync(file)) throw new Error(`集群 "${cluster}" 不存在`)
    const ctx = await this.targetContextFor(cluster)
    const args = ['--kubeconfig', file, '--context', ctx, '--cache-dir', this.cacheDir, 'exec', pod, '-n', namespace, '-c', container, '--']
    for (const shell of ['bash', 'sh']) {
      const result = await this.run([...args, shell, '-c', 'echo __dsh_kube_shell__'], { timeoutMs: 15000 })
      if (result.code === 0 && String(result.stdout).includes('__dsh_kube_shell__')) return shell
    }
    return null
  }

  /** Buffer a chunk for whoever is streaming this shell and fan it out. */
  pushShellOutput(session, text) {
    if (!text) return
    session.output += text
    // Keep the last ~512 KiB reachable; drop the head only when it grows past
    // that so a long-running `tail -f` cannot grow the host process forever.
    if (session.output.length > 512 * 1024) {
      const drop = session.output.length - 256 * 1024
      session.output = session.output.slice(drop)
      session.dropped += drop
    }
    for (const listener of session.listeners) {
      try { listener.onData(text) } catch {}
    }
  }

  /**
   * Start a real interactive shell in one container. `kubectl exec -it` is
   * spawned under a PTY (node-pty, shipped with the harness), so the container
   * gets a genuine tty: prompt, echo, colours, line editing, Ctrl-C and
   * full-screen programs all behave like a terminal. The browser half renders
   * the byte stream with xterm.js and reports its size back for resizing.
   */
  async startShell(cluster, input = {}) {
    const pod = String(input.pod || '').trim()
    const container = String(input.container || '').trim()
    if (!pod || !container) return { ok: false, kind: 'bad-request', error: '缺少 pod 或 container' }
    const pty = loadPty()
    if (!pty) {
      return { ok: false, kind: 'no-pty', error: 'PTY 支持不可用（找不到 node-pty），无法打开交互式 shell' }
    }
    const namespace = input.namespace && input.namespace !== '' ? String(input.namespace) : 'default'
    const file = this.clusterFile(cluster)
    if (!fs.existsSync(file)) return { ok: false, kind: 'not_found', error: `集群 "${cluster}" 不存在` }
    let ctx
    try { ctx = await this.targetContextFor(cluster) } catch (error) {
      return { ok: false, kind: 'error', error: String(error?.message || error) }
    }
    let shell = null
    try {
      shell = await this.detectShell(cluster, namespace, pod, container)
    } catch (error) {
      return { ok: false, kind: 'error', error: String(error?.message || error) }
    }
    if (!shell) {
      return {
        ok: false,
        kind: 'no-shell',
        error: `容器「${container}」里既没有 bash，也没有 sh，无法打开 shell`,
        pod, container, namespace,
      }
    }
    const cols = clampCols(input.cols)
    const rows = clampRows(input.rows)
    // -i keeps stdin open, -t allocates the remote tty; the local side is a real
    // PTY so kubectl itself sees a terminal and forwards window size changes.
    const args = ['--kubeconfig', file, '--context', ctx, '--cache-dir', this.cacheDir, 'exec', '-it', pod, '-n', namespace, '-c', container, '--', shell, '-i']
    const id = `sh-${(this.shellSeq += 1)}-${Date.now().toString(36)}`
    let term
    try {
      term = pty.spawn(this.kubectlBin, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.home,
        env: { ...this.env(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      })
    } catch (error) {
      return { ok: false, kind: 'error', error: String(error?.message || error) }
    }
    const session = {
      id, term, cluster, namespace, pod, container, shell,
      output: '', dropped: 0, listeners: new Set(), closed: false, exitCode: null,
    }
    this.shells.set(id, session)
    term.onData((chunk) => this.pushShellOutput(session, chunk))
    const done = (code) => {
      if (session.closed && session.exitCode !== null) return
      session.closed = true
      if (session.exitCode === null) session.exitCode = typeof code === 'number' ? code : null
      for (const listener of [...session.listeners]) {
        try { listener.onClose(session) } catch {}
      }
      session.listeners.clear()
      // Keep the buffer around briefly so a reconnecting pane can read the last
      // lines, then drop the dead session.
      setTimeout(() => { this.shells.delete(id) }, 60000).unref?.()
    }
    term.onExit(({ exitCode }) => done(exitCode))
    return {
      ok: true,
      id, shell, pod, container, namespace,
      cols, rows,
      banner: `kubectl exec -it ${pod} -n ${namespace} -c ${container} -- ${shell}`,
    }
  }

  /** Forward raw keystrokes (or a pasted block) into the pty. */
  shellInput(id, data) {
    const session = this.shells.get(String(id || ''))
    if (!session) return { ok: false, kind: 'not_found', error: 'shell 会话已结束' }
    if (session.closed) return { ok: false, kind: 'closed', error: 'shell 已退出' }
    try {
      session.term.write(String(data ?? ''))
      return { ok: true }
    } catch (error) {
      return { ok: false, kind: 'error', error: String(error?.message || error) }
    }
  }

  /** Apply the browser terminal's size so full-screen programs lay out right. */
  shellResize(id, cols, rows) {
    const session = this.shells.get(String(id || ''))
    if (!session) return { ok: false, kind: 'not_found', error: 'shell 会话已结束' }
    if (session.closed) return { ok: false, kind: 'closed', error: 'shell 已退出' }
    const nextCols = clampCols(cols)
    const nextRows = clampRows(rows)
    try {
      session.term.resize(nextCols, nextRows)
      return { ok: true, cols: nextCols, rows: nextRows }
    } catch (error) {
      return { ok: false, kind: 'error', error: String(error?.message || error) }
    }
  }

  /** Close the shell tab: kill the kubectl exec process tree and forget it. */
  stopShell(id) {
    const key = String(id || '')
    const session = this.shells.get(key)
    if (!session) return { ok: true, stopped: false }
    session.closed = true
    try { session.term.kill() } catch {}
    for (const listener of [...session.listeners]) {
      try { listener.onClose(session) } catch {}
    }
    session.listeners.clear()
    this.shells.delete(key)
    return { ok: true, stopped: true }
  }

  // ---- port forwarding ----------------------------------------------------

  /**
   * Ports declared by every pod in the current scope, keyed `namespace/name` and
   * shaped `{ port, name, protocol }` (name is '' when the manifest has none).
   * A single jsonpath call keeps this cheap: it prints one short line per pod,
   * so the pod table can show the ports without parsing whole pod specs.
   */
  async podPorts(cluster, { namespace, allNamespaces } = {}) {
    const template = '{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{" "}'
      + '{range .spec.containers[*].ports[*]}{.containerPort}{":"}{.name}{":"}{.protocol}{","}{end}{"\\n"}{end}'
    const args = ['get', 'pods', ...(allNamespaces ? ['-A'] : scopeArgs('pods', namespace)), '-o', `jsonpath=${template}`]
    const result = await this.kubectl(cluster, args, { timeoutMs: 20000 })
    if (!result.ok) return result
    const ports = {}
    for (const line of String(result.stdout).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const space = trimmed.indexOf(' ')
      const key = space === -1 ? trimmed : trimmed.slice(0, space)
      const rest = space === -1 ? '' : trimmed.slice(space + 1)
      ports[key] = rest.split(',')
        .filter((entry) => entry !== '')
        .map((entry) => {
          const [port, name, protocol] = entry.split(':')
          return { port: Number(port), name: name || '', protocol: protocol || 'TCP' }
        })
        .filter((entry) => Number.isInteger(entry.port))
    }
    return { ok: true, ports }
  }

  /** Wire shape of one forward (never leaks the child process handle). */
  publicForward(forward) {
    return {
      id: forward.id,
      cluster: forward.cluster,
      namespace: forward.namespace,
      pod: forward.pod,
      port: forward.port,
      localPort: forward.localPort,
      startedAt: forward.startedAt,
      url: `http://127.0.0.1:${forward.localPort}`,
    }
  }

  listForwards() {
    return [...this.forwards.values()].map((forward) => this.publicForward(forward))
  }

  /**
   * Start `kubectl port-forward pod/<name> <local>:<remote>` on 127.0.0.1 and
   * resolve once kubectl reports the forward is listening. A pod port is
   * forwarded at most once: a second attempt returns the running mapping so the
   * UI can show it instead of spawning a duplicate listener.
   */
  async startForward({ cluster, pod, namespace, port, localPort }) {
    const name = safeName(cluster)
    const file = this.clusterFile(name)
    if (!fs.existsSync(file)) throw new Error(`集群 "${name}" 不存在`)
    const podName = String(pod || '').trim()
    if (!podName) throw new Error('缺少 pod 名称')
    const ns = namespace && namespace !== '' ? String(namespace) : 'default'
    const remote = Number(port)
    const local = Number(localPort)
    if (!Number.isInteger(remote) || remote < 1 || remote > 65535) throw new Error('目标端口无效')
    if (!Number.isInteger(local) || local < 1 || local > 65535) throw new Error('本地端口无效（1-65535）')
    const key = `${name}|${ns}|${podName}|${remote}`
    const existing = [...this.forwards.values()].find((forward) => forward.key === key)
    if (existing) {
      return { ok: false, error: `${podName} 的 ${remote} 端口已转发到本地 ${existing.localPort}`, forward: this.publicForward(existing) }
    }
    const ctx = await this.targetContextFor(name)
    const args = [
      '--kubeconfig', file, '--context', ctx, '--cache-dir', this.cacheDir,
      '-n', ns, 'port-forward', `pod/${podName}`, `${local}:${remote}`, '--address', '127.0.0.1',
    ]
    let child
    try {
      child = spawn(this.kubectlBin, args, { env: this.env(), cwd: this.home, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (error) {
      throw new Error(String(error?.message || error))
    }
    return await new Promise((resolve) => {
      let settled = false
      let output = ''
      const finish = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.removeAllListeners('data')
        child.stderr.removeAllListeners('data')
        // kubectl keeps writing "Handling connection for ..." for as long as the
        // forward lives; keep both pipes drained or a full pipe eventually
        // blocks it (and the forward silently stops answering).
        child.stdout.resume()
        child.stderr.resume()
        resolve(payload)
      }
      const timer = setTimeout(() => {
        killTree(child)
        finish({ ok: false, error: `端口转发超时（kubectl 20 秒内未就绪）${output ? `：${tail(cleanStderr(output), 400)}` : ''}` })
      }, 20000)
      const onOutput = (chunk) => {
        output += chunk
        // kubectl reports readiness as "Forwarding from 127.0.0.1:18080 -> 8080";
        // which stream carries that line depends on the kubectl build, so watch both.
        const match = /Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+) -> \d+/.exec(output)
        if (!match || settled) return
        const id = `pf-${++this.forwardSeq}`
        // kubectl keeps running for the life of the forward: watch its exit so a
        // dead pod or a killed process drops the mapping instead of lying to the UI.
        child.removeAllListeners('close')
        child.on('close', () => {
          const current = this.forwards.get(id)
          if (current && current.child === child) this.forwards.delete(id)
        })
        const forward = {
          id, key, cluster: name, namespace: ns, pod: podName,
          port: remote, localPort: Number(match[1]), startedAt: Date.now(), child,
        }
        this.forwards.set(id, forward)
        finish({ ok: true, forward: this.publicForward(forward) })
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', onOutput)
      child.stderr.on('data', onOutput)
      child.on('error', (error) => finish({ ok: false, error: String(error?.message || error) }))
      child.on('close', (code) => {
        finish({ ok: false, error: `端口转发启动失败（kubectl 退出码 ${code}）${output ? `：${tail(cleanStderr(output), 400)}` : ''}` })
      })
    })
  }

  stopForward(id) {
    const forward = this.forwards.get(String(id || ''))
    if (!forward) return { ok: false, error: '该端口转发不存在（可能已结束）' }
    this.forwards.delete(forward.id)
    killTree(forward.child)
    return { ok: true, stopped: forward.id }
  }

  /**
   * Translate a resource row into the `kubectl logs` target plus the extra
   * flags it needs. A workload (deployment/statefulset/daemonset) stands for
   * many pods: `--all-pods=true` is what makes kubectl print all of them, and
   * that in turn needs `--max-log-requests` raised above kubectl's default cap
   * of 5 — otherwise following 6+ streams aborts with "maximum allowed
   * concurrency is 5". The cap is derived from the workload's own status so a
   * daemonset on a large cluster still works.
   */
  async logsTarget(cluster, kind, resourceName, namespace) {
    const base = String(kind || 'pods').split('.')[0].toLowerCase()
    const kindWord = base === 'deployments' ? 'deployment'
      : base === 'statefulsets' ? 'statefulset'
      : base === 'daemonsets' ? 'daemonset'
      : null
    if (!kindWord) return { target: String(resourceName), extra: [] }
    // Desired pod count, in one cheap jsonpath call. On failure keep a
    // generous fallback so the stream is attempted rather than refused.
    let pods = 50
    const field = base === 'daemonsets' ? '{.status.desiredNumberScheduled}' : '{.status.replicas}'
    const probe = await this.kubectl(
      cluster,
      ['get', base, resourceName, ...scopeArgs(base, namespace), '-o', `jsonpath=${field}`],
      { timeoutMs: 10000 },
    )
    if (probe.ok) {
      const parsed = Number(String(probe.stdout || '').trim())
      if (Number.isFinite(parsed) && parsed > 0) pods = parsed
    }
    // Double the count: during a rollout old and new pods both match the
    // workload selector, so the live stream count can exceed the desired one.
    const maxRequests = Math.max(5, Math.round(pods) * 2)
    return {
      target: `${kindWord}/${resourceName}`,
      extra: ['--all-pods=true', `--max-log-requests=${maxRequests}`],
    }
  }

  async logs(cluster, pod, { namespace, container, since, previous, kind } = {}) {
    // Forward (chronological) output from the beginning; no `--tail`.
    // `pod` may also be a workload selector ("deployment/api"), which expands
    // to every pod of that workload.
    const [maybeKind, ...rest] = String(pod || '').split('/')
    const kindBase = rest.length > 0 ? maybeKind : (kind || 'pods')
    const resourceName = rest.length > 0 ? rest.join('/') : pod
    const { target, extra } = await this.logsTarget(cluster, kindBase, resourceName, namespace)
    const args = ['logs', target, ...extra, ...scopeArgs('pods', namespace)]
    if (container) args.push('-c', container)
    if (since) args.push('--since', since)
    if (previous) args.push('--previous')
    const result = await this.kubectl(cluster, args, { timeoutMs: 40000 })
    if (!result.ok) return result
    return { ok: true, logs: tail(result.stdout, 60000) }
  }

  // ---- auth probe --------------------------------------------------------

  /**
   * Probe whether a cluster needs a sign-in before resources can be read.
   * Returns loginable (whether the plugin can drive a login for this cluster)
   * and the resulting auth state. For plugin-driven (exec/OIDC) clusters a
   * lightweight kubectl call decides the current state; for others we only
   * report the configured auth kind and last known state.
   */
  /**
   * Fast OIDC token check: run the exec plugin's get-token with --skip-open-browser
   * and a short deadline. Returns { ok } quickly instead of letting kubectl hang on
   * the natural exec trigger (which waits for an authcode browser callback).
   */
  async checkOidcToken(cluster) {
    const name = safeName(cluster)
    const { user } = await this.userFor(name)
    const auth = describeAuth(user)
    if (!auth.login) return { ok: true, auth }
    const exec = user.exec
    const args = [...(Array.isArray(exec.args) ? exec.args : [])]
    args.push('--skip-open-browser')
    const extraEnv = {}
    if (Array.isArray(exec.env)) {
      for (const entry of exec.env) {
        const index = String(entry).indexOf('=')
        if (index > 0) extraEnv[String(entry).slice(0, index)] = String(entry).slice(index + 1)
      }
    }
    // Skip grant type entirely: with a cached token this returns instantly; without
    // one it hangs on authcode, which we treat as needs-login.
    // NOTE: `kubectl oidc-login` is a kubectl plugin — global flags (--kubeconfig,
    // --context) cannot be placed before the plugin name, so the plugin argv is run
    // as-is. Point it at the cluster's own kubeconfig via the KUBECONFIG env var
    // instead; without this it would probe the default ~/.kube/config (a different,
    // often valid token), falsely reporting ok and skipping the login button while
    // the real kubectl calls against this cluster fail with a needs-login error.
    const result = await this.run([...args], {
      timeoutMs: 6000,
      env: this.env({ KUBECONFIG: this.clusterFile(name) }),
    })
    if (result.code === 0) {
      try {
        JSON.parse(result.stdout)
        this.auth.set(name, { state: 'ok', at: Date.now() })
        return { ok: true, auth, state: 'ok' }
      } catch {
        // fall through to needs-login
      }
    }
    // A plugin killed by our deadline is the classic "the user must sign in"
    // signal: with a valid cached token `oidc-login get-token` returns instantly,
    // so a hang means it is waiting for an authcode (expired/absent token).
    // Report it as needs-login so the conversation view shows the login button.
    if (result.timedOut) {
      this.auth.set(name, { state: 'needs-login', message: 'auth check timed out', at: Date.now() })
      return { ok: false, auth, state: 'needs-login' }
    }
    this.auth.set(name, { state: 'needs-login', message: tail(result.stderr, 400), at: Date.now() })
    return { ok: false, auth, state: 'needs-login' }
  }

  async probe(cluster) {
    const name = safeName(cluster)
    const { user } = await this.userFor(name)
    const auth = describeAuth(user)
    const clusterUser = await this.clusterUser(name)
    if (!auth.login) {
      const st = this.auth.get(name) || { state: 'unknown' }
      const version = st.state === 'ok' ? await this.serverVersion(name) : ''
      return { ok: true, loginable: false, auth, state: st, user: clusterUser, version }
    }
    const check = await this.checkOidcToken(name)
    const ok = check.ok
    const version = ok ? await this.serverVersion(name) : ''
    return {
      ok: true,
      loginable: true,
      auth,
      state: ok ? { state: 'ok' } : { state: 'needs-login', message: check.auth.reason },
      user: clusterUser,
      version,
    }
  }

  /** Kubeconfig user-entry name used for a cluster (no network). */
  async clusterUser(cluster) {
    const name = safeName(cluster)
    try {
      const view = await this.clusterView(name)
      const ctx = this.targetContext(view)
      return ((view.contexts || []).find((entry) => entry.name === ctx)?.context || {}).user || ''
    } catch {
      return ''
    }
  }

  /** Best-effort server version (`kubectl version -o json`), cached 60s; requires auth. */
  async serverVersion(cluster) {
    const name = safeName(cluster)
    const cached = this.versions.get(name)
    if (cached && Date.now() - cached.at < 60000) return cached.value
    let version = ''
    try {
      const result = await this.kubectl(name, ['version', '-o', 'json'], { timeoutMs: 12000 })
      if (result.ok) {
        const parsed = JSON.parse(result.stdout)
        version = parsed?.serverVersion?.gitVersion || ''
      }
    } catch {}
    this.versions.set(name, { value: version, at: Date.now() })
    return version
  }

  // ---- login (OIDC via exec plugin) --------------------------------------

  publicSession(session) {
    if (!session) return null
    return {
      context: session.context,
      method: session.method,
      status: session.status,
      url: session.url,
      code: session.code,
      message: session.message,
      browserOpened: session.browserOpened,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    }
  }

  openInWindows(url) {
    if (!/^https?:\/\/[\w\-.:@/?=&%#~+]+$/.test(url)) return false
    const bin = this.findWindowsBrowser()
    if (!bin) return false
    try {
      const child = spawn(bin, [url], { cwd: '/mnt/c', detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return true
    } catch {
      return false
    }
  }

  // Find a Windows browser binary to open a URL from WSL. Prefer Chrome
  // (read from well-known per-user and program paths), fall back to Edge.
  findWindowsBrowser() {
    const usersRoot = '/mnt/c/Users'
    const candidates = [
      // Chrome under each Windows user profile
      ...this.listWindowsUsers(usersRoot).flatMap((u) => [
        `${usersRoot}/${u}/AppData/Local/Google/Chrome/Application/chrome.exe`,
        `${usersRoot}/${u}/AppData/Local/Chromium/Application/chrome.exe`,
        `${usersRoot}/${u}/AppData/Local/Google/Chrome SxS/Application/chrome.exe`,
      ]),
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files/Internet Explorer/iexplore.exe',
    ]
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p
    }
    // Fall back to cmd start if nothing direct is found.
    if (fs.existsSync(CMD_EXE)) return CMD_EXE
    return null
  }

  listWindowsUsers(usersRoot) {
    try {
      return fs.readdirSync(usersRoot).filter((d) => {
        if (d === 'Public' || d === 'Default' || d === 'All Users' || d === 'desktop.ini') return false
        try {
          return fs.statSync(`${usersRoot}/${d}`).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      return []
    }
  }

  async startLogin(cluster, method = 'browser') {
    const name = safeName(cluster)
    const existing = this.sessions.get(name)
    if (existing && (existing.status === 'starting' || existing.status === 'waiting')) return this.publicSession(existing)

    const { user } = await this.userFor(name)
    const auth = describeAuth(user)
    if (!auth.login) throw new Error(auth.reason || '这个集群不支持由插件发起登录')

    const exec = user.exec
    const args = [...(Array.isArray(exec.args) ? exec.args : [])]
    if (method === 'device') args.push('--grant-type=device-code', '--skip-open-browser')
    else if (method === 'keyboard') args.push('--grant-type=authcode-keyboard', '--skip-open-browser')
    else args.push('--skip-open-browser')

    const extraEnv = {}
    if (Array.isArray(exec.env)) {
      for (const entry of exec.env) {
        const index = String(entry).indexOf('=')
        if (index > 0) extraEnv[String(entry).slice(0, index)] = String(entry).slice(index + 1)
      }
    }

    const session = {
      context: name,
      method,
      status: 'starting',
      url: null,
      code: null,
      message: null,
      browserOpened: false,
      startedAt: Date.now(),
      endedAt: null,
      proc: null,
      log: '',
    }
    this.sessions.set(name, session)

    let child
    try {
      child = spawn(String(exec.command), args, { env: this.env(extraEnv), cwd: this.home, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      session.status = 'failed'
      session.message = String(error?.message || error)
      session.endedAt = Date.now()
      throw error
    }
    session.proc = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    const observe = (chunk) => {
      session.log = tail(session.log + String(chunk), 12000)
      if (session.url) return
      // Scan the accumulated log: one URL can be split across chunks.
      const match = session.log.match(/https?:\/\/[^\s"'<>]+/)
      if (!match) return
      session.url = match[0]
      session.status = 'waiting'
      const code = /[?&]user_code=([A-Za-z0-9-]+)/.exec(session.url)
      if (code) session.code = code[1]
      session.browserOpened = this.openInWindows(session.url)
    }
    child.stdout.on('data', observe)
    child.stderr.on('data', observe)

    const timer = setTimeout(() => {
      if (session.status === 'starting' || session.status === 'waiting') {
        session.status = 'failed'
        session.message = '登录超时，请重试'
        session.endedAt = Date.now()
        try { child.kill('SIGKILL') } catch {}
      }
    }, this.loginTimeoutMs)
    session.timer = timer

    child.on('error', (error) => {
      clearTimeout(timer)
      session.status = 'failed'
      session.message = String(error?.message || error)
      session.endedAt = Date.now()
      session.proc = null
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (session.status === 'cancelled') return
      if (code === 0) {
        session.status = 'succeeded'
        session.message = null
        this.auth.set(name, { state: 'ok', at: Date.now() })
      } else {
        session.status = 'failed'
        const cleaned = String(session.log || '').replace(/get-token:\s*/g, '').trim()
        session.message = tail(cleaned || `exit ${code}`, 900)
        this.auth.set(name, { state: 'needs-login', message: session.message, at: Date.now() })
      }
      session.endedAt = Date.now()
      session.proc = null
    })
    return this.publicSession(session)
  }

  submitLoginCode(cluster, code) {
    const session = this.sessions.get(safeName(cluster))
    if (!session || !session.proc) throw new Error('没有进行中的登录')
    session.proc.stdin.write(`${String(code).trim()}\n`)
    return this.publicSession(session)
  }

  cancelLogin(cluster) {
    const session = this.sessions.get(safeName(cluster))
    if (!session) return null
    session.status = 'cancelled'
    session.endedAt = Date.now()
    try { session.proc?.kill('SIGKILL') } catch {}
    session.proc = null
    return this.publicSession(session)
  }

  dispose() {
    // Requests still in flight are about to lose their kubectl children; mark the
    // service so their failures are reported as "restarting" rather than as an
    // anonymous exit code.
    this.closing = true
    for (const forward of this.forwards.values()) {
      try { killTree(forward.child) } catch {}
    }
    this.forwards.clear()
    for (const shell of this.shells.values()) {
      try { shell.term.kill() } catch {}
    }
    this.shells.clear()
    for (const session of this.sessions.values()) {
      try { session.proc?.kill('SIGKILL') } catch {}
    }
  }
}

/** Exported for the standalone harness scripts under docs/ (not a public API). */
export { KubeService }

function scopeArgs(kind, namespace) {
  const base = String(kind).split('.')[0].toLowerCase()
  if (CLUSTER_SCOPED.has(base)) return []
  return ['-n', namespace && namespace !== '' ? namespace : 'default']
}

/** Options for the js-yaml `dump` used to re-serialize edited/read manifests.
 * `noRefs` keeps the output flat (no anchors/aliases), `lineWidth: -1` disables
 * line wrapping so long values and multi-line block scalars stay readable. */
const YAML_DUMP_OPTS = { noRefs: true, lineWidth: -1 }

/** Parse a YAML document, returning `undefined` on any parse failure (so the
 * caller can fall back to applying the text verbatim). */
function safeParseYaml(text) {
  try {
    return jsYaml.load(String(text || ''))
  } catch {
    return undefined
  }
}

function stripManagedFields(yaml) {
  const lines = String(yaml).split('\n')
  const output = []
  let skipping = false
  for (const line of lines) {
    if (/^  managedFields:/.test(line)) { skipping = true; continue }
    if (skipping) {
      if (/^\s{4}- /.test(line) || /^\s{4}\S/.test(line)) continue
      if (/^\S/.test(line) || /^ {2}\S/.test(line)) skipping = false
      else continue
    }
    output.push(line)
  }
  return output.join('\n')
}

/** Build a tool definition whose canonical value is a plain object. */
function defineKubeTool({ name: toolName, description, parameters, summary, run }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (value && typeof value === 'object' && value.ok === false) {
          const lines = [`error: ${value.error}`]
          if (value.hint) lines.push(`hint: ${value.hint}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value && typeof value === 'object' && typeof value.text === 'string') {
          return [{ type: 'text', text: value.text }]
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute: async (args, exec) => run(args, exec),
    ...(summary ? { timeoutMs: 120000 } : {}),
  }
}

export function apply(ctx, config = {}) {
  // kubectl exec plugins run with HOME = the DSH home, so token caches stay under
  // the DSH home. AWS SSO credentials live in the real login home's ~/.aws
  // (often a Windows/OneDrive symlink), which the service overrides; point the
  // AWS_* env at those files so kubectl can refresh them.
  const dshHome = os.homedir()
  let loginHome = null
  try { loginHome = os.userInfo().homedir } catch {}
  const service = new KubeService({
    configDir: config.configDir || path.join(dshHome, '.kube', 'dsh', 'configs'),
    home: config.home || dshHome,
    awsHome: loginHome && loginHome !== dshHome && fs.existsSync(path.join(loginHome, '.aws')) ? loginHome : null,
    kubectl: config.kubectl || 'kubectl',
    loginTimeoutMs: Math.max(30000, Number(config.loginTimeoutMs) || 300000),
  })

  // ---- agent tools --------------------------------------------------------

  const tools = []

  tools.push(defineKubeTool({
    name: 'kube_contexts',
    description: 'List the Kubernetes clusters (plugin-defined names) configured in this plugin with their server, namespace, credential plugin and last known sign-in state. Call this first to pick a cluster name.',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Reload kubeconfig files instead of using the cached view.' },
      },
      additionalProperties: false,
    },
    run: async () => {
      const list = await service.clusters()
      const text = list.map((item) => JSON.stringify({
        cluster: item.name,
        current: item.current,
        server: item.server,
        namespace: item.namespace,
        auth: item.auth,
        state: item.state,
      })).join('\n')
      return { ok: true, text: text || '(no clusters — add one in the Kubernetes panel)' }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_get',
    description: 'List Kubernetes resources for one cluster via kubectl. Returns a compact table. Use namespace for one namespace or allNamespaces to span all.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string', description: 'Plugin cluster name from kube_contexts.' },
        kind: { type: 'string', description: 'Resource kind, e.g. pods, deployments.apps, services, nodes, events, serviceaccounts, roles.rbac.authorization.k8s.io, clusterrolebindings.rbac.authorization.k8s.io, rbacusers/rbacgroups (RBAC subjects aggregated from bindings), or horizontalpodautoscalers.autoscaling / verticalpodautoscalers.autoscaling.k8s.io.' },
        namespace: { type: 'string', description: 'Namespace; defaults to default. Ignored for cluster-scoped kinds.' },
        allNamespaces: { type: 'boolean', description: 'List across all namespaces.' },
        selector: { type: 'string', description: 'Label selector, e.g. app=web.' },
      },
      required: ['cluster', 'kind'],
      additionalProperties: false,
    },
    run: async (args) => {
      const result = await service.list(args.cluster, args.kind, args)
      if (!result.ok) return result
      const headers = ['NAME', 'NAMESPACE', 'STATUS', 'READY', 'AGE']
      const rows = result.rows.map((row) => [row.name, row.namespace || '', row.status, row.ready, row.age])
      return { ok: true, text: `${args.kind} in ${args.cluster}: ${result.count} item(s)\n${formatRows(headers, rows)}` }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_crds',
    description: 'List the CustomResourceDefinitions installed in a cluster: group, kind, plural name, scope and served versions. Use the returned "<plural>.<group>" as the kind for kube_get to list that custom resource.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string', description: 'Plugin cluster name from kube_contexts.' },
        refresh: { type: 'boolean', description: 'Bypass the 60s cache and re-read CRDs from the cluster.' },
      },
      required: ['cluster'],
      additionalProperties: false,
    },
    run: async (args) => {
      const result = await service.crds(args.cluster, { refresh: args.refresh === true })
      if (!result.ok) return result
      const headers = ['NAME', 'KIND', 'GROUP', 'SCOPE', 'VERSIONS', 'STATUS']
      const rows = result.crds.map((entry) => [
        entry.name, entry.kind, entry.group, entry.scope, entry.versions.join(','), entry.status,
      ])
      return { ok: true, text: `CRDs in ${args.cluster}: ${result.crds.length} item(s)\n${formatRows(headers, rows)}` }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_describe',
    description: 'Run kubectl describe for one resource; useful for events, conditions and mounting/network failures.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        kind: { type: 'string', description: 'Resource kind, e.g. pod, deployment.' },
        name: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['cluster', 'kind', 'name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const result = await service.describe(args.cluster, args.kind, args.name, args.namespace)
      if (!result.ok) return result
      return { ok: true, text: result.description }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_logs',
    description: 'Fetch logs via kubectl logs. `pod` is a pod name, or a workload selector such as deployment/<name>, statefulset/<name> or daemonset/<name> to read every pod of that workload.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        pod: { type: 'string' },
        namespace: { type: 'string' },
        container: { type: 'string' },
        tailLines: { type: 'integer', description: 'Number of trailing lines, default 200.' },
        since: { type: 'string', description: 'Duration such as 10m or 1h.' },
        previous: { type: 'boolean', description: 'Logs of the previous terminated container.' },
      },
      required: ['cluster', 'pod'],
      additionalProperties: false,
    },
    run: async (args) => {
      const result = await service.logs(args.cluster, args.pod, args)
      if (!result.ok) return result
      return { ok: true, text: result.logs }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_apply',
    description: 'Apply a YAML manifest with kubectl apply. Mutating: without confirm=true it only returns the manifest preview and does nothing. Call it first without confirm to show the user what would change, then again with confirm=true after the user agrees.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        manifest: { type: 'string', description: 'Full YAML document(s), multi-doc allowed.' },
        namespace: { type: 'string', description: 'Namespace override for namespaced objects without metadata.namespace.' },
        confirm: { type: 'boolean', description: 'Set true only after the user explicitly agreed to apply.' },
      },
      required: ['cluster', 'manifest'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (!args.confirm) {
        return {
          ok: true,
          requiresConfirmation: true,
          text: `尚未执行（需要用户确认）。将执行 kubectl apply，内容如下：\n${tail(args.manifest, 6000)}\n\n用户同意后，以 confirm=true 重新调用。`,
        }
      }
      const command = ['apply', '-f', '-']
      if (args.namespace) command.push('-n', args.namespace)
      const result = await service.kubectl(args.cluster, command, { timeoutMs: 120000, input: args.manifest })
      if (!result.ok) return result
      return { ok: true, text: result.stdout.trim() || '(applied)' }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_scale',
    description: 'Scale a workload via kubectl scale. Mutating: requires confirm=true, which must follow explicit user agreement.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        kind: { type: 'string', description: 'deployment, statefulset, replicaset …' },
        name: { type: 'string' },
        namespace: { type: 'string' },
        replicas: { type: 'integer' },
        confirm: { type: 'boolean' },
      },
      required: ['cluster', 'kind', 'name', 'replicas'],
      additionalProperties: false,
    },
    run: async (args) => {
      const target = `${args.kind}/${args.name} in ${args.namespace || 'default'} of ${args.cluster}`
      if (!args.confirm) return { ok: true, requiresConfirmation: true, text: `尚未执行（需要用户确认）：将把 ${target} 扩缩到 ${args.replicas} 副本。确认后以 confirm=true 重新调用。` }
      const result = await service.kubectl(args.cluster, ['scale', args.kind, args.name, ...scopeArgs(args.kind, args.namespace), '--replicas', String(args.replicas)], { timeoutMs: 60000 })
      if (!result.ok) return result
      return { ok: true, text: result.stdout.trim() }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_rollout',
    description: 'Rollout operations: restart (rolling restart), status (wait for rollout), undo (roll back to the previous revision). Mutating actions require confirm=true after user agreement.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        kind: { type: 'string', description: 'deployment, statefulset, daemonset.' },
        name: { type: 'string' },
        namespace: { type: 'string' },
        action: { type: 'string', enum: ['restart', 'status', 'undo'] },
        confirm: { type: 'boolean' },
      },
      required: ['cluster', 'kind', 'name', 'action'],
      additionalProperties: false,
    },
    run: async (args) => {
      const target = `${args.kind}/${args.name} in ${args.namespace || 'default'} of ${args.cluster}`
      if (args.action !== 'status' && !args.confirm) {
        return { ok: true, requiresConfirmation: true, text: `尚未执行（需要用户确认）：将对 ${target} 执行 rollout ${args.action}。确认后以 confirm=true 重新调用。` }
      }
      const extra = args.action === 'status' ? ['--timeout=90s'] : []
      const result = await service.kubectl(args.cluster, ['rollout', args.action, `${args.kind}/${args.name}`, ...scopeArgs(args.kind, args.namespace), ...extra], { timeoutMs: 120000 })
      if (!result.ok) return result
      return { ok: true, text: result.stdout.trim() || '(done)' }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_delete',
    description: 'Delete one resource via kubectl delete. Destructive: requires confirm=true, and the namespace must be explicit. Never set confirm without the user asking for this exact deletion.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        kind: { type: 'string' },
        name: { type: 'string' },
        namespace: { type: 'string', description: 'Namespace; omit for cluster-scoped kinds such as node.' },
        confirm: { type: 'boolean' },
      },
      required: ['cluster', 'kind', 'name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const clusterScoped = CLUSTER_SCOPED.has(String(args.kind).split('.')[0].toLowerCase())
      if (!clusterScoped && !args.namespace) {
        return { ok: false, kind: 'error', error: '删除命名空间级资源必须显式指定 namespace' }
      }
      const target = `${args.kind}/${args.name}${clusterScoped ? '' : ` in ${args.namespace}`} of ${args.cluster}`
      if (!args.confirm) return { ok: true, requiresConfirmation: true, text: `尚未执行（需要用户确认）：将删除 ${target}。确认后以 confirm=true 重新调用。` }
      const scope = clusterScoped ? [] : ['-n', args.namespace]
      const result = await service.kubectl(args.cluster, ['delete', args.kind, args.name, ...scope, '--wait=false'], { timeoutMs: 60000 })
      if (!result.ok) return result
      return { ok: true, text: result.stdout.trim() }
    },
  }))

  tools.push(defineKubeTool({
    name: 'kube_login',
    description: 'Start an OIDC sign-in for a cluster whose exec plugin is kubelogin. Returns the URL to visit; the browser step must be completed by the user. The plugin tries to open the Windows browser automatically; if it cannot, show the URL to the user.',
    parameters: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        method: {
          type: 'string',
          enum: ['browser', 'device', 'keyboard'],
          description: 'browser = localhost callback (default); device = device code; keyboard = paste the authorization code back.',
        },
      },
      required: ['cluster'],
      additionalProperties: false,
    },
    run: async (args) => {
      try {
        const session = await service.startLogin(args.cluster, args.method || 'browser')
        const lines = [`登录已发起：${session.status}`]
        if (session.url) lines.push(`URL: ${session.url}`)
        if (session.code) lines.push(`设备码: ${session.code}`)
        if (session.browserOpened) lines.push('已尝试在 Windows 浏览器中打开该 URL。')
        else if (session.url) lines.push('未能自动打开浏览器，请把 URL 复制给用户在浏览器中访问。')
        lines.push('OIDC 登录必须由用户在浏览器中完成；不要让模型代填凭据。')
        return { ok: true, text: lines.join('\n') }
      } catch (error) {
        return { ok: false, error: String(error?.message || error), hint: '只有 kubelogin(oidc-login) 的集群支持由插件发起登录；AWS 等凭据由各自 CLI 处理。' }
      }
    },
  }))

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }, 'kube.tools')

  // ---- HTTP surface -------------------------------------------------------

  const webServer = ctx.get('webServer')
  if (!webServer) {
    console.warn('[kube] webServer unavailable; panel routes are not registered')
    return
  }

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
  const body = async (req) => {
    try { return JSON.parse((await readBody(req)) || '{}') } catch { return {} }
  }

  const route = (path, handler) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const result = await handler(await body(req))
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String(error?.message || error) })
      }
    },
  })

  const routes = [
    route('/dsh-kube/state', async () => ({
      ok: true,
      configDir: service.dir,
      home: service.home,
      merged: service.merged,
      current: service.state().current || null,
      sources: service.sources(),
      kubectl: await service.hasKubectl(),
      browserBridge: fs.existsSync(CMD_EXE),
    })),
    route('/dsh-kube/clusters', async () => ({ ok: true, clusters: await service.clusters() })),
    route('/dsh-kube/paste', async (input) => ({ ok: true, ...(await service.addSource(input.name, input.yaml)) })),
    route('/dsh-kube/remove', async (input) => ({ ok: true, ...(await service.removeSource(input.name)) })),
    route('/dsh-kube/switch', async (input) => ({ ok: true, ...(await service.switchCluster(input.cluster)) })),
    route('/dsh-kube/cluster', async (input) => ({ ok: true, ...service.clusterYaml(input.cluster) })),
    route('/dsh-kube/namespaces', async (input) => service.namespaces(input.cluster)),
    route('/dsh-kube/crds', async (input) => service.crds(input.cluster, { refresh: input.refresh === true })),
    route('/dsh-kube/list', async (input) => service.list(input.cluster, input.kind, input)),
    route('/dsh-kube/probe', async (input) => service.probe(input.cluster)),
    route('/dsh-kube/yaml', async (input) => service.objectYaml(input.cluster, input.kind, input.name, input.namespace, { raw: input.raw === true, forEdit: input.forEdit === true })),
    route('/dsh-kube/apply', async (input) => service.applyYaml(input.cluster, input.yaml, { namespace: input.namespace })),
    route('/dsh-kube/describe', async (input) => service.describe(input.cluster, input.kind, input.name, input.namespace)),
    route('/dsh-kube/rules', async (input) => service.rulesOf(input.cluster, input.kind, input.name, input.namespace)),
    route('/dsh-kube/logs', async (input) => service.logs(input.cluster, input.pod, input)),
    // Container shell: start (probe bash/sh), feed stdin, stop, and stream output.
    route('/dsh-kube/exec-start', async (input) => service.startShell(input.cluster, input)),
    route('/dsh-kube/exec-input', async (input) => service.shellInput(input.id, input.data)),
    route('/dsh-kube/exec-stop', async (input) => service.stopShell(input.id)),
    route('/dsh-kube/exec-resize', async (input) => service.shellResize(input.id, input.cols, input.rows)),
    // Streaming stdout/stderr of a shell session, same wire shape as
    // logs-follow: raw text chunks, no gzip, killed when the pane disconnects.
    {
      kind: 'exact',
      path: '/dsh-kube/exec-stream',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const input = await body(req)
        const session = service.shells.get(String(input.id || ''))
        if (!session) return sendJson(res, 404, { ok: false, error: 'shell 会话已结束' })
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()
        // Replay what the session already printed, then attach for the rest.
        const offset = Number(input.offset || 0)
        const start = session.dropped
        if (!Number.isFinite(offset) || offset < start) res.write(session.output)
        else res.write(session.output.slice(offset - start))
        if (session.closed) { res.end(); return }
        const listener = {
          onData: (text) => { if (!res.writableEnded) res.write(text) },
          onClose: () => { if (!res.writableEnded) res.end() },
        }
        session.listeners.add(listener)
        res.on('close', () => { session.listeners.delete(listener) })
      },
    },
    route('/dsh-kube/workload-action', async (input) => service.workloadAction(input.cluster, input)),
    route('/dsh-kube/delete-resource', async (input) => service.deleteResource(input.cluster, input.kind, input.name, input.namespace)),
    route('/dsh-kube/node-action', async (input) => service.nodeAction(input.cluster, input.node, input.action)),
    route('/dsh-kube/rollout-history', async (input) => service.rolloutHistory(input.cluster, input.kind, input.name, input.namespace)),
    route('/dsh-kube/pods-of', async (input) => service.podsOf(input.cluster, input.kind, input.name, input.namespace)),
    route('/dsh-kube/containers', async (input) => service.containers(input.cluster, input.pod, input.namespace)),
    route('/dsh-kube/pod-ports', async (input) => service.podPorts(input.cluster, input)),
    route('/dsh-kube/forwards', async () => ({ ok: true, forwards: service.listForwards() })),
    route('/dsh-kube/forward-start', async (input) => service.startForward(input)),
    route('/dsh-kube/forward-stop', async (input) => service.stopForward(input.id)),
    // Streaming follow-logs (`kubectl logs -f`): streams raw text until the
    // client disconnects, then kills the spawned kubectl process tree.
    {
      kind: 'exact',
      path: '/dsh-kube/logs-follow',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const input = await body(req)
        const cluster = safeName(input.cluster)
        const pod = safeName(input.pod)
        if (!cluster || !pod) return sendJson(res, 400, { ok: false, error: 'cluster and pod required' })
        // Resource type the logs belong to. kubectl logs accepts plain pod
        // names as well as deployment/<name>, statefulset/<name> and
        // daemonset/<name> selectors, so a workload row streams the logs of
        // the pod(s) it owns.
        const kindBase = String(input.kind || 'pods').split('.')[0]
        // Resolve the cluster's kubeconfig file + target context exactly like
        // service.kubectl() does; without these kubectl falls back to the
        // default kubeconfig (~/.kube/config) and streams nothing.
        const file = service.clusterFile(cluster)
        if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: `集群 "${cluster}" 不存在` })
        const ctx = await service.targetContextFor(cluster)
        // Resolve the target and the workload flags (--all-pods=true plus a
        // --max-log-requests high enough for every pod: kubectl otherwise
        // refuses to follow more than 5 streams at once).
        const logPlan = await service.logsTarget(cluster, kindBase, pod, input.namespace)
        // Seed with the recent tail then follow live: `--tail=100` makes the
        // stream deliver the last 100 lines immediately (so the pane isn't
        // empty), then `-f` appends new logs as they are produced. The
        // frontend keeps its own rolling window of the latest lines and
        // throttles rendering, so history plus live output stays bounded.
        const args = ['--kubeconfig', file, '--context', ctx, '--cache-dir', this.cacheDir, 'logs', '-f', logPlan.target, '--tail=100', ...logPlan.extra, ...scopeArgs('pods', input.namespace)]
        if (input.container) args.push('-c', String(input.container))
        if (input.previous) args.push('--previous')
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        // `no-transform` opts this response out of the host web server's gzip
        // middleware. Without it the gzip encoder buffers the trickling kubectl
        // output, so a browser (which always sends Accept-Encoding) receives
        // nothing until the stream ends — while curl, sending no Accept-Encoding,
        // streams fine. That mismatch is what made in-browser tailing look dead.
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()
        const child = spawn(service.kubectlBin, args, { env: service.env(), cwd: service.home, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { if (!res.writableEnded) res.write(chunk) })
        child.stderr.on('data', (chunk) => { if (!res.writableEnded) res.write(chunk) })
        const done = () => { if (!res.writableEnded) res.end() }
        child.on('close', done)
        child.on('error', done)
        res.on('close', () => {
          if (child && child.exitCode === null) killTree(child)
        })
      },
    },
    // Terminal front-end assets (xterm.js + its stylesheet), vendored under
    // assets/ so the pane needs no build step or CDN access.
    ...['xterm.js', 'xterm.css', 'addon-fit.js'].map((name) => ({
      kind: 'exact',
      path: `/dsh-kube/assets/${name}`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        let data
        try { data = fs.readFileSync(path.join(ASSET_DIR, name)) } catch { return sendJson(res, 404, { ok: false, error: 'asset not found' }) }
        res.statusCode = 200
        res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'public, max-age=86400')
        res.end(req.method === 'HEAD' ? undefined : data)
      },
    })),
    route('/dsh-kube/login', async (input) => ({ ok: true, session: await service.startLogin(input.cluster, input.method) })),
    route('/dsh-kube/login-status', async (input) => ({ ok: true, session: service.publicSession(service.sessions.get(safeName(input.cluster))) })),
    route('/dsh-kube/login-code', async (input) => ({ ok: true, session: service.submitLoginCode(input.cluster, input.code) })),
    route('/dsh-kube/login-cancel', async (input) => ({ ok: true, session: service.cancelLogin(input.cluster) })),
  ]

  ctx.effect(() => {
    const disposers = routes.map((entry) => webServer.register(entry))
    return () => { for (const dispose of disposers) dispose() }
  }, 'kube.routes')

  ctx.effect(() => () => service.dispose(), 'kube.dispose')
}
