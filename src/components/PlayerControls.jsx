import { useCallback, useEffect, useRef, useState } from 'react'

function fmtTime(s) {
  if (!Number.isFinite(s)) return '--:--'
  const m = Math.floor(s / 60)
  const sec = (s - m * 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${sec}`
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="0.5" />
      <rect x="14" y="5" width="4" height="14" rx="0.5" />
    </svg>
  )
}

/**
 * 自制视频控制条：底部一条 44px 渐变浮层。
 *
 * - videoRef / currentTime / duration：基础时间数据
 * - viewWindow：{ startSec, endSec } | null
 *     非 null 时 scrubber 只覆盖 [startSec, endSec] 这段，
 *     时间标签也按窗口归零（左 = 已播放进去多少，右 = 窗口时长）。
 *     用于"trim 应用后回到预览"时把进度条直接收成 trim 区间。
 * - trim：可选，scrubber 上画的黄色高亮（trim 工具激活时显示当前 in/out）。
 *     仅当 viewWindow 为 null 时渲染，避免和窗口模式重复表达。
 */
export default function PlayerControls({
  videoRef,
  duration,
  currentTime,
  viewWindow,
  trim,
  isPlaying,
  onTogglePlay,
}) {
  const trackRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const winStart = viewWindow?.startSec ?? 0
  const winEnd = viewWindow?.endSec ?? duration ?? 0
  const winDur = Math.max(0, winEnd - winStart)

  const eventToSec = useCallback(
    (e) => {
      const el = trackRef.current
      if (!el || !winDur) return winStart
      const rect = el.getBoundingClientRect()
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
      return winStart + (x / rect.width) * winDur
    },
    [winStart, winDur],
  )

  const onTrackMouseDown = useCallback(
    (e) => {
      e.preventDefault()
      const sec = eventToSec(e)
      const v = videoRef.current
      if (v) v.currentTime = sec
      setDragging(true)
    },
    [eventToSec, videoRef],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e) => {
      const sec = eventToSec(e)
      const v = videoRef.current
      if (v) v.currentTime = sec
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, eventToSec, videoRef])

  // 显示用的时间值：在 viewWindow 模式下从 winStart 起算并 clamp 到 [0, winDur]
  const displayedCurrent = Math.max(
    0,
    Math.min(winDur, currentTime - winStart),
  )
  const playPct = winDur ? (displayedCurrent / winDur) * 100 : 0

  // 黄色高亮仅在"全源"视图下需要（窗口模式下整条 bar 就是 trim）
  const showTrimHighlight = trim && !viewWindow && winDur > 0
  const trimStartPct = showTrimHighlight
    ? ((trim.startSec - winStart) / winDur) * 100
    : 0
  const trimEndPct = showTrimHighlight
    ? ((trim.endSec - winStart) / winDur) * 100
    : 100

  return (
    <div className="player-controls">
      <button
        type="button"
        className="pc-btn pc-play"
        onClick={onTogglePlay}
        aria-label={isPlaying ? '暂停' : '播放'}
        title={isPlaying ? '暂停 (Space)' : '播放 (Space)'}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <span className="pc-time">{fmtTime(displayedCurrent)}</span>
      <div className="pc-track" ref={trackRef} onMouseDown={onTrackMouseDown}>
        <div className="pc-track-bg" />
        {showTrimHighlight && (
          <div
            className="pc-track-trim"
            style={{
              left: `${trimStartPct}%`,
              width: `${Math.max(0, trimEndPct - trimStartPct)}%`,
            }}
          />
        )}
        <div className="pc-track-played" style={{ width: `${playPct}%` }} />
        <div className="pc-track-head" style={{ left: `${playPct}%` }} />
      </div>
      <span className="pc-time pc-time-right">{fmtTime(winDur)}</span>
    </div>
  )
}
