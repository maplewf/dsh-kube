# dsh-kube

> 🌐 [中文](README.md) | **English**

A Kubernetes workbench plugin for DeepSeek Harness — browse clusters and resources, operate on workloads, open in-container terminals, and expose a set of kubectl-backed tools the agent can call.

---

## Contents

- [Architecture](#architecture)
- [Features](#features)
- [Dependencies](#dependencies)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Caveats](#caveats)
- [Publishing](#publishing)

---

## Architecture

The plugin is a standard DSH bundle with a **host** half and a **client** half — no build step, loaded directly by DSH.

```
dsh-kube/
├── index.js            # Host (Node/Cordis): kubectl execution, HTTP routes, agent tools
├── client.js           # Client (browser): resource panel, terminal, drawer detail UI
├── cordis.patch.yml    # Bundle patch: inserts the plugin row into the profile composition
├── locale/{zh,en}.json # UI strings (Chinese / English)
├── lib/js-yaml.cjs     # Vendored js-yaml (clean YAML re-serialization for editing)
├── assets/             # Vendored xterm.js terminal static assets
├── icon.svg
└── docs/DETAIL.md      # Plugin detail-page doc
```

- **Host `index.js`**: every `kubectl` call happens here through the local kubectl binary. It registers HTTP routes (`/dsh-kube/*`, used by the panel) and agent tools (`kube_contexts`, `kube_get`, `kube_crds`, `kube_describe`, `kube_logs`, `kube_apply`, `kube_scale`, `kube_rollout`, `kube_delete`, `kube_login`). The in-container terminal is started by the backend via `node-pty` (ships with DSH) as a real PTY running `kubectl exec -it -- bash -i`.
- **Client `client.js`**: the DSH web UI side — sidebar entry, cluster/resource panel, right drawer (YAML / Describe / Pod logs), in-container shell tab, and a rules-matrix tab. The terminal renders with a vendored xterm.js.
- **`cordis.patch.yml`**: inserts the `{id: kube, name: 'dsh-kube'}` row into the profile's plugin composition so DSH instantiates it.

---

## Features

### Resource browsing

Support by-type listing and filtering across Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, HPAs, VPAs, Services, Ingress, ConfigMaps, Secrets, PVC, Events, Nodes, Namespaces, ServiceAccounts, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings, Users/Groups, and CRDs. The resource-type box is **searchable** (by Chinese label or kind; ↑/↓ to select, Enter to confirm, Esc to close). Clicking a row opens a right drawer with YAML / Describe / Pod logs. The **Services** list shows a real **Type** column and a **Pod** column that filters pods by the Service's `spec.selector` (selector-less Services return empty).

### CRD

The dropdown lists only built-in types; `CRDs` is the **first** entry. The `CRDs` entry shows installed CustomResourceDefinitions. Clicking a Kind drills into its instances, with a banner showing the current group/kind and a one-click back. The instance table always shows **name / namespace (omitted for cluster-scoped) / age** as fixed columns, and expands the CRD's `additionalPrinterColumns` into **dynamic columns** (each key becomes a header, the value a cell, sortable) instead of cramming them into one "other" column. Large CRD instance lists are fetched as a `custom-columns` projection (a 24 MB JSON list drops to ~70 KB), so they stay well under the output limit; if a CRD has no printer columns (or kubectl rejects the expression) the plugin transparently falls back to the full JSON path.

### In-container terminal

The container sub-table has a terminal icon. The backend probes `bash` (falling back to `sh`) and launches a real PTY through `kubectl exec -it -- bash -i`, so you get a genuine tty (prompt, echo, colors, line editing, Ctrl-C, `top`/`vim`). The client renders it with the vendored xterm.js and syncs `stty size` on resize. Closing the tab kills the kubectl process.

### YAML editing

Any resource's YAML tab has an **Edit** button; saving warns it will be applied to the cluster, runs `kubectl apply -f -`, surfaces kubectl errors verbatim, and on success re-reads the object and refreshes the list. Read and edit share one surface (a highlight layer under a transparent-text textarea with a green caret), so layout/line-wraps/scroll stay identical; Esc cancels. The draft is a clean re-serialization via js-yaml (nested objects/arrays render correctly); **Secret `data` is shown in plaintext while editing and moved into `stringData` on save**, so the API server does the base64 encoding. Users/Groups are aggregated pseudo-resources and cannot be edited.

### Actions column

**Every** resource kind has an **Actions** dropdown with at least **Delete**; workloads additionally get rollout-restart / rollback / scale. Rollback reads `kubectl rollout history` and defaults to the previous revision (optionally `--to-revision=N`). Scale asks for the target replicas. Delete runs `kubectl delete --wait=false` (namespaced with `-n`, cluster-scoped without; does not wait for drain). The panel shows kubectl's output or raw error. Users/Groups have no actions.

### Nodes

The Nodes list replaces the old spec column with **CPU** and **Memory** as `request/capacity` (e.g. `1.75/8`, `1.4Gi/32Gi`): requests are summed across containers, **capacity comes from `status.capacity` rounded to the nearest power of two** (7.9 cores shows `8`, 30.6Gi shows `32Gi`), and memory units are **always binary** (K/M/G and Ki/Mi/Gi all ×1024). The **Pods** column becomes `running/capacity` (e.g. `12/110`). There are also **Type** and **Zone** columns. **Status** reflects the Ready condition and appends `SchedulingDisabled` when a node is cordoned; comma-separated states render as separate badges. Node actions add **cordon / uncordon / drain**.

### Sorting & filtering

**All** resource kinds support sorting on **name / age** (and **namespace** when the column is shown): click a header to cycle ascending → descending → off. A **global filter box** at the top of the list matches **any column** (supports `/regex/`, `* ?` wildcards, and case-insensitive substrings). **Pods** additionally sort on namespace, status and IP, and let you multi-select filters on **status** and **node**; **Nodes** sort on CPU / memory / pod count / arch / type / zone / age with multi-select filters on **arch / type / zone**; the **Services** **Type** column and the **CRDs** **Group / Scope** columns are multi-select filterable too. Filters are a funnel icon in the header (shows the selected count, stays out of the row height) opening a searchable checkbox panel; sorting uses the real numbers underneath (age parses kubectl's `3y323d`-style text, so it orders correctly even though the displayed value is human-readable). The **header and the controls above it stay fixed** while only the table content scrolls.

### RBAC & rules matrix

ServiceAccounts show secret counts, Roles/ClusterRoles show rule counts, bindings show roleRef and subjects. Users/Groups are aggregated from binding subjects. The **rule count** is a clickable link that opens a K9S-style **verb matrix** in the right sidebar with columns `资源 | API 组 | GET | LIST | WATCH | CREATE | PATCH | UPDATE | DELETE | DEL-LIST`; each rule is expanded per (API group × resource) row, verbs are unioned, granted verbs show a **green ✓** and denied a **red ✗**.

### Clusters & login

Each context shows its auth method, probe status, and a login button. Login reuses the kubeconfig `exec` credential providers (`oidc-login`, `aws eks get-token`, …); DSH only hands the authorization URL to the browser and the code back into the process — **you approve in person**. The login badge reflects live observation and updates immediately on cluster switch.

### Cluster read/write mode

Each cluster can be set to **read-write** (the default) or **read-only** via a dropdown in cluster management (the choice persists in `dsh-kube-state.json`). In read-only mode the **Actions column disappears** from every resource list, the detail drawer's **Edit** button is hidden, and the agent's **write tools** (`kube_apply`, `kube_scale`, `kube_rollout`, `kube_delete`) refuse to run with a clear error; reads and login still work.

In the resource-browsing session page the cluster selector is a **searchable combobox** (open it and type to filter clusters; ↑/↓ to move, Enter to pick, Esc to close), next to it a **read-write / read-only dropdown** — this is a **session-only temporary override**, distinct from the global setting: the change lives in memory only (it is not written to `dsh-kube-state.json`), takes effect immediately (Actions column hidden/restored, Edit button hidden/shown), and **drops on a page refresh or a dsh restart**, reverting to the persisted global setting; switching away and back within the same session keeps the override. The global safety boundary is unchanged: the backend write tools always judge by the persisted setting, so a session-page readwrite override cannot bypass them.

### Resource cache

The global view now has two tabs: **Cluster config** (manage clusters and read/write mode) and **Resource cache**. The Resource cache tab lists the list-cache duration (in **seconds**) for **every supported resource type**; **0 = caching off** for that type, and by default only **CRD = 3600s**, all others off. Saving persists to `dsh-kube-state.json` and takes effect on the next refresh. The cache is keyed by `cluster × type × namespace × all-namespaces × selector`; **manual refreshes** (the ↻ button, auto-refresh ticks, or switching type/cluster/namespace) bypass the cache and hit the cluster, while plain returns (e.g. coming back to CRDs) use the cache; any **write operation** (apply / delete / workload action / node action) clears that cluster's cache on success. The CRD metadata-index cache itself is separate and also 3600s.

---

## Dependencies

- **DSH**: `engines.dsh` requires `0.2.0-rc.2 || >=0.2.1-rc.1 <0.3.0-0`; Node `>=22`.
- A local **`kubectl`** in `$PATH` (all reads/writes go through it).
- **OIDC login** (for kubeconfigs whose `exec` command is `oidc-login`): install the [kubelogin](https://github.com/int128/kubelogin) kubectl plugin (`oidc-login`) and ensure it is on `$PATH`. See its [installation guide](https://github.com/int128/kubelogin#installation).
- **`node-pty`** (ships with DSH) for the container terminal.
- js-yaml and xterm.js are vendored — no network or extra deps.
- On Windows, browser bridging needs WSL's `/mnt/c/Windows/System32/cmd.exe`; without it you must copy the authorization link manually.

---

## Installation

Install from a plugin-market index (git source): under Plugins → experimental plugins → custom plugin index, add the index URL, then install. After installing, **restart** dsh web (e.g. `systemctl --user restart deepseek-harness-web.service`, or the restart entry in the Web UI) so the host half loads; client-only changes just need a page refresh.

---

## Usage

1. Enter the **Kubernetes** workbench from the sidebar.
2. Under **cluster management**, **paste a kubeconfig** to add a cluster (same-name overwrites), or remove one. You provide the kubeconfig; the plugin does not read the system `~/.kube/config`.
3. Select a cluster and complete OIDC auth via **Login** (you approve in your browser).
4. Pick namespace/resource type, filter, click rows for detail / YAML edit / logs / terminal; use **Actions** for restart/rollback/scale/delete.
5. Agent write tools return a “needs confirmation” note until called with an explicit `confirm: true`.

---

## Configuration

Config lives under the DSH home directory (not your real home):

- `~/.kube/dsh/configs/*.yaml` — per-cluster kubeconfig copies (written only via the plugin UI or agent);
- `~/.kube/dsh/config` — the flattened current config kubectl actually reads;
- `~/.kube/dsh/dsh-kube-state.json` — the selected cluster, per-cluster read/write mode, and the **cache duration per resource type**.

Every kubectl call passes `--kubeconfig`; token/oidc-login caches land in the DSH home.

---

## Caveats

- **Destructive operations** (node cordon/uncordon/drain, delete, scale, rollback) affect scheduling and running workloads; drain deletes `emptyDir` data. Test on a non-production cluster first.
- When **`dsh web` restarts**, systemd kills the whole cgroup, so an in-flight kubectl is signal-terminated (exit code −1). That only means the request was interrupted, not a cluster problem; the panel retries silently instead of erroring.
- Resource lists are cached per type per the durations set in the **Resource cache** tab (by default only CRD = 3600s, everything else live), and **manual refreshes bypass the cache**; the CRD metadata-index cache is 1 hour.
- Requires a local kubectl and the kubeconfig `exec` credential providers.
- Does not read the system `~/.kube/config`; cluster configs are pasted by you in the panel.

---

## Publishing

This repo ships a GitHub Action (`.github/workflows/release.yml`). On a `v*` tag it validates the version, `npm pack`s the bundle, **`npm publish --provenance`es to the npm registry** (using npm **Trusted Publishing** / OIDC — no token needed; first publish must be done by hand to establish the package, then point the package's Trusted Publishing on npmjs.com at `maplewf/dsh-kube`), generates the DSH plugin-market `site/index.json` (git source pinned to that commit) via `scripts/generate-index.mjs`, deploys it to GitHub Pages, and creates a GitHub Release with the `.tgz`. Enable **Settings → Pages → Source: GitHub Actions**; the index URL is `https://<owner>.github.io/<repo>/index.json`.
