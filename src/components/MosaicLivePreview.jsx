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
  clipRect,
}) {
  const canvasRef = useRef(null)
  const tempCanvasRef = useRef(null)
  const offscreenRef = useRef(null)
  const regionsRef = useRef(regions)
  const blockSizeRef = useRef(blockSize)
  const offsetRef = useRef(sourceOffset)
  const clipRectRef = useRef(clipRect)

  useEffect(() => {
    regionsRef.current = regions
  }, [regions])
  useEffect(() => {
    blockSizeRef.current = blockSize
  }, [blockSize])
  useEffect(() => {
    offsetRef.current = sourceOffset
  }, [sourceOffset])
  useEffect(() => {
    clipRectRef.current = clipRect
  }, [clipRect])

  const drawFrame = (canvas, video, tempCanvas) => {
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d', { alpha: true })
    const regs = regionsRef.current
    if (!regs || regs.length === 0) {
      ctx.clearRect(0, 0, videoWidth, videoHeight)
      return
    }
    // 双缓冲：先把整套 mosaic 画到 offscreen，全失败就不动主 canvas（避免闪空）；
    // 任何一块画成了就原子替换。连续 scrub 中 readyState 抖动也不会卡旧帧 ——
    // 浏览器 drawImage 会用最近一次解码到的视频内容作为源。
    if (!offscreenRef.current) {
      offscreenRef.current = document.createElement('canvas')
    }
    const off = offscreenRef.current
    if (off.width !== videoWidth || off.height !== videoHeight) {
      off.width = videoWidth
      off.height = videoHeight
    }
    const offCtx = off.getContext('2d', { alpha: true })
    offCtx.clearRect(0, 0, videoWidth, videoHeight)
    const bs = blockSizeRef.current
    const ox = offsetRef.current?.x || 0
    const oy = offsetRef.current?.y || 0
    let okCount = 0
    for (const r of regs) {
      if (r.width < 4 || r.height < 4) continue
      try {
        offCtx.drawImage(
          video,
          r.x + ox, r.y + oy, r.width, r.height,
          r.x, r.y, r.width, r.height,
        )
        applyMosaicToRegion(offCtx, tempCanvas, r, bs)
        okCount++
      } catch {
        // 视频未就绪到这块像素：本帧整体放弃，保留上次结果
      }
    }
    if (okCount === 0) return
    ctx.clearRect(0, 0, videoWidth, videoHeight)
    const clip = clipRectRef.current
    if (clip) {
      // 视觉上限制到 clipRect 范围；offscreen 上 mosaic 是按 region 全尺寸算的
      // block，所以拖 crop 边缘时 block 网格不抖
      ctx.save()
      ctx.beginPath()
      ctx.rect(clip.x, clip.y, clip.width, clip.height)
      ctx.clip()
      ctx.drawImage(off, 0, 0)
      ctx.restore()
    } else {
      ctx.drawImage(off, 0, 0)
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

    // 双信号 dirty 标志：
    // - currentTime 变 → 用户在 scrub（设了新值，但视频元素可能还显示旧帧）
    // - rvfc / seeked → 新帧真的呈现了（用来覆盖第一次 scrub 抓到旧像素的情况）
    // 任一信号都标 dirty，raf 见 dirty 才 drawFrame，避免卡旧帧；
    // 静止画面下 dirty 一直 false → drawFrame 跳过，不烧 CPU。
    let stopped = false
    let rafId = null
    let rvfcId = null
    let lastSeenTime = -1
    let frameDirty = true

    const markDirty = () => { frameDirty = true }

    if (typeof video.requestVideoFrameCallback === 'function') {
      const onRvfc = () => {
        if (stopped) return
        frameDirty = true
        rvfcId = video.requestVideoFrameCallback(onRvfc)
      }
      rvfcId = video.requestVideoFrameCallback(onRvfc)
    }
    video.addEventListener('seeked', markDirty)
    video.addEventListener('timeupdate', markDirty)

    const tick = () => {
      if (stopped) return
      const t = video.currentTime
      if (t !== lastSeenTime) {
        frameDirty = true
        lastSeenTime = t
      }
      if (frameDirty) {
        drawFrame(canvas, video, tempCanvas)
        frameDirty = false
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      stopped = true
      video.removeEventListener('seeked', markDirty)
      video.removeEventListener('timeupdate', markDirty)
      if (rvfcId != null && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(rvfcId)
      }
      if (rafId != null) cancelAnimationFrame(rafId)
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
