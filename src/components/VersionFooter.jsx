// 跟 FlopsWeb 同一套版本号约定：
//   package.json#version 是上次 tag 的版本（构建时通过 vite define 注入 __WEB_VERSION__）；
//   changelog.json 顶条可以比它领先（commit 之后随手记，下次 tag 一并 bump）。
//   领先时在版本号后加 `+`，表示「v0.1.0 之后还有未打 tag 的进展」。
import changelog from '../../changelog.json'

const WEB_VERSION = (() => {
  try {
    // eslint-disable-next-line no-undef
    return typeof __WEB_VERSION__ === 'string' ? __WEB_VERSION__ : 'dev'
  } catch {
    return 'dev'
  }
})()

function compareSemver(a, b) {
  const sa = String(a || '').trim()
  const sb = String(b || '').trim()
  if (!sa && !sb) return 0
  if (!sa) return -1
  if (!sb) return 1
  const pa = sa.split('.').map((s) => parseInt(s, 10) || 0)
  const pb = sb.split('.').map((s) => parseInt(s, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const TOP_CHANGELOG_VERSION =
  Array.isArray(changelog) && changelog.length > 0 ? changelog[0].version : ''
const HAS_PENDING = compareSemver(TOP_CHANGELOG_VERSION, WEB_VERSION) > 0

export default function VersionFooter() {
  return (
    <footer className="version-footer" aria-label="版本">
      FlowCut <span className="version-footer-num">v{WEB_VERSION}{HAS_PENDING ? '+' : ''}</span>
    </footer>
  )
}
