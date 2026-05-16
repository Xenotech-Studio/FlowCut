// 声明式编辑：把 edits 字典渲染为最终 blob。
//
// edits = {
//   trim:   { startSec, endSec }                          | null
//   crop:   { x, y, width, height } 源坐标               | null
//   mosaic: { regions: [{ id, x, y, width, height }],
//             blockSize } 源坐标                          | null
// }
//
// 管道顺序固定：source → trim → mosaic（源坐标） → crop（源坐标）。
// 这个顺序的好处：
//   - trim 只动时间，不动空间坐标，所以单独改 trim 不会失效 mosaic / crop。
//   - mosaic 在 crop 之前用源坐标记录，所以单独改 crop 不会让 mosaic 坐标失效；
//     mosaic 落到 crop 之外的部分会被自然裁掉，但 mosaic 数据本身不丢。
//
// 内部按"阶段"键缓存中间 blob，单独改某一阶段时直接复用前置中间结果。
// 缓存按字节总预算约束，避免大视频把内存撑爆。

import { streamCopyTrim } from './trim.js'
import { cropAndTrim } from './crop.js'
import { mosaicAndExport } from './mosaic.js'

export const EMPTY_EDITS = Object.freeze({ trim: null, crop: null, mosaic: null })

export function isEditsEmpty(edits) {
  if (!edits) return true
  if (edits.trim) return false
  if (edits.crop) return false
  if (edits.mosaic && edits.mosaic.regions && edits.mosaic.regions.length > 0) {
    return false
  }
  return true
}

function trimKey(t) {
  return t ? `${t.startSec.toFixed(3)}-${t.endSec.toFixed(3)}` : 'x'
}
function mosaicKey(m) {
  if (!m || !m.regions || m.regions.length === 0) return 'x'
  // 区域内部顺序无意义，但同一组区域应该有稳定的键；按 id 排序拼接
  const sorted = [...m.regions].sort((a, b) => (a.id || '').localeCompare(b.id || ''))
  const inner = sorted.map((r) => `${r.id}:${r.x},${r.y},${r.width},${r.height}`).join('|')
  return `bs${m.blockSize}|${inner}`
}
function cropKey(c) {
  return c ? `${c.x},${c.y},${c.width},${c.height}` : 'x'
}

export function editsKey(edits) {
  return `t=${trimKey(edits.trim)}//m=${mosaicKey(edits.mosaic)}//c=${cropKey(edits.crop)}`
}

// 缓存条目按"字节预算"裁，比"条数"更适合长短不一的 blob
const DEFAULT_CACHE_BYTES = 500 * 1024 * 1024 // 500 MB

export function createRenderCache(bytesBudget = DEFAULT_CACHE_BYTES) {
  return {
    map: new Map(), // 插入序就是 FIFO 序
    bytesBudget,
  }
}

function cacheSize(cache) {
  let n = 0
  for (const b of cache.map.values()) n += b.size
  return n
}

function cacheSet(cache, key, blob) {
  cache.map.delete(key)
  cache.map.set(key, blob)
  while (cacheSize(cache) > cache.bytesBudget && cache.map.size > 1) {
    const oldest = cache.map.keys().next().value
    cache.map.delete(oldest)
  }
}

export function clearRenderCache(cache) {
  cache.map.clear()
}

export async function renderEdits(source, edits, cache, onProgress) {
  if (isEditsEmpty(edits)) {
    return { blob: source, timing: { totalMs: 0 }, cached: true }
  }

  const t0 = performance.now()

  const k1 = `t=${trimKey(edits.trim)}`
  const k2 = `${k1}//m=${mosaicKey(edits.mosaic)}`
  const k3 = `${k2}//c=${cropKey(edits.crop)}`

  // 全量命中
  if (cache.map.has(k3)) {
    return { blob: cache.map.get(k3), timing: { totalMs: 0 }, cached: true }
  }

  const totalStages =
    (edits.trim ? 1 : 0) +
    (edits.mosaic && edits.mosaic.regions.length > 0 ? 1 : 0) +
    (edits.crop ? 1 : 0)
  let stageIdx = 0

  let blob = source

  // 1) trim
  if (edits.trim) {
    stageIdx++
    if (cache.map.has(k1)) {
      blob = cache.map.get(k1)
    } else {
      const sIdx = stageIdx
      const out = await streamCopyTrim(source, {
        startSec: edits.trim.startSec,
        endSec: edits.trim.endSec,
        onProgress: (p) =>
          onProgress?.({ stage: 'trim', stageIdx: sIdx, totalStages, sub: p }),
      })
      blob = new Blob([out.buffer], { type: 'video/mp4' })
      cacheSet(cache, k1, blob)
    }
  }

  // 2) mosaic（源坐标）
  if (edits.mosaic && edits.mosaic.regions.length > 0) {
    stageIdx++
    if (cache.map.has(k2)) {
      blob = cache.map.get(k2)
    } else {
      const sIdx = stageIdx
      const out = await mosaicAndExport(blob, {
        regions: edits.mosaic.regions,
        blockSize: edits.mosaic.blockSize,
        onProgress: (p) =>
          onProgress?.({ stage: 'mosaic', stageIdx: sIdx, totalStages, sub: p }),
      })
      blob = new Blob([out.buffer], { type: 'video/mp4' })
      cacheSet(cache, k2, blob)
    }
  }

  // 3) crop（源坐标，输出尺寸 = crop 尺寸）
  if (edits.crop) {
    stageIdx++
    if (cache.map.has(k3)) {
      blob = cache.map.get(k3)
    } else {
      const sIdx = stageIdx
      const out = await cropAndTrim(blob, {
        startSec: 0,
        endSec: Infinity,
        crop: edits.crop,
        onProgress: (p) =>
          onProgress?.({ stage: 'crop', stageIdx: sIdx, totalStages, sub: p }),
      })
      blob = new Blob([out.buffer], { type: 'video/mp4' })
      cacheSet(cache, k3, blob)
    }
  }

  const t1 = performance.now()
  return { blob, timing: { totalMs: t1 - t0 }, cached: false }
}
