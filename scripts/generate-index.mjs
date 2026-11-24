#!/usr/bin/env node
// 生成 DSH 插件市场索引 site/index.json + site/icons/dsh-kube.svg。
// 只在 CI 中使用：从 package.json 读取元数据，用 GITHUB_REPOSITORY / GITHUB_SHA
// 生成指向当前提交的 git source。产物交给 actions/deploy-pages 部署到 GitHub Pages。
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

const repo = process.env.GITHUB_REPOSITORY
if (!repo || !repo.includes('/')) {
  throw new Error('GITHUB_REPOSITORY 必填（格式 owner/repo）')
}
const sha = process.env.GITHUB_SHA || ''
if (!/^[0-9a-f]{40}$/.test(sha)) {
  throw new Error('GITHUB_SHA 必须是 40 位 commit SHA')
}

const repoUrl = `https://github.com/${repo}.git`
const ts = Math.floor(Date.now() / 1000)
const version = pkg.version
const engines = pkg.engines && pkg.engines.dsh ? { dsh: pkg.engines.dsh } : undefined
const owner = repo.split('/')[0]

// 索引根目录（部署到 Pages 的目录）
const siteDir = path.join(root, 'site')
const iconsDir = path.join(siteDir, 'icons')
await mkdir(iconsDir, { recursive: true })
await copyFile(path.join(root, 'icon.svg'), path.join(iconsDir, 'dsh-kube.svg'))

const index = {
  format: 1,
  title: { zh: 'DSH Kubernetes 插件', en: 'DSH Kubernetes plugin' },
  plugins: [
    {
      name: pkg.name,
      title: { zh: pkg.name, en: pkg.name },
      description: {
        zh: '在 DSH 中操作 Kubernetes 集群：kubectl 工具、交互式 OIDC 登录与资源面板。',
        en: pkg.description,
      },
      icon: 'icons/dsh-kube.svg',
      author: owner,
      homepage: `https://github.com/${repo}`,
      repository: { url: repoUrl },
      versions: [
        {
          version,
          publishTimestamp: ts,
          source: { type: 'git', url: repoUrl, commit: sha },
          engines,
        },
      ],
    },
  ],
}

await writeFile(path.join(siteDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')
console.log(`Wrote site/index.json (v${version} @ ${sha})`)
