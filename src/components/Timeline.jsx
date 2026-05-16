import { useCallback, useEffect, useRef, useState } from 'react'
import { generateThumbnails } from '../lib/thumbnails.js'

function fmtTime(s) {
  if (!Number.isFinite(s)) return '--:--'
  const m = Math.floor(s / 60)
  const sec = (s - m * 60).toFixed(2).padStart(5, '0')
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

const THUMB_COUNT = 12
const MIN_RANGE_SEC = 0.1
// 视窗在 trim 两侧各外延的比例
const WINDOW_PADDING_RATIO = 0.10
// 拖完之后等多久再重算视窗
const RECOMPUTE_DELAY_MS = 1000

function expandWindow(inSec, outSec, duration) {
  if (!duration || !Number.isFinite(duration)) return null
  // 没有有效 trim（覆盖整段）→ 视窗 = 整段
  if (inSec <= 0.005 && outSec >= duration - 0.005) {
    return { startSec: 0, endSec: duration }
  }
  const len = Math.max(0, outSec - inSec)
  const pad = len * WINDOW_PADDING_RATIO
  return {
    startSec: Math.max(0, inSec - pad),
    endSec: Math.min(duration, outSec + pad),
  }
}

export default function Timeline({
  videoUrl,
  duration,
  inSec,
  outSec,
  currentTime,
  onChange,
  onSeek,
  isPlaying,
  onTogglePlay,
}) {
  const stripRef = useRef(null)
  const [thumbs, setThumbs] = useState([])
  const [drag, setDrag] = useState(null)
  // 缩略图条覆盖的时间范围：不一定等于整段视频
  const [viewWindow, setViewWindow] = useState(null)
  // 扩窗动画期间的"前一窗口"覆盖层：缩略图 snapshot + 它在新窗口里要缩到的位置
  const [prevWindowOverlay, setPrevWindowOverlay] = useState(null)
  const prevOverlayRef = useRef(null)
  // 新缩略图层 ref：扩窗动画期间从"按旧尺度铺开（比 strip 宽）"缩回 strip
  const thumbsContainerRef = useRef(null)
  // 扩窗动画期间是否隐藏新 thumbs 的 <img>（占位纹理仍展示）
  const [newThumbsRevealed, setNewThumbsRevealed] = useState(true)
  const thumbsRef = useRef(thumbs)
  useEffect(() => {
    thumbsRef.current = thumbs
  }, [thumbs])

  // 让 setTimeout 闭包能读到最新值
  const inSecRef = useRef(inSec)
  useEffect(() => { inSecRef.current = inSec }, [inSec])
  const outSecRef = useRef(outSec)
  useEffect(() => { outSecRef.current = outSec }, [outSec])
  const viewWindowRef = useRef(viewWindow)
  useEffect(() => { viewWindowRef.current = viewWindow }, [viewWindow])

  // 初始化视窗：用挂载时的 in/out 算 ± 10%
  useEffect(() => {
    if (!videoUrl || !duration || !Number.isFinite(duration)) {
      setViewWindow(null)
      return
    }
    setViewWindow(expandWindow(inSec, outSec, duration))
    // 故意只在 videoUrl/duration 变化时初始化；后续 in/out 拖动不直接驱动视窗
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, duration])

  // 释放定时器
  const recomputeTimerRef = useRef(null)
  useEffect(() => {
    return () => {
      if (recomputeTimerRef.current) {
        clearTimeout(recomputeTimerRef.current)
        recomputeTimerRef.current = null
      }
    }
  }, [])

  // 还在补缩略图：尚未预分配（length=0），或者数组里仍有 null 位
  const loading =
    thumbs.length === 0 || thumbs.some((t) => !t)

  useEffect(() => {
    if (!videoUrl || !duration || !Number.isFinite(duration)) return
    if (!viewWindow) return
    let cancelled = false
    const winDur = Math.max(0, viewWindow.endSec - viewWindow.startSec)
    const count = Math.max(4, Math.min(THUMB_COUNT, Math.ceil(winDur)))
    setThumbs(Array(count).fill(null))
    generateThumbnails(
      videoUrl,
      duration,
      count,
      undefined,
      (idx, thumb) => {
        if (cancelled) return
        setThumbs((prev) => {
          if (prev[idx] === thumb) return prev
          const next = prev.length === count ? prev.slice() : Array(count).fill(null)
          next[idx] = thumb
          return next
        })
      },
      viewWindow.startSec,
      viewWindow.endSec,
    )
      .catch((e) => {
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.warn('[Timeline] thumbnail generation failed', e)
      })
    return () => {
      cancelled = true
    }
  }, [videoUrl, duration, viewWindow])

  const eventToSec = useCallback(
    (e) => {
      const el = stripRef.current
      const w = viewWindow
      if (!el || !w) return 0
      const winDur = Math.max(0, w.endSec - w.startSec)
      if (winDur <= 0) return w.startSec
      const rect = el.getBoundingClientRect()
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
      return w.startSec + (x / rect.width) * winDur
    },
    [viewWindow],
  )

  // 拖动结束后，若把手落在视窗外侧 10% 区域里，1 秒后按新 trim 重算视窗（再外延 10%）
  const scheduleRecompute = useCallback(() => {
    if (recomputeTimerRef.current) clearTimeout(recomputeTimerRef.current)
    recomputeTimerRef.current = setTimeout(() => {
      recomputeTimerRef.current = null
      const w = viewWindowRef.current
      if (!w || !duration) return
      const winSpan = w.endSec - w.startSec
      if (winSpan <= 0) return
      const threshold = winSpan * WINDOW_PADDING_RATIO
      const i = inSecRef.current
      const o = outSecRef.current
      const inLeftMargin = i < w.startSec + threshold
      const inRightMargin = o > w.endSec - threshold
      if (!inLeftMargin && !inRightMargin) return
      const expanded = expandWindow(i, o, duration)
      if (!expanded) return
      // 单调增长：视窗只往外扩，不向内收。
      // 用户向内收 trim 时不应该把可见范围一起收回去——保留之前已经"露出"的余地。
      const next = {
        startSec: Math.min(w.startSec, expanded.startSec),
        endSec: Math.max(w.endSec, expanded.endSec),
      }
      if (
        Math.abs(w.startSec - next.startSec) < 0.005 &&
        Math.abs(w.endSec - next.endSec) < 0.005
      ) {
        return
      }
      // prev 起点 = 100% / left 0%（跟用户刚刚看到的状态完全一致，避免 mount 时画面瞬变），
      // 终点 = 旧窗口在新窗口里的几何位置（inner rect）。
      // 新 thumbs 层从 ratio×100% 缩回 strip，跟 prev 同步比例缩放——
      // 两层共用同一 scale，整张图像一次统一 zoom-out。
      // 起点 ratio×100% 时新 thumbs 像旧尺度铺开，覆盖整条 strip 不留缝。
      const newSpan = next.endSec - next.startSec
      const oldSpan = w.endSec - w.startSec
      const ratio = oldSpan > 0 ? newSpan / oldSpan : 1
      const toLeft = ((w.startSec - next.startSec) / newSpan) * 100
      const toWidth = ((w.endSec - w.startSec) / newSpan) * 100
      const snapshot = thumbsRef.current
      if (snapshot && snapshot.length > 0) {
        setPrevWindowOverlay({
          thumbs: snapshot,
          toLeft,
          toWidth,
          ratio,
          key: Date.now() + Math.random(),
        })
      }
      setViewWindow(next)
    }, RECOMPUTE_DELAY_MS)
  }, [duration])

  // 前一窗口 overlay：先 100% 宽 mount → 下一帧写入目标 rect 触发横向过渡 →
  // 横向到位后再 fade 出。期间下层新 thumbs 的 <img> 被压成透明，
  // 让占位条纹（永远铺满全宽）替它顶班；横向到位时同步开始淡入 <img>，
  // 与 prev 的淡出做对穿。
  useEffect(() => {
    if (!prevWindowOverlay) {
      setNewThumbsRevealed(true)
      return
    }
    setNewThumbsRevealed(false)
    const el = prevOverlayRef.current
    const thumbsEl = thumbsContainerRef.current
    if (!el) return
    const ratio = prevWindowOverlay.ratio || 1
    const extendedWidth = ratio * 100
    const extendedLeft = (100 - extendedWidth) / 2 // 居中外溢
    // 起点：
    //   prev：left 0% / width 100%（跟用户刚刚看到的状态一致，无瞬变）
    //   tl-thumbs：用旧尺度铺开，宽 = ratio × strip，居中超出 strip 被 overflow 裁掉
    el.style.transition = 'none'
    el.style.opacity = '1'
    el.style.left = '0%'
    el.style.width = '100%'
    if (thumbsEl) {
      thumbsEl.style.transition = 'none'
      thumbsEl.style.left = `${extendedLeft}%`
      thumbsEl.style.width = `${extendedWidth}%`
    }
    // 强制 reflow 让起始态先落地
    void el.offsetWidth
    if (thumbsEl) void thumbsEl.offsetWidth
    // 终点：
    //   prev：旧窗口在新窗口里的位置（inner rect）
    //   tl-thumbs：left 0% / width 100%
    // 两层 scale 同比，整体看上去是统一的 zoom-out
    el.style.transition = 'left 400ms ease-out, width 400ms ease-out'
    el.style.left = `${prevWindowOverlay.toLeft}%`
    el.style.width = `${prevWindowOverlay.toWidth}%`
    if (thumbsEl) {
      thumbsEl.style.transition = 'left 400ms ease-out, width 400ms ease-out'
      thumbsEl.style.left = '0%'
      thumbsEl.style.width = '100%'
    }
    // 横向到位之后：prev 淡出 + 新 thumbs 淡入（对穿）
    const fadeTimer = setTimeout(() => {
      if (el) {
        el.style.transition = 'opacity 700ms ease-out'
        el.style.opacity = '0'
      }
      setNewThumbsRevealed(true)
    }, 400)
    const unmountTimer = setTimeout(() => {
      setPrevWindowOverlay(null)
    }, 1150)
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(unmountTimer)
    }
  }, [prevWindowOverlay])

  const beginDrag = (mode, e) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag({
      mode,
      startSec: eventToSec(e),
      startIn: inSec,
      startOut: outSec,
    })
  }

  useEffect(() => {
    if (!drag) return
    const onMove = (e) => {
      const sec = eventToSec(e)
      if (drag.mode === 'in') {
        const newIn = Math.max(0, Math.min(sec, drag.startOut - MIN_RANGE_SEC))
        onChange({ inSec: newIn, outSec: drag.startOut })
        // 拖左把手 → 主预览实时跳到入点这一帧
        onSeek?.(newIn)
      } else if (drag.mode === 'out') {
        const newOut = Math.min(
          duration,
          Math.max(sec, drag.startIn + MIN_RANGE_SEC),
        )
        onChange({ inSec: drag.startIn, outSec: newOut })
        // 拖右把手 → 主预览实时跳到出点这一帧
        onSeek?.(newOut)
      } else if (drag.mode === 'region') {
        const delta = sec - drag.startSec
        const len = drag.startOut - drag.startIn
        let newIn = drag.startIn + delta
        if (newIn < 0) newIn = 0
        if (newIn + len > duration) newIn = duration - len
        onChange({ inSec: newIn, outSec: newIn + len })
        onSeek?.(newIn)
      }
    }
    const onUp = () => {
      setDrag(null)
      scheduleRecompute()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, duration, eventToSec, onChange, onSeek, scheduleRecompute])

  const onStripClick = (e) => {
    // 点击非选区直接 seek 到那里；选区内点击让 region drag 处理（不会走到这里）
    if (drag) return
    const sec = eventToSec(e)
    onSeek?.(sec)
  }

  const winStart = viewWindow?.startSec ?? 0
  const winEnd = viewWindow?.endSec ?? duration ?? 0
  const winSpan = Math.max(0, winEnd - winStart)
  const inPct = winSpan
    ? Math.max(0, Math.min(100, ((inSec - winStart) / winSpan) * 100))
    : 0
  const outPct = winSpan
    ? Math.max(0, Math.min(100, ((outSec - winStart) / winSpan) * 100))
    : 100
  const playPct =
    winSpan && Number.isFinite(currentTime)
      ? Math.max(0, Math.min(100, ((currentTime - winStart) / winSpan) * 100))
      : null

  return (
    <div className="timeline">
      <div className="timeline-row">
        {onTogglePlay && (
          <button
            type="button"
            className="tl-play-btn"
            onClick={onTogglePlay}
            aria-label={isPlaying ? '暂停' : '播放'}
            title={isPlaying ? '暂停 (Space)' : '播放 (Space)'}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
        )}
        <div
          className={`timeline-strip ${drag ? 'dragging' : ''}`}
          ref={stripRef}
          onMouseDown={(e) => {
            // 在非把手 / 非选区位置按下：当作 seek
            if (e.target === e.currentTarget || e.target.classList.contains('tl-thumb')) {
              onStripClick(e)
            }
          }}
        >
        <div className="tl-thumbs" ref={thumbsContainerRef}>
          {(thumbs.length > 0 ? thumbs : Array(THUMB_COUNT).fill(null)).map(
            (t, i) => (
              <div key={i} className="tl-thumb">
                <div className="tl-thumb-tex" />
                {t && (
                  <img
                    className={`tl-thumb-img ${newThumbsRevealed ? '' : 'pending'}`}
                    src={t.url}
                    alt=""
                    draggable={false}
                  />
                )}
              </div>
            ),
          )}
        </div>
        {prevWindowOverlay && (
          <div
            key={prevWindowOverlay.key}
            ref={prevOverlayRef}
            className="tl-thumbs tl-thumbs-prev"
          >
            {prevWindowOverlay.thumbs.map((t, i) => (
              <div key={i} className="tl-thumb">
                <div className="tl-thumb-tex" />
                {t && (
                  <img
                    className="tl-thumb-img"
                    src={t.url}
                    alt=""
                    draggable={false}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="tl-dim tl-dim-left" style={{ width: `${inPct}%` }} />
        <div
          className="tl-dim tl-dim-right"
          style={{ width: `${Math.max(0, 100 - outPct)}%` }}
        />

        <div
          className="tl-selection"
          style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
          onMouseDown={(e) => beginDrag('region', e)}
        >
          <div
            className="tl-handle tl-handle-in"
            onMouseDown={(e) => beginDrag('in', e)}
          />
          <div
            className="tl-handle tl-handle-out"
            onMouseDown={(e) => beginDrag('out', e)}
          />
        </div>

        {playPct != null && playPct >= 0 && playPct <= 100 && (
          <div className="tl-playhead" style={{ left: `${playPct}%` }} />
        )}

        {loading && <div className="tl-loading">生成缩略图中…</div>}
        </div>
      </div>

      <div className="timeline-times">
        <span>{fmtTime(inSec)}</span>
        <span className="dur">选中 {fmtTime(outSec - inSec)}</span>
        <span>{fmtTime(outSec)}</span>
      </div>
    </div>
  )
}
