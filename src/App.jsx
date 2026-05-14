import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { streamCopyTrim } from './lib/trim.js'
import { cropAndTrim } from './lib/crop.js'
import CropOverlay from './components/CropOverlay.jsx'
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
  const sec = (s - m * 60).toFixed(2)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(5, '0')}`
}

function applyAspect(crop, vw, vh, aspectW, aspectH) {
  // 在画面中央放一个指定宽高比的最大矩形
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

export default function App() {
  const [file, setFile] = useState(null)
  const [videoUrl, setVideoUrl] = useState(null)
  const [duration, setDuration] = useState(0)
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 })
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [cropEnabled, setCropEnabled] = useState(false)
  const [crop, setCrop] = useState(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const videoRef = useRef(null)

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  useEffect(() => {
    if (result?.url) return () => URL.revokeObjectURL(result.url)
  }, [result])

  const acceptFile = useCallback((f) => {
    if (!f) return
    if (!/\.(mp4|mov|m4v)$/i.test(f.name)) {
      setError('暂时只支持 mp4 / mov / m4v')
      return
    }
    setError(null)
    setResult(null)
    setCrop(null)
    setCropEnabled(false)
    setFile(f)
    const url = URL.createObjectURL(f)
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
  }, [])

  const onPick = (e) => acceptFile(e.target.files?.[0])
  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    acceptFile(e.dataTransfer.files?.[0])
  }

  const onMeta = () => {
    const v = videoRef.current
    if (!v) return
    setDuration(v.duration || 0)
    setInSec(0)
    setOutSec(v.duration || 0)
    setVideoSize({ w: v.videoWidth, h: v.videoHeight })
  }

  const toggleCrop = () => {
    setCropEnabled((on) => {
      const next = !on
      if (next && !crop && videoSize.w > 0) {
        setCrop(applyAspect(null, videoSize.w, videoSize.h, 1, 1))
      }
      return next
    })
  }

  const setAspect = (a) => {
    if (a.kind === 'full') {
      setCrop({ x: 0, y: 0, width: videoSize.w & ~1, height: videoSize.h & ~1 })
    } else {
      setCrop(applyAspect(null, videoSize.w, videoSize.h, a.w, a.h))
    }
  }

  const runTrim = async () => {
    if (!file || running) return
    setRunning(true)
    setProgress({ phase: 'starting' })
    setError(null)
    setResult(null)
    try {
      const out = await streamCopyTrim(file, {
        startSec: inSec,
        endSec: outSec,
        onProgress: setProgress,
      })
      const blob = new Blob([out.buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)
      setResult({
        kind: 'trim',
        url,
        size: blob.size,
        timing: out.timing,
        snapped: out.snapped,
        keptSamples: out.keptSamples,
        sourceSize: out.sourceSize,
        fileName: file.name.replace(/\.(mp4|mov|m4v)$/i, '') + '.trim.mp4',
      })
    } catch (e) {
      console.error(e)
      setError(e.message || String(e))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const runCrop = async () => {
    if (!file || running || !crop) return
    setRunning(true)
    setProgress({ phase: 'starting' })
    setError(null)
    setResult(null)
    try {
      const out = await cropAndTrim(file, {
        startSec: inSec,
        endSec: outSec,
        crop,
        onProgress: setProgress,
      })
      const blob = new Blob([out.buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)
      setResult({
        kind: 'crop',
        url,
        size: blob.size,
        timing: out.timing,
        outputFrames: out.outputFrames,
        outputResolution: out.outputResolution,
        sourceResolution: out.sourceResolution,
        encoder: out.encoder,
        sourceSize: out.sourceSize,
        fileName: file.name.replace(/\.(mp4|mov|m4v)$/i, '') + '.crop.mp4',
      })
    } catch (e) {
      console.error(e)
      setError(e.message || String(e))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const rangeDur = Math.max(0, outSec - inSec)
  const canTrim = !!file && !running && rangeDur > 0.1
  const canCrop = canTrim && cropEnabled && crop && crop.width >= 16 && crop.height >= 16

  const progressLabel = useMemo(() => {
    if (!progress) return ''
    if (progress.phase === 'starting') return '准备中...'
    if (progress.phase === 'parsing') {
      const pct = progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0
      return `解析 mp4 索引 ${pct}%`
    }
    if (progress.phase === 'muxing') {
      const pct = progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0
      return `搬运 sample ${pct}%`
    }
    if (progress.phase === 'transcoding') {
      const pct = progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0
      return `硬件重编码 ${pct}%`
    }
    return progress.phase
  }, [progress])

  return (
    <div className="app">
      <header className="header">
        <h1>FlowCut</h1>
        <span className="tagline">轻量化 · 超高导出速度</span>
        <span className="version">v{__WEB_VERSION__}</span>
      </header>

      {!file && (
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
            <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" onChange={onPick} />
          </label>
          <div className="drop-hint">mp4 / mov / m4v · 仅在本地处理，不上传</div>
        </div>
      )}

      {file && (
        <div className="editor">
          <div className="player">
            <div
              className="player-area"
              style={{
                aspectRatio: videoSize.w > 0 ? `${videoSize.w} / ${videoSize.h}` : undefined,
              }}
            >
              <video ref={videoRef} src={videoUrl} controls onLoadedMetadata={onMeta} />
              {cropEnabled && videoSize.w > 0 && (
                <CropOverlay
                  videoWidth={videoSize.w}
                  videoHeight={videoSize.h}
                  crop={crop}
                  onChange={setCrop}
                />
              )}
            </div>
            <div className="meta">
              <span>{file.name}</span>
              <span>{fmtBytes(file.size)}</span>
              <span>
                {videoSize.w}×{videoSize.h}
              </span>
              <span>时长 {fmtTime(duration)}</span>
              <button
                className="link"
                onClick={() => {
                  setFile(null)
                  setVideoUrl(null)
                  setResult(null)
                  setProgress(null)
                  setError(null)
                  setCrop(null)
                  setCropEnabled(false)
                }}
              >
                换一个
              </button>
            </div>
          </div>

          <div className="controls">
            <div className="range-row">
              <label>入点 {fmtTime(inSec)}</label>
              <input
                type="range"
                min={0}
                max={duration}
                step={0.01}
                value={inSec}
                onChange={(e) => {
                  const v = Math.min(Number(e.target.value), outSec - 0.1)
                  setInSec(v)
                  if (videoRef.current) videoRef.current.currentTime = v
                }}
              />
            </div>
            <div className="range-row">
              <label>出点 {fmtTime(outSec)}</label>
              <input
                type="range"
                min={0}
                max={duration}
                step={0.01}
                value={outSec}
                onChange={(e) => {
                  const v = Math.max(Number(e.target.value), inSec + 0.1)
                  setOutSec(v)
                  if (videoRef.current) videoRef.current.currentTime = v
                }}
              />
            </div>
            <div className="range-summary">选中片段 {fmtTime(rangeDur)}</div>

            <div className="crop-toggle-row">
              <label className="switch">
                <input type="checkbox" checked={cropEnabled} onChange={toggleCrop} />
                <span>启用画面裁剪（重编码）</span>
              </label>
              {cropEnabled && (
                <div className="aspect-presets">
                  {ASPECTS.map((a) => (
                    <button key={a.label} onClick={() => setAspect(a)}>
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {cropEnabled && crop && (
              <div className="crop-info">
                裁剪区域 {crop.width}×{crop.height} @ ({crop.x}, {crop.y}) · 直接在画面上拖角或拖中心
              </div>
            )}

            <div className="actions">
              {!cropEnabled ? (
                <button className="primary" onClick={runTrim} disabled={!canTrim}>
                  {running ? progressLabel : '极速 Trim（流拷贝 · 瞬时）'}
                </button>
              ) : (
                <button className="primary" onClick={runCrop} disabled={!canCrop}>
                  {running ? progressLabel : 'Crop + Trim（硬件重编码）'}
                </button>
              )}
            </div>

            {error && <div className="error">出错了：{error}</div>}

            {result && result.kind === 'trim' && (
              <div className="result">
                <div className="result-row">
                  <span className="k">总耗时</span>
                  <span className="v big">{result.timing.totalMs.toFixed(0)} ms</span>
                </div>
                <div className="result-row">
                  <span className="k">└ 解析</span>
                  <span className="v">{result.timing.parseMs.toFixed(0)} ms</span>
                </div>
                <div className="result-row">
                  <span className="k">└ 搬运 + 写盒子</span>
                  <span className="v">{result.timing.muxMs.toFixed(0)} ms</span>
                </div>
                <div className="result-row">
                  <span className="k">输出大小</span>
                  <span className="v">
                    {fmtBytes(result.size)}（原始 {fmtBytes(result.sourceSize)}）
                  </span>
                </div>
                <div className="result-row">
                  <span className="k">实际范围</span>
                  <span className="v">
                    {fmtTime(result.snapped.startSec)} — {fmtTime(result.snapped.endSec)} ·{' '}
                    {result.keptSamples} 帧
                  </span>
                </div>
                <div className="actions">
                  <a className="primary as-btn" href={result.url} download={result.fileName}>
                    下载 {result.fileName}
                  </a>
                </div>
                <div className="hint">
                  说明：v0.0.1 trim 只搬运视频流（音频被丢弃）。范围与所选略有偏差是因为起点对齐到了最近关键帧。
                </div>
              </div>
            )}

            {result && result.kind === 'crop' && (
              <div className="result">
                <div className="result-row">
                  <span className="k">总耗时</span>
                  <span className="v big">{(result.timing.totalMs / 1000).toFixed(2)} s</span>
                </div>
                <div className="result-row">
                  <span className="k">└ 解析</span>
                  <span className="v">{result.timing.parseMs.toFixed(0)} ms</span>
                </div>
                <div className="result-row">
                  <span className="k">└ 解码 + 裁剪 + 编码</span>
                  <span className="v">{(result.timing.transcodeMs / 1000).toFixed(2)} s</span>
                </div>
                <div className="result-row">
                  <span className="k">输出分辨率</span>
                  <span className="v">
                    {result.outputResolution}（原 {result.sourceResolution}）
                  </span>
                </div>
                <div className="result-row">
                  <span className="k">输出大小 / 帧数</span>
                  <span className="v">
                    {fmtBytes(result.size)} · {result.outputFrames} 帧
                  </span>
                </div>
                <div className="result-row">
                  <span className="k">编码器</span>
                  <span className="v">
                    {result.encoder.codec} @ {(result.encoder.bitrate / 1_000_000).toFixed(1)} Mbps ·{' '}
                    {result.encoder.framerate} fps
                  </span>
                </div>
                <div className="actions">
                  <a className="primary as-btn" href={result.url} download={result.fileName}>
                    下载 {result.fileName}
                  </a>
                </div>
                <div className="hint">
                  说明：crop 必须重编码，速度受硬件能力影响。当前版本同样会丢弃音轨。
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
