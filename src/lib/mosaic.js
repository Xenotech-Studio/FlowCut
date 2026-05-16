// 局部打码：每帧硬解 → canvas 整帧绘制 → 对每个选中区域做 "downsample 再 upscale"
// 形成块状马赛克 → 硬编 H.264 → mp4-muxer。输出分辨率与源一致。
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { parseMp4 } from './mp4parser.js'

const H264_HIGH_5_1 = 'avc1.640033'

async function ensureEncoderSupported(config) {
  const { supported } = await VideoEncoder.isConfigSupported(config)
  if (!supported) {
    throw new Error(
      `当前浏览器/系统不支持目标编码配置：${config.codec} ${config.width}×${config.height} @${config.framerate}fps`,
    )
  }
}

export function applyMosaicToRegion(ctx, tempCanvas, region, blockSize) {
  const x = Math.max(0, Math.round(region.x))
  const y = Math.max(0, Math.round(region.y))
  const w = Math.round(region.width)
  const h = Math.round(region.height)
  if (w < 4 || h < 4) return

  const bs = Math.max(2, blockSize)
  // 用四舍五入算"块数"，每个块在源像素里大约 bs 那么大
  const blocksW = Math.max(1, Math.round(w / bs))
  const blocksH = Math.max(1, Math.round(h / bs))

  tempCanvas.width = blocksW
  tempCanvas.height = blocksH
  const tctx = tempCanvas.getContext('2d', { alpha: false })

  // 1) 区域 → 小图（开 smoothing 让浏览器做面积平均，得到块的平均色）
  tctx.imageSmoothingEnabled = true
  tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, blocksW, blocksH)

  // 2) 小图 → 区域（关 smoothing，得到硬边块状马赛克）
  const prevSmooth = ctx.imageSmoothingEnabled
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tempCanvas, 0, 0, blocksW, blocksH, x, y, w, h)
  ctx.imageSmoothingEnabled = prevSmooth
}

export async function mosaicAndExport(file, { regions, blockSize, onProgress }) {
  if (!regions || regions.length === 0) {
    throw new Error('请至少添加一个打码区域')
  }

  const t0 = performance.now()
  const { videoTrack, videoSamples, description } = await parseMp4(file, onProgress)
  const tParse = performance.now()

  const W = videoTrack.video.width
  const H = videoTrack.video.height
  const startIdx = 0
  const endIdx = videoSamples.length - 1

  let framerate = 30
  const dur_s =
    (videoSamples[endIdx].cts + videoSamples[endIdx].duration -
      videoSamples[startIdx].cts) /
    videoSamples[startIdx].timescale
  if (dur_s > 0) {
    framerate = Math.max(1, Math.round((endIdx - startIdx + 1) / dur_s))
  }
  const bitrate = Math.min(
    20_000_000,
    Math.max(1_000_000, Math.round(W * H * framerate * 0.1)),
  )

  const encoderConfig = {
    codec: H264_HIGH_5_1,
    width: W,
    height: H,
    framerate,
    bitrate,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'avc' },
  }
  await ensureEncoderSupported(encoderConfig)

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory',
  })

  let encoderError = null
  let decoderError = null
  let encodedCount = 0

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta)
      encodedCount++
    },
    error: (e) => {
      encoderError = e
    },
  })
  encoder.configure(encoderConfig)

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { alpha: false })
  const tempCanvas = new OffscreenCanvas(2, 2)

  const defaultFrameDurUs = Math.round(1_000_000 / framerate)

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        ctx.drawImage(frame, 0, 0, W, H)
        for (const r of regions) {
          applyMosaicToRegion(ctx, tempCanvas, r, blockSize)
        }
        const outFrame = new VideoFrame(canvas, {
          timestamp: frame.timestamp,
          duration: frame.duration || defaultFrameDurUs,
        })
        encoder.encode(outFrame)
        outFrame.close()
      } finally {
        frame.close()
      }
    },
    error: (e) => {
      decoderError = e
    },
  })
  decoder.configure({
    codec: videoTrack.codec,
    description,
    codedWidth: W,
    codedHeight: H,
    hardwareAcceleration: 'prefer-hardware',
  })

  const total = endIdx - startIdx + 1
  for (let i = startIdx; i <= endIdx; i++) {
    if (decoderError) throw decoderError
    if (encoderError) throw encoderError

    const s = videoSamples[i]
    const scale = 1_000_000 / s.timescale
    decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: s.cts * scale,
        duration: s.duration * scale,
        data: s.data,
      }),
    )

    while (decoder.decodeQueueSize > 24 || encoder.encodeQueueSize > 24) {
      await new Promise((r) => setTimeout(r, 0))
      if (decoderError) throw decoderError
      if (encoderError) throw encoderError
    }

    if ((i - startIdx) % 30 === 0) {
      onProgress?.({ phase: 'transcoding', loaded: i - startIdx, total })
    }
  }

  await decoder.flush()
  decoder.close()
  await encoder.flush()
  encoder.close()

  if (decoderError) throw decoderError
  if (encoderError) throw encoderError
  if (encodedCount === 0) {
    throw new Error('编码器没有产出任何帧')
  }

  muxer.finalize()
  const tEnd = performance.now()

  return {
    buffer: muxer.target.buffer,
    timing: {
      parseMs: tParse - t0,
      transcodeMs: tEnd - tParse,
      totalMs: tEnd - t0,
    },
    outputFrames: encodedCount,
    sourceResolution: `${W}×${H}`,
    regionsCount: regions.length,
    encoder: {
      codec: encoderConfig.codec,
      bitrate,
      framerate,
    },
    sourceSize: file.size,
  }
}
