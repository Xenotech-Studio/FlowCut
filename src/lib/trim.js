// Stream-copy trim：mp4 范围内的视频 sample 原样搬到一个新的容器，
// 不解码、不重编码。起点 snap 到最近的关键帧（IDR）。
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { parseMp4, findStartKeyframeIndex, findEndIndex, pickMuxerCodec } from './mp4parser.js'

export async function streamCopyTrim(file, { startSec, endSec, onProgress }) {
  const t0 = performance.now()
  const { videoTrack, videoSamples, description } = await parseMp4(file, onProgress)
  const tParse = performance.now()

  const startIdx = findStartKeyframeIndex(videoSamples, startSec)
  const endIdx = findEndIndex(videoSamples, endSec)
  if (endIdx < startIdx) throw new Error('Invalid trim range (end before start)')

  const snappedStartSec = videoSamples[startIdx].cts / videoSamples[startIdx].timescale
  const snappedEndSec =
    (videoSamples[endIdx].cts + videoSamples[endIdx].duration) / videoSamples[endIdx].timescale

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: pickMuxerCodec(videoTrack.codec),
      width: videoTrack.video.width,
      height: videoTrack.video.height,
    },
    fastStart: 'in-memory',
  })

  // mp4-muxer 约定：timestamp 是 CTS（呈现时间），compositionTimeOffset = CTS - DTS。
  // muxer 内部用 timestamp - offset 反推 DTS；mp4box 按 DTS 顺序回调，
  // 这样推出来的 DTS 自然单调。整段往前平移以 startIdx.dts 为 0。
  const first = videoSamples[startIdx]
  const dtsOffset = first.dts * (1_000_000 / first.timescale)
  const total = endIdx - startIdx + 1
  for (let i = startIdx; i <= endIdx; i++) {
    const s = videoSamples[i]
    const scale = 1_000_000 / s.timescale
    const dts = s.dts * scale - dtsOffset
    const cts = s.cts * scale - dtsOffset
    const chunk = new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: cts,
      duration: s.duration * scale,
      data: s.data,
    })
    muxer.addVideoChunk(
      chunk,
      i === startIdx
        ? { decoderConfig: { codec: videoTrack.codec, description } }
        : undefined,
      cts,
      cts - dts,
    )
    if ((i - startIdx) % 50 === 0) {
      onProgress?.({ phase: 'muxing', loaded: i - startIdx, total })
    }
  }
  muxer.finalize()
  const tMux = performance.now()

  return {
    buffer: muxer.target.buffer,
    timing: {
      parseMs: tParse - t0,
      muxMs: tMux - tParse,
      totalMs: tMux - t0,
    },
    snapped: { startSec: snappedStartSec, endSec: snappedEndSec },
    keptSamples: total,
    sourceSize: file.size,
  }
}
