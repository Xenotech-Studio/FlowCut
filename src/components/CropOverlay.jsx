import { useEffect, useRef, useState } from 'react'

function clampCrop(c, maxW, maxH) {
  let { x, y, width, height } = c
  // 反向拖出来的负宽高，归一
  if (width < 0) {
    x = x + width
    width = -width
  }
  if (height < 0) {
    y = y + height
    height = -height
  }
  // H.264 要求偶数
  width = Math.max(2, Math.floor(width / 2) * 2)
  height = Math.max(2, Math.floor(height / 2) * 2)
  // 限制在源画面内
  x = Math.max(0, Math.min(Math.round(x), maxW - width))
  y = Math.max(0, Math.min(Math.round(y), maxH - height))
  // 防止 x+width 超出（来自上一步 round 后的偏差）
  if (x + width > maxW) width = (maxW - x) & ~1
  if (y + height > maxH) height = (maxH - y) & ~1
  return { x, y, width, height }
}

/**
 * crop in source pixel coords; null 表示未设置。
 * onChange 每次拖动都会触发一次。
 */
export default function CropOverlay({ videoWidth, videoHeight, crop, onChange }) {
  const ref = useRef(null)
  const [drag, setDrag] = useState(null)

  const eventToSrc = (e) => {
    const el = ref.current
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    const scaleX = videoWidth / rect.width
    const scaleY = videoHeight / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const beginDrag = (mode, e) => {
    e.preventDefault()
    e.stopPropagation()
    const p = eventToSrc(e)
    setDrag({
      mode,
      startSrcX: p.x,
      startSrcY: p.y,
      initialCrop: crop ? { ...crop } : null,
    })
  }

  useEffect(() => {
    if (!drag) return
    const onMove = (e) => {
      const p = eventToSrc(e)
      const dx = p.x - drag.startSrcX
      const dy = p.y - drag.startSrcY
      let next
      if (drag.mode === 'create') {
        next = {
          x: Math.min(drag.startSrcX, p.x),
          y: Math.min(drag.startSrcY, p.y),
          width: Math.abs(p.x - drag.startSrcX),
          height: Math.abs(p.y - drag.startSrcY),
        }
      } else if (drag.mode === 'move') {
        const init = drag.initialCrop
        next = { ...init, x: init.x + dx, y: init.y + dy }
      } else if (drag.mode.startsWith('resize-')) {
        const side = drag.mode.slice(7)
        const init = drag.initialCrop
        let { x, y, width: w, height: h } = init
        if (side.includes('n')) {
          y = init.y + dy
          h = init.height - dy
        }
        if (side.includes('s')) {
          h = init.height + dy
        }
        if (side.includes('w')) {
          x = init.x + dx
          w = init.width - dx
        }
        if (side.includes('e')) {
          w = init.width + dx
        }
        next = { x, y, width: w, height: h }
      }
      onChange(clampCrop(next, videoWidth, videoHeight))
    }
    const onUp = () => setDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, videoWidth, videoHeight, onChange])

  const visible = crop && crop.width > 0 && crop.height > 0
  const fmtPct = (v, total) => `${(v / total) * 100}%`

  return (
    <div
      ref={ref}
      className="crop-overlay"
      onMouseDown={(e) => beginDrag('create', e)}
    >
      {visible && (
        <>
          {/* 暗化区外侧 */}
          <div
            className="crop-mask"
            style={{
              clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                ${fmtPct(crop.x, videoWidth)} ${fmtPct(crop.y, videoHeight)},
                ${fmtPct(crop.x, videoWidth)} ${fmtPct(crop.y + crop.height, videoHeight)},
                ${fmtPct(crop.x + crop.width, videoWidth)} ${fmtPct(crop.y + crop.height, videoHeight)},
                ${fmtPct(crop.x + crop.width, videoWidth)} ${fmtPct(crop.y, videoHeight)},
                ${fmtPct(crop.x, videoWidth)} ${fmtPct(crop.y, videoHeight)})`,
            }}
          />
          <div
            className="crop-rect"
            style={{
              left: fmtPct(crop.x, videoWidth),
              top: fmtPct(crop.y, videoHeight),
              width: fmtPct(crop.width, videoWidth),
              height: fmtPct(crop.height, videoHeight),
            }}
            onMouseDown={(e) => beginDrag('move', e)}
          >
            {['nw', 'ne', 'sw', 'se'].map((side) => (
              <div
                key={side}
                className={`crop-handle h-${side}`}
                onMouseDown={(e) => beginDrag(`resize-${side}`, e)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
