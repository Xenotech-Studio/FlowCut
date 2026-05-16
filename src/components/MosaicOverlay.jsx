import { useEffect, useRef, useState } from 'react'

function clampRegion(r, maxW, maxH) {
  let { x, y, width, height } = r
  if (width < 0) {
    x = x + width
    width = -width
  }
  if (height < 0) {
    y = y + height
    height = -height
  }
  width = Math.max(4, Math.round(width))
  height = Math.max(4, Math.round(height))
  x = Math.max(0, Math.min(Math.round(x), maxW - width))
  y = Math.max(0, Math.min(Math.round(y), maxH - height))
  if (x + width > maxW) width = maxW - x
  if (y + height > maxH) height = maxH - y
  return { ...r, x, y, width, height }
}

let _idSeq = 0
function newId() {
  _idSeq += 1
  return `m${Date.now().toString(36)}${_idSeq}`
}

/**
 * 多矩形打码区编辑器。regions 与 onChange 受控。
 * 在视频上拖空白处 = 画新框；点击已有框 = 选中；选中后能拖动/调角/× 删除。
 */
export default function MosaicOverlay({ videoWidth, videoHeight, regions, onChange }) {
  const ref = useRef(null)
  const [drag, setDrag] = useState(null)
  const [selectedId, setSelectedId] = useState(null)

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

  const beginCreate = (e) => {
    // 只对容器自身的按下生效（点到子元素被 stopPropagation 拦截）
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    const p = eventToSrc(e)
    const id = newId()
    const fresh = { id, x: p.x, y: p.y, width: 4, height: 4 }
    onChange([...regions, fresh])
    setSelectedId(id)
    setDrag({ mode: 'create', id, startSrcX: p.x, startSrcY: p.y, initial: fresh })
  }

  const beginInteract = (id, mode, e) => {
    e.preventDefault()
    e.stopPropagation()
    const target = regions.find((r) => r.id === id)
    if (!target) return
    const p = eventToSrc(e)
    setSelectedId(id)
    setDrag({
      mode,
      id,
      startSrcX: p.x,
      startSrcY: p.y,
      initial: { ...target },
    })
  }

  const deleteRegion = (id, e) => {
    e?.stopPropagation()
    onChange(regions.filter((r) => r.id !== id))
    setSelectedId((cur) => (cur === id ? null : cur))
  }

  useEffect(() => {
    if (!drag) return
    const onMove = (e) => {
      const p = eventToSrc(e)
      const dx = p.x - drag.startSrcX
      const dy = p.y - drag.startSrcY
      const next = regions.map((r) => {
        if (r.id !== drag.id) return r
        let u
        const init = drag.initial
        if (drag.mode === 'create') {
          u = {
            ...r,
            x: Math.min(drag.startSrcX, p.x),
            y: Math.min(drag.startSrcY, p.y),
            width: Math.abs(p.x - drag.startSrcX),
            height: Math.abs(p.y - drag.startSrcY),
          }
        } else if (drag.mode === 'move') {
          u = { ...init, x: init.x + dx, y: init.y + dy }
        } else if (drag.mode.startsWith('resize-')) {
          const side = drag.mode.slice(7)
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
          u = { ...init, x, y, width: w, height: h }
        }
        return clampRegion(u, videoWidth, videoHeight)
      })
      onChange(next)
    }
    const onUp = () => setDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, regions, videoWidth, videoHeight, onChange])

  const fmtPct = (v, total) => `${(v / total) * 100}%`

  return (
    <div ref={ref} className="mosaic-overlay" onMouseDown={beginCreate}>
      {regions.map((r) => (
        <div
          key={r.id}
          className={`mosaic-rect ${selectedId === r.id ? 'selected' : ''}`}
          style={{
            left: fmtPct(r.x, videoWidth),
            top: fmtPct(r.y, videoHeight),
            width: fmtPct(r.width, videoWidth),
            height: fmtPct(r.height, videoHeight),
          }}
          onMouseDown={(e) => beginInteract(r.id, 'move', e)}
        >
          {selectedId === r.id && (
            <>
              {['nw', 'ne', 'sw', 'se'].map((side) => (
                <div
                  key={side}
                  className={`mosaic-handle mh-${side}`}
                  onMouseDown={(e) => beginInteract(r.id, `resize-${side}`, e)}
                />
              ))}
              <button
                type="button"
                className="mosaic-delete"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => deleteRegion(r.id, e)}
                title="删除这个打码区"
              >
                ×
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
