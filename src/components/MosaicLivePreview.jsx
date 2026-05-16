import { useEffect, useRef } from 'react'
import { applyMosaicToRegion } from '../lib/mosaic.js'

/**
 * 实时打码预览：在视频上方叠一层 canvas。
 *
 * regions 用画布坐标（= 当前可见画面的像素空间，crop 后就是 crop 内的坐标）。
 * sourceOffset 描述"画布的 (0,0) 对应到源视频里的什么位置"，
 * 用来让 drawImage 从源视频正确位置读像素：
 *   src = (r.x + sourceOffset.x, r.y + sourceOffset.y, r.w, r.h)
 *   dst = (r.x, r.y, r.w, r.h)
 *
 * 没有 crop 时 sourceOffset 为 {0,0}，行为同纯 source 视图。
 */
export default function MosaicLivePreview({
  videoRef,
  videoWidth,
  videoHeight,
  regions,
  blockSize,
  sourceOffset,
}) {
  const canvasRef = useRef(null)
  const tempCanvasRef = useRef(null)
  const regionsRef = useRef(regions)
  const blockSizeRef = useRef(blockSize)
  const offsetRef = useRef(sourceOffset)

  useEffect(() => {
    regionsRef.current = regions
  }, [regions])
  useEffect(() => {
    blockSizeRef.current = blockSize
  }, [blockSize])
  useEffect(() => {
    offsetRef.current = sourceOffset
  }, [sourceOffset])

  const drawFrame = (canvas, video, tempCanvas) => {
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d', { alpha: true })
    ctx.clearRect(0, 0, videoWidth, videoHeight)
    if (video.readyState < 2) return
    const regs = regionsRef.current
    const bs = blockSizeRef.current
    if (!regs || regs.length === 0) return
    const ox = offsetRef.current?.x || 0
    const oy = offsetRef.current?.y || 0
    for (const r of regs) {
      if (r.width < 4 || r.height < 4) continue
      try {
        ctx.drawImage(
          video,
          r.x + ox, r.y + oy, r.width, r.height,
          r.x, r.y, r.width, r.height,
        )
        applyMosaicToRegion(ctx, tempCanvas, r, bs)
      } catch {
        // 视频还没就绪等，下一帧再来
      }
    }
  }

  // 主循环：每个新视频帧绘一次
  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    canvas.width = videoWidth
    canvas.height = videoHeight
    if (!tempCanvasRef.current) {
      tempCanvasRef.current = document.createElement('canvas')
    }
    const tempCanvas = tempCanvasRef.current

    let stopped = false
    let pendingId = null
    const useRvfc = typeof video.requestVideoFrameCallback === 'function'

    const tick = () => {
      if (stopped) return
      drawFrame(canvas, video, tempCanvas)
      if (useRvfc) {
        pendingId = video.requestVideoFrameCallback(tick)
      } else {
        pendingId = requestAnimationFrame(tick)
      }
    }
    tick()

    return () => {
      stopped = true
      if (pendingId != null) {
        if (useRvfc && video.cancelVideoFrameCallback) {
          video.cancelVideoFrameCallback(pendingId)
        } else if (!useRvfc) {
          cancelAnimationFrame(pendingId)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, videoWidth, videoHeight])

  // 框/粒度/offset 变化时即时重绘（视频暂停时尤其需要）
  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    const tempCanvas = tempCanvasRef.current
    if (canvas && video && tempCanvas) {
      drawFrame(canvas, video, tempCanvas)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, blockSize, sourceOffset, videoWidth, videoHeight])

  return <canvas ref={canvasRef} className="mosaic-live-canvas" />
}
