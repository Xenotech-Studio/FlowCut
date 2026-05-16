// 用一个隐藏的 <video> 元素逐时间点 seek + drawImage 抽缩略图。
// 不动主预览视频。返回的 url 是 data URL，组件卸载时不需要 revoke。

// 抽源视频的代表帧（默认 0.1s 处规避部分容器在 0 时刻给出黑帧）+ 元信息。
// 返回方形居中裁剪的缩略图，固定 96px，给左上角 chip 用。
export async function extractClipInfo(file, seekSec = 0.1, squareSize = 96) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true

  try {
    await new Promise((resolve, reject) => {
      const onMeta = () => {
        cleanup()
        resolve()
      }
      const onErr = () => {
        cleanup()
        reject(new Error('clip info: metadata load failed'))
      }
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onMeta)
        video.removeEventListener('error', onErr)
      }
      video.addEventListener('loadedmetadata', onMeta)
      video.addEventListener('error', onErr)
    })

    const width = video.videoWidth
    const height = video.videoHeight
    const duration = video.duration

    await new Promise((resolve, reject) => {
      const onSeeked = () => {
        cleanup()
        resolve()
      }
      const onErr = () => {
        cleanup()
        reject(new Error('clip info: seek failed'))
      }
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onErr)
      }
      video.addEventListener('seeked', onSeeked)
      video.addEventListener('error', onErr)
      video.currentTime = Math.min(seekSec, Math.max(0, (duration || 0) - 0.05))
    })

    const canvas = document.createElement('canvas')
    canvas.width = squareSize
    canvas.height = squareSize
    const ctx = canvas.getContext('2d')
    const minDim = Math.min(width, height)
    const sx = (width - minDim) / 2
    const sy = (height - minDim) / 2
    ctx.drawImage(video, sx, sy, minDim, minDim, 0, 0, squareSize, squareSize)
    const thumbUrl = canvas.toDataURL('image/jpeg', 0.85)

    return {
      name: file.name,
      size: file.size,
      duration,
      width,
      height,
      thumbUrl,
    }
  } finally {
    video.src = ''
    video.load()
    URL.revokeObjectURL(url)
  }
}

// 模块级缓存：同一 videoUrl 在 trim 工具反复进出时不再重抽缩略图
// 键含 count / thumbHeight，配置变了视为不同条目
const thumbsCache = new Map()

export function clearThumbsCache(videoUrl) {
  if (!videoUrl) {
    thumbsCache.clear()
    return
  }
  for (const k of [...thumbsCache.keys()]) {
    if (k.startsWith(`${videoUrl}|`)) thumbsCache.delete(k)
  }
}

/**
 * 抽 count 张缩略图。可选 windowStartSec / windowEndSec 限定取样范围，
 * 默认是 [0, duration]。trim 工具放大局部时间窗口时会传具体的窗口。
 *
 * onThumb(index, thumb) 在每张就绪时回调一次（缓存命中场景下同步连续触发），
 * 调用方可据此渐进式渲染，不必等全部完成。
 *
 * 命中缓存时直接把已有结果通过 onThumb 同步回放一遍并立即返回。
 */
export async function generateThumbnails(
  videoUrl,
  duration,
  count,
  thumbHeight = 56,
  onThumb,
  windowStartSec,
  windowEndSec,
) {
  const winStart = Math.max(0, windowStartSec ?? 0)
  const winEnd = Math.min(duration, windowEndSec ?? duration)
  const winDur = Math.max(0, winEnd - winStart)
  if (winDur <= 0) return { thumbs: [], aspect: 16 / 9, count: 0 }

  const cacheKey = `${videoUrl}|${count}|${thumbHeight}|${winStart.toFixed(3)}|${winEnd.toFixed(3)}`
  const cached = thumbsCache.get(cacheKey)
  if (cached) {
    for (let i = 0; i < cached.thumbs.length; i++) {
      onThumb?.(i, cached.thumbs[i])
    }
    return cached
  }

  const video = document.createElement('video')
  video.src = videoUrl
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true

  await new Promise((resolve, reject) => {
    const onMeta = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error('thumbnail video failed to load'))
    }
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('error', onErr)
    }
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('error', onErr)
  })

  const aspect = video.videoWidth / video.videoHeight || 16 / 9
  const thumbW = Math.round(thumbHeight * aspect)
  const canvas = document.createElement('canvas')
  canvas.width = thumbW
  canvas.height = thumbHeight
  const ctx = canvas.getContext('2d')

  const results = []
  for (let i = 0; i < count; i++) {
    const t = winStart + ((i + 0.5) * winDur) / count
    await new Promise((resolve, reject) => {
      const onSeeked = () => {
        cleanup()
        resolve()
      }
      const onErr = () => {
        cleanup()
        reject(new Error('seek error'))
      }
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onErr)
      }
      video.addEventListener('seeked', onSeeked)
      video.addEventListener('error', onErr)
      video.currentTime = t
    })
    ctx.drawImage(video, 0, 0, thumbW, thumbHeight)
    const thumb = { time: t, url: canvas.toDataURL('image/jpeg', 0.7) }
    results.push(thumb)
    onThumb?.(i, thumb)
  }

  // 释放隐藏视频资源
  video.src = ''
  video.load()

  const out = { thumbs: results, aspect, count }
  thumbsCache.set(cacheKey, out)
  return out
}
