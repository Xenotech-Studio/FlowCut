import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_EDITS,
  isEditsEmpty,
  renderEdits,
  createRenderCache,
  clearRenderCache,
} from './lib/render.js'
import { extractClipInfo } from './lib/thumbnails.js'
import CropOverlay from './components/CropOverlay.jsx'
import MosaicOverlay from './components/MosaicOverlay.jsx'
import MosaicLivePreview from './components/MosaicLivePreview.jsx'
import Timeline from './components/Timeline.jsx'
import Toolbar from './components/Toolbar.jsx'
import ClipChip from './components/ClipChip.jsx'
import PlayerControls from './components/PlayerControls.jsx'
import VersionFooter from './components/VersionFooter.jsx'
import './App.css'

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

function fmtDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function centeredAspect(vw, vh, aspectW, aspectH) {
  const ratio = aspectW / aspectH
  let w, h
  if (vw / vh > ratio) {
    h = vh
    w = Math.round(h * ratio)
  } else {
    w = vw
    h = Math.round(w / ratio)
  }
  w = Math.max(2, w & ~1)
  h = Math.max(2, h & ~1)
  return {
    x: Math.round((vw - w) / 2) & ~1,
    y: Math.round((vh - h) / 2) & ~1,
    width: w,
    height: h,
  }
}

const ASPECTS = [
  { label: '全图', kind: 'full' },
  { label: '1:1', kind: 'ratio', w: 1, h: 1 },
  { label: '16:9', kind: 'ratio', w: 16, h: 9 },
  { label: '9:16', kind: 'ratio', w: 9, h: 16 },
  { label: '4:3', kind: 'ratio', w: 4, h: 3 },
  { label: '4:5', kind: 'ratio', w: 4, h: 5 },
]

