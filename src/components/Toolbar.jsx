function TrimIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 4v16M19 4v16" />
      <path d="M5 12h14" strokeDasharray="2 3" />
    </svg>
  )
}

function CropIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M2 6h14a2 2 0 0 1 2 2v14" />
    </svg>
  )
}

function MosaicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" opacity="0.55" />
      <rect x="3" y="13" width="8" height="8" rx="1" opacity="0.55" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  )
}

const TOOLS = [
  { id: 'trim', label: 'Trim', tip: '时间裁剪', Icon: TrimIcon, enabled: true },
  { id: 'crop', label: 'Crop', tip: '画面裁剪', Icon: CropIcon, enabled: true },
  { id: 'mosaic', label: '打码', tip: '局部打码 · 硬件重编码', Icon: MosaicIcon, enabled: true },
]

export default function Toolbar({ active, onChange, locked }) {
  return (
    <div className="floating-tools" onMouseDown={(e) => e.stopPropagation()}>
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`floating-tool ${active === t.id ? 'active' : ''}`}
          onClick={() => !locked && t.enabled && onChange(t.id)}
          disabled={!t.enabled || locked}
          aria-label={t.label}
        >
          <t.Icon />
          <span className="floating-tip">{t.tip}</span>
        </button>
      ))}
    </div>
  )
}
