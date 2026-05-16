import { useRef } from 'react'

function fmtBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`
}

function fmtTime(s) {
  if (!Number.isFinite(s)) return '--:--'
  const m = Math.floor(s / 60)
  const sec = (s - m * 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${sec}`
}

/**
 * 左上角"当前素材"卡片。
 * sourceInfo: { name, size, duration, width, height, thumbUrl } | null
 * editsSummary: 当前编辑摘要字符串（例 "Trim 00:15 · Crop 1080×1080 · 3 个打码区"）
 * edited: 是否对源做过任何处理
 * disabled: 在跑任务时禁用所有按钮
 */
export default function ClipChip({
  sourceInfo,
  editsSummary,
  edited,
  disabled,
  onReset,
  onPickFile,
}) {
  const inputRef = useRef(null)

  const onReplaceClick = () => {
    if (disabled) return
    inputRef.current?.click()
  }

  const onInputChange = (e) => {
    const f = e.target.files?.[0]
    if (f) onPickFile?.(f)
    // 重置 value，便于连续选同名文件
    e.target.value = ''
  }

  return (
    <div className="clip-chip">
      <div className="clip-thumb">
        {sourceInfo?.thumbUrl ? (
          <img src={sourceInfo.thumbUrl} alt="" />
        ) : (
          <div className="clip-thumb-placeholder" />
        )}
        {edited && <span className="clip-edit-dot" title="已编辑" />}
      </div>

      {sourceInfo && (
        <div className="clip-popup" role="tooltip">
          <div className="clip-popup-name" title={sourceInfo.name}>
            {sourceInfo.name}
          </div>
          <div className="clip-popup-row">
            <span>原始大小</span>
            <span>{fmtBytes(sourceInfo.size)}</span>
          </div>
          <div className="clip-popup-row">
            <span>分辨率</span>
            <span>
              {sourceInfo.width}×{sourceInfo.height}
            </span>
          </div>
          <div className="clip-popup-row">
            <span>时长</span>
            <span>{fmtTime(sourceInfo.duration)}</span>
          </div>
          {edited && editsSummary && (
            <div className="clip-popup-row clip-popup-row-edit">
              <span>已编辑</span>
              <span title={editsSummary}>{editsSummary}</span>
            </div>
          )}
          <div className="clip-popup-actions">
            {edited && (
              <button
                type="button"
                className="ghost"
                onClick={onReset}
                disabled={disabled}
              >
                重置
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={onReplaceClick}
              disabled={disabled}
            >
              替换素材
            </button>
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
        onChange={onInputChange}
        style={{ display: 'none' }}
      />
    </div>
  )
}