const EDITS_STACK_LIMIT = 50

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function App() {
  const [sourceFile, setSourceFile] = useState(null)
  const [sourceInfo, setSourceInfo] = useState(null)
  const [sourceUrl, setSourceUrl] = useState(null)

  // 真相源
  const [edits, setEdits] = useState(EMPTY_EDITS)
  const [editsStack, setEditsStack] = useState([])

  const [activeTool, setActiveTool] = useState(null)

  // 工具临时状态
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [crop, setCrop] = useState(null)
  const [mosaicRegions, setMosaicRegions] = useState([])
  const [mosaicBlockSize, setMosaicBlockSize] = useState(16)

  // 导出态
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(null)
  const [exportLast, setExportLast] = useState(null) // { timing, size }
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  const videoRef = useRef(null)
  const editsStackRef = useRef(editsStack)
  useEffect(() => {
    editsStackRef.current = editsStack
  }, [editsStack])
  const editsRef = useRef(edits)
  useEffect(() => {
    editsRef.current = edits
  }, [edits])
  const activeToolRef = useRef(activeTool)
  useEffect(() => {
    activeToolRef.current = activeTool
  }, [activeTool])

  // 中间结果缓存：仅在导出时被使用 / 写入
  const renderCacheRef = useRef(createRenderCache())

  const edited = !isEditsEmpty(edits)

  // 是否在显示中应用 crop（trim / crop 工具激活时显示源以便重新框选）
  const shouldCSSCrop =
    !!edits.crop && activeTool !== 'crop' && activeTool !== 'trim'
  // mosaic 是否要叠在画面上
  const shouldOverlayMosaic =
    edits.mosaic &&
    edits.mosaic.regions.length > 0 &&
    activeTool !== 'mosaic' &&
    activeTool !== 'trim' &&
    activeTool !== 'crop'

  // 容器 aspect：trim/crop 工具激活时按源；其他时候按 crop（若设过）
  const containerAspect = useMemo(() => {
    if (!sourceInfo) return undefined
    if (activeTool === 'trim' || activeTool === 'crop') {
      return `${sourceInfo.width} / ${sourceInfo.height}`
    }
    if (edits.crop) return `${edits.crop.width} / ${edits.crop.height}`
    return `${sourceInfo.width} / ${sourceInfo.height}`
  }, [activeTool, edits.crop, sourceInfo])

  // CSS crop inline style：把 video 放大并平移，让 crop 区刚好填满容器
  const videoCropStyle = useMemo(() => {
    if (!shouldCSSCrop || !sourceInfo) return undefined
    const c = edits.crop
    return {
      position: 'absolute',
      width: `${(sourceInfo.width / c.width) * 100}%`,
      height: `${(sourceInfo.height / c.height) * 100}%`,
      left: `${(-c.x / c.width) * 100}%`,
      top: `${(-c.y / c.height) * 100}%`,
      maxWidth: 'none',
      maxHeight: 'none',
      objectFit: 'fill',
    }
  }, [shouldCSSCrop, edits.crop, sourceInfo])

  // mosaic 实时预览的画布尺寸：CSS crop 时 = crop 尺寸，否则 = 源尺寸
  const previewCanvasDims = useMemo(() => {
    if (!sourceInfo) return null
    if (activeTool === 'crop' || activeTool === 'trim') {
      return { w: sourceInfo.width, h: sourceInfo.height }
    }
    if (edits.crop) return { w: edits.crop.width, h: edits.crop.height }
    return { w: sourceInfo.width, h: sourceInfo.height }
  }, [activeTool, edits.crop, sourceInfo])

  // mosaic 实时预览的 source 偏移
  const previewSourceOffset = useMemo(() => {
    if (shouldCSSCrop && edits.crop) {
      return { x: edits.crop.x, y: edits.crop.y }
    }
    if (activeTool === 'mosaic' && edits.crop) {
      // mosaic 工具时也按 edits.crop 偏移（因为 mosaic 工具看的是 cropped 视图）
      return { x: edits.crop.x, y: edits.crop.y }
    }
    return { x: 0, y: 0 }
  }, [shouldCSSCrop, activeTool, edits.crop])

  // 给"非工具态"的 MosaicLivePreview 准备显示坐标的 regions
  const overlayMosaicRegions = useMemo(() => {
    if (!shouldOverlayMosaic) return []
    const off = edits.crop ? { x: edits.crop.x, y: edits.crop.y } : { x: 0, y: 0 }
    return edits.mosaic.regions.map((r) => ({
      ...r,
      x: r.x - off.x,
      y: r.y - off.y,
    }))
  }, [shouldOverlayMosaic, edits.mosaic, edits.crop])

  // 源 URL 与元信息
  useEffect(() => {
    if (!sourceFile) {
      setSourceInfo(null)
      return
    }
    let cancelled = false
    extractClipInfo(sourceFile)
      .then((info) => {
        if (!cancelled) setSourceInfo(info)
      })
      .catch((e) => {
        if (!cancelled) console.warn('[FlowCut] extractClipInfo failed', e)
      })
    return () => {
      cancelled = true
    }
  }, [sourceFile])

  useEffect(() => {
    if (!sourceFile) {
      setSourceUrl(null)
      return
    }
    const url = URL.createObjectURL(sourceFile)
    setSourceUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [sourceFile])

  // 同步播放/暂停状态
  useEffect(() => {
    if (!sourceFile) {
      setIsPlaying(false)
      return
    }
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    setIsPlaying(!v.paused)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [sourceFile])

  // 当前生效的 trim：trim 工具激活时用正在拖的 in/out，其他时候用已保存的
  const effectiveTrim = useMemo(() => {
    if (activeTool === 'trim') return { startSec: inSec, endSec: outSec }
    return edits.trim
  }, [activeTool, inSec, outSec, edits.trim])
  const effectiveTrimRef = useRef(effectiveTrim)
  useEffect(() => {
    effectiveTrimRef.current = effectiveTrim
  }, [effectiveTrim])

  // PlayerControls 的 scrubber 视窗：trim 工具激活时显示全源 + 黄色高亮，
  // 其他时候若 trim 已应用则只覆盖 trim 区间
  const scrubberWindow = useMemo(() => {
    if (activeTool === 'trim') return null
    return edits.trim
  }, [activeTool, edits.trim])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      // 当前 trim 有效时：currentTime 在区间外 / 已到末尾 → 先 seek 回起点
      const t = effectiveTrimRef.current
      if (t && (v.currentTime >= t.endSec - 0.05 || v.currentTime < t.startSec)) {
        v.currentTime = t.startSec
      }
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [])

  // Space 键全局切换播放/暂停
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return
      if (!sourceFile) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sourceFile, togglePlay])

  // 播放越界检测：只在"真在播放且越过 trim 末尾"时暂停 + 回起点。
  // 用 setInterval 而不是 timeupdate，避免误伤手动 scrub。
  useEffect(() => {
    if (!sourceFile) return
    const v = videoRef.current
    if (!v) return
    let intervalId = null
    const startPolling = () => {
      if (intervalId) return
      intervalId = setInterval(() => {
        const t = effectiveTrimRef.current
        if (!t || v.paused) return
        if (v.currentTime > t.endSec + 0.05) {
          v.pause()
          v.currentTime = t.startSec
        }
      }, 50)
    }
    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
    }
    if (!v.paused) startPolling()
    v.addEventListener('play', startPolling)
    v.addEventListener('pause', stopPolling)
    return () => {
      v.removeEventListener('play', startPolling)
      v.removeEventListener('pause', stopPolling)
      stopPolling()
    }
  }, [sourceFile])

  // scrubberWindow 切换时（例如刚 apply 完 trim / 进了别的工具），
  // 把 currentTime 拉回窗口内，避免播放条显示越界
  useEffect(() => {
    if (!scrubberWindow) return
    const v = videoRef.current
    if (!v) return
    const { startSec, endSec } = scrubberWindow
    if (v.currentTime < startSec || v.currentTime > endSec) {
      v.currentTime = startSec
    }
  }, [scrubberWindow])

  const acceptFile = useCallback((f) => {
    if (!f) return
    if (!/\.(mp4|mov|m4v)$/i.test(f.name)) {
      setError('暂时只支持 mp4 / mov / m4v')
      return
    }
    setError(null)
    setExportLast(null)
    setActiveTool(null)
    setEdits(EMPTY_EDITS)
    setEditsStack([])
    clearRenderCache(renderCacheRef.current)
    setSourceFile(f)
    setSourceInfo(null)
  }, [])

  const onPick = (e) => acceptFile(e.target.files?.[0])
  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    acceptFile(e.dataTransfer.files?.[0])
  }

  const onMeta = () => {
    setCurrentTime(0)
    const v = videoRef.current
    if (v && scrubberWindow) {
      v.currentTime = scrubberWindow.startSec
    }
  }

  const onTimeUpdate = () => {
    const v = videoRef.current
    if (v) setCurrentTime(v.currentTime)
  }

  const onTimelineChange = useCallback(({ inSec: i, outSec: o }) => {
    setInSec(i)
    setOutSec(o)
    if (videoRef.current && Math.abs(videoRef.current.currentTime - i) > 0.05) {
      videoRef.current.currentTime = i
    }
  }, [])

  const onTimelineSeek = useCallback((sec) => {
    if (videoRef.current) videoRef.current.currentTime = sec
  }, [])

  const onPickTool = (id) => {
    if (exporting) return
    if (activeTool === id) {
      setActiveTool(null)
      return
    }
    setActiveTool(id)
    setError(null)
    setExportLast(null)
    if (id === 'trim') {
      setInSec(edits.trim?.startSec ?? 0)
      setOutSec(edits.trim?.endSec ?? sourceInfo?.duration ?? 0)
    } else if (id === 'crop') {
      if (edits.crop) {
        setCrop({ ...edits.crop })
      } else if (sourceInfo) {
        setCrop(centeredAspect(sourceInfo.width, sourceInfo.height, 1, 1))
      }
    } else if (id === 'mosaic') {
      // 把存的 source 坐标 region 转成显示坐标（= 减去 crop 偏移）
      const off = edits.crop ? { x: edits.crop.x, y: edits.crop.y } : { x: 0, y: 0 }
      const displayed = (edits.mosaic?.regions || []).map((r) => ({
        ...r,
        x: r.x - off.x,
        y: r.y - off.y,
      }))
      setMosaicRegions(displayed)
      setMosaicBlockSize(edits.mosaic?.blockSize ?? 16)
    }
  }

  const setAspect = (a) => {
    if (!sourceInfo) return
    if (a.kind === 'full') {
      setCrop({
        x: 0,
        y: 0,
        width: sourceInfo.width & ~1,
        height: sourceInfo.height & ~1,
      })
    } else {
      setCrop(centeredAspect(sourceInfo.width, sourceInfo.height, a.w, a.h))
    }
  }

  const cancelTool = () => {
    if (exporting) return
    setActiveTool(null)
  }

  const pushEditsSnapshot = () => {
    setEditsStack((prev) => {
      const next = [...prev, edits]
      return next.length > EDITS_STACK_LIMIT ? next.slice(-EDITS_STACK_LIMIT) : next
    })
  }

  const confirmTool = () => {
    if (!activeTool || !sourceFile || exporting) return
    let nextEdits = edits
    if (activeTool === 'trim') {
      nextEdits = { ...edits, trim: { startSec: inSec, endSec: outSec } }
    } else if (activeTool === 'crop') {
      if (!crop) return
      nextEdits = { ...edits, crop: { ...crop } }
    } else if (activeTool === 'mosaic') {
      const off = edits.crop ? { x: edits.crop.x, y: edits.crop.y } : { x: 0, y: 0 }
      const sourceRegions = mosaicRegions.map((r) => ({
        ...r,
        x: r.x + off.x,
        y: r.y + off.y,
      }))
      nextEdits = {
        ...edits,
        mosaic:
          sourceRegions.length > 0
            ? { regions: sourceRegions, blockSize: mosaicBlockSize }
            : null,
      }
    } else {
      return
    }
    pushEditsSnapshot()
    setEdits(nextEdits)
    setActiveTool(null)
  }

  const resetEdits = () => {
    if (exporting || isEditsEmpty(edits)) return
    pushEditsSnapshot()
    setEdits(EMPTY_EDITS)
    setActiveTool(null)
    setExportLast(null)
  }

  const undo = useCallback(() => {
    if (exporting) return
    const stack = editsStackRef.current
    if (stack.length === 0) return
    const target = stack[stack.length - 1]
    setEditsStack((prev) => prev.slice(0, -1))
    setEdits(target)
    setActiveTool(null)
    setExportLast(null)
  }, [exporting])

  // ⌘Z / Ctrl+Z 撤销
  useEffect(() => {
    const onKey = (e) => {
      const z = e.key === 'z' || e.key === 'Z'
      if (z && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (exporting) return
        const tag = e.target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (editsStackRef.current.length === 0) return
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exporting, undo])

  const onExport = async () => {
    if (!sourceFile || exporting) return
    if (isEditsEmpty(edits)) {
      // 没编辑就直接给源文件（用户其实也已经有原始文件了，但允许一致行为）
      downloadBlob(sourceFile, sourceFile.name)
      return
    }
    setExporting(true)
    setError(null)
    setExportProgress({ phase: 'starting' })
    setExportLast(null)
    try {
      const { blob, timing, cached } = await renderEdits(
        sourceFile,
        edits,
        renderCacheRef.current,
        setExportProgress,
      )
      const filename =
        sourceFile.name.replace(/\.(mp4|mov|m4v)$/i, '') + '.out.mp4'
      downloadBlob(blob, filename)
      setExportLast({ timing, size: blob.size, cached })
    } catch (e) {
      console.error(e)
      setError(e.message || String(e))
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  // 编辑摘要（给 ClipChip 显示）
  const editsSummary = useMemo(() => {
    const parts = []
    if (edits.trim) {
      parts.push(`Trim ${fmtTime(edits.trim.endSec - edits.trim.startSec)}`)
    }
    if (edits.crop) {
      parts.push(`Crop ${edits.crop.width}×${edits.crop.height}`)
    }
    if (edits.mosaic && edits.mosaic.regions.length > 0) {
      parts.push(`${edits.mosaic.regions.length} 个打码区`)
    }
    return parts.join(' · ')
  }, [edits])

  // 可应用条件
  const canConfirmTrim =
    activeTool === 'trim' && sourceInfo && outSec - inSec > 0.1
  const canConfirmCrop =
    activeTool === 'crop' && crop && crop.width >= 16 && crop.height >= 16
  const canConfirmMosaic = activeTool === 'mosaic' // 允许保存空 = 清空 mosaic
  const canConfirm =
    !exporting && (canConfirmTrim || canConfirmCrop || canConfirmMosaic)

  const exportLabel = useMemo(() => {
    if (!exportProgress) return ''
    const p = exportProgress
    if (p.phase === 'starting') return '准备中…'
    if (p.stage) {
      const name =
        p.stage === 'trim' ? 'Trim' : p.stage === 'crop' ? 'Crop' : '打码'
      const head = `${name} ${p.stageIdx}/${p.totalStages}`
      const sub = p.sub
      if (sub?.phase === 'parsing' && sub.total) {
        return `${head} · 解析 ${Math.floor((sub.loaded / sub.total) * 100)}%`
      }
      if (sub?.phase === 'transcoding' && sub.total) {
        return `${head} · 重编码 ${Math.floor((sub.loaded / sub.total) * 100)}%`
      }
      if (sub?.phase === 'muxing' && sub.total) {
        return `${head} · 搬运 ${Math.floor((sub.loaded / sub.total) * 100)}%`
      }
      return head
    }
    return p.phase
  }, [exportProgress])

  return (
    <div className="app">
      {sourceFile && (
        <div className="app-bar">
          <ClipChip
            sourceInfo={sourceInfo}
            editsSummary={editsSummary}
            edited={edited}
            disabled={exporting}
            onReset={resetEdits}
            onPickFile={acceptFile}
          />
          <div className="app-bar-actions">
            <button
              type="button"
              className="undo-btn"
              onClick={undo}
              disabled={editsStack.length === 0 || exporting}
              title={
                editsStack.length > 0
                  ? `撤销  ⌘Z (撤销栈 ${editsStack.length} 层)`
                  : '没有可撤销的操作'
              }
              aria-label="撤销"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7v6h6" />
                <path d="M3 13a9 9 0 1 0 3-6.7L3 9" />
              </svg>
              <span>撤销</span>
            </button>
            <button
              type="button"
              className="export-btn"
              onClick={onExport}
              disabled={!sourceFile || exporting}
              title={
                exporting
                  ? '正在导出'
                  : edited
                    ? '渲染并下载当前编辑的视频'
                    : '没有编辑，下载源文件'
              }
            >
              {exporting ? `导出中 · ${exportLabel}` : '导出'}
            </button>
          </div>
        </div>
      )}

      {!sourceFile && (
        <div
          className={`drop ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <div className="drop-title">把视频拖进来</div>
          <div className="drop-sub">或</div>
          <label className="drop-btn">
            选择文件
            <input
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
              onChange={onPick}
            />
          </label>
          <div className="drop-hint">mp4 / mov / m4v · 仅在本地处理，不上传</div>
        </div>
      )}

      {sourceFile && (
        <div className="editor">
          <div className="player">
            <div
              className={`player-area ${shouldCSSCrop ? 'with-css-crop' : ''}`}
              style={{ aspectRatio: containerAspect }}
            >
              <video
                ref={videoRef}
                src={sourceUrl || undefined}
                onLoadedMetadata={onMeta}
                onTimeUpdate={onTimeUpdate}
                onClick={togglePlay}
                style={videoCropStyle}
              />
              {shouldOverlayMosaic && previewCanvasDims && (
                <MosaicLivePreview
                  videoRef={videoRef}
                  videoWidth={previewCanvasDims.w}
                  videoHeight={previewCanvasDims.h}
                  regions={overlayMosaicRegions}
                  blockSize={edits.mosaic.blockSize}
                  sourceOffset={previewSourceOffset}
                />
              )}
              {activeTool === 'crop' && sourceInfo && (
                <CropOverlay
                  videoWidth={sourceInfo.width}
                  videoHeight={sourceInfo.height}
                  crop={crop}
                  onChange={setCrop}
                />
              )}
              {activeTool === 'mosaic' && previewCanvasDims && (
                <>
                  <MosaicLivePreview
                    videoRef={videoRef}
                    videoWidth={previewCanvasDims.w}
                    videoHeight={previewCanvasDims.h}
                    regions={mosaicRegions}
                    blockSize={mosaicBlockSize}
                    sourceOffset={previewSourceOffset}
                  />
                  <MosaicOverlay
                    videoWidth={previewCanvasDims.w}
                    videoHeight={previewCanvasDims.h}
                    regions={mosaicRegions}
                    onChange={setMosaicRegions}
                  />
                </>
              )}
              <Toolbar active={activeTool} onChange={onPickTool} locked={exporting} />
              {sourceInfo && activeTool !== 'trim' && (
                <PlayerControls
                  videoRef={videoRef}
                  duration={sourceInfo.duration}
                  currentTime={currentTime}
                  viewWindow={scrubberWindow}
                  trim={null}
                  isPlaying={isPlaying}
                  onTogglePlay={togglePlay}
                />
              )}
            </div>
          </div>

          {exportLast && !activeTool && !error && !exporting && (
            <div className="op-toast">
              ✓ 已导出 ·{' '}
              {exportLast.cached ? '缓存命中' : fmtDuration(exportLast.timing.totalMs)} ·{' '}
              {fmtBytes(exportLast.size)}
            </div>
          )}

          {error && <div className="error">出错了：{error}</div>}

          {activeTool && (
            <div className="tool-panel">
              <div className="tool-panel-body">
                {activeTool === 'trim' && sourceInfo && (
                  <Timeline
                    videoUrl={sourceUrl}
                    duration={sourceInfo.duration}
                    inSec={inSec}
                    outSec={outSec}
                    currentTime={currentTime}
                    onChange={onTimelineChange}
                    onSeek={onTimelineSeek}
                    isPlaying={isPlaying}
                    onTogglePlay={togglePlay}
                  />
                )}
                {activeTool === 'crop' && (
                  <div className="crop-options">
                    <div className="aspect-presets">
                      {ASPECTS.map((a) => (
                        <button key={a.label} onClick={() => setAspect(a)}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                    {crop && (
                      <div className="crop-info">
                        {crop.width}×{crop.height} @ ({crop.x}, {crop.y}) ·
                        拖角调整 / 拖中间平移 · 源坐标
                      </div>
                    )}
                  </div>
                )}
                {activeTool === 'mosaic' && (
                  <div className="mosaic-options">
                    <div className="mosaic-info">
                      已添加 {mosaicRegions.length} 个打码区
                      {edits.crop && '（坐标在 crop 后画面内）'}
                    </div>
                    <div className="mosaic-slider">
                      <label>马赛克粒度</label>
                      <input
                        type="range"
                        min={4}
                        max={48}
                        step={1}
                        value={mosaicBlockSize}
                        onChange={(e) =>
                          setMosaicBlockSize(Number(e.target.value))
                        }
                      />
                      <span className="mosaic-size-val">{mosaicBlockSize}px</span>
                    </div>
                    <div className="mosaic-hint">
                      在视频上拖出矩形 → 选中可拖动/调角/点 × 删除 ·
                      粒度越大，马赛克块越粗
                    </div>
                  </div>
                )}
              </div>
              <div className="tool-actions">
                <button onClick={cancelTool} disabled={exporting}>
                  取消
                </button>
                <button
                  className="primary"
                  onClick={confirmTool}
                  disabled={!canConfirm}
                >
                  应用
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <VersionFooter />
    </div>
  )
}
