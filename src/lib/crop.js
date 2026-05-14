// 画面裁剪 + 时间裁剪：WebCodecs decode → canvas crop → encode → mux。
// 解码 / 编码均请求硬件加速。输出统一为 H.264 (avc1.640033, High @ L5.1)，
// 覆盖到 4K@30 / 1080p@60，绝大多数设备硬解硬编都支持。
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { parseMp4, findStartKeyframeIndex, findEndIndex } from './mp4parser.js'

const H264_HIGH_5_1 = 'avc1.640033'

async function ensureEncoderSupported(config) {
  const { supported } = await VideoEncoder.isConfigSupported(config)
  if (!supported) {
    throw new Error(
      `当前浏览器/系统不支持目标编码配置：${config.codec} ${config.width}×${config.height} @${config.framerate}fps`,
    )
  }
}

export async function cropAndTrim(file, { startSec, endSec, crop, onProgress }) {
  if (!Number.isInteger(crop.x) || !Number.isInteger(crop.y)) {
    throw new Error('crop.x / crop.y must be integers')
  }
  if (crop.width % 2 !== 0 || crop.height % 2 !== 0) {
    throw new Error('crop.width / crop.height must be even (H.264 要求)')
  }
  if (crop.width < 16 || crop.height < 16) {
    throw new Error('裁剪区域太小（最小 16×16）')
  }

  const t0 = performance.now()
  const { videoTrack, videoSamples, description } = await parseMp4(file, onProgress)
  const tParse = performance.now()

  const startKeyIdx = findStartKeyframeIndex(videoSamples, startSec)
  const endIdx = findEndIndex(videoSamples, endSec)
  if (endIdx < startKeyIdx) throw new Error('Invalid range')

  // 边界校验
  if (crop.x + crop.width > videoTrack.video.width || crop.y + crop.height > videoTrack.video.height) {
    throw new Error('裁剪区域超出视频边界')
  }

  // 估算帧率（用于编码器配置 + bitrate 计算）
  let framerate = 30
  const dur_s =
    (videoSamples[endIdx].cts + videoSamples[endIdx].duration - videoSamples[startKeyIdx].cts) /
    videoSamples[startKeyIdx].timescale
  if (dur_s > 0) {
    framerate = Math.max(1, Math.round((endIdx - startKeyIdx + 1) / dur_s))
  }

  // 比特率：~0.1 bits/pixel，1Mbps 下限，20Mbps 上限
  const bitrate = Math.min(
    20_000_000,
    Math.max(1_000_000, Math.round(crop.width * crop.height * framerate * 0.1)),
  )

  const encoderConfig = {
    codec: H264_HIGH_5_1,
    width: crop.width,
    height: crop.height,
    framerate,
    bitrate,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'avc' },
  }
  await ensureEncoderSupported(encoderConfig)

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: crop.width, height: crop.height },
    fastStart: 'in-memory',
  })

  let encoderError = null
  let decoderError = null
  let encodedCount = 0

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (encodedCount === 0) {
        // 调试用：第一帧 meta 必须含 decoderConfig，否则 muxer.finalize 会炸
        // eslint-disable-next-line no-console
        console.debug('[FlowCut] first encoded chunk meta:', meta)
      }
      muxer.addVideoChunk(chunk, meta)
      encodedCount++
    },
    error: (e) => {
      encoderError = e
    },
  })
  encoder.configure(encoderConfig)

  const canvas = new OffscreenCanvas(crop.width, crop.height)
  const ctx = canvas.getContext('2d', { alpha: false })

  const startUs = Math.round(startSec * 1_000_000)
  const endUs = Math.round(endSec * 1_000_000)
  const defaultFrameDurUs = Math.round(1_000_000 / framerate)

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const ts = frame.timestamp
        // 起点关键帧到 startSec 之间的帧是"解码引子"，跳过即可，统一在 finally 关闭
        if (ts >= startUs && ts <= endUs) {
          ctx.drawImage(
            frame,
            crop.x, crop.y, crop.width, crop.height,
            0, 0, crop.width, crop.height,
          )
          const outFrame = new VideoFrame(canvas, {
            timestamp: ts - startUs,
            duration: frame.duration || defaultFrameDurUs,
          })
          encoder.encode(outFrame)
          outFrame.close()
        }
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
    codedWidth: videoTrack.video.width,
    codedHeight: videoTrack.video.height,
    hardwareAcceleration: 'prefer-hardware',
  })

  const total = endIdx - startKeyIdx + 1
  for (let i = startKeyIdx; i <= endIdx; i++) {
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

    // 背压：解码/编码队列堆积时让事件循环转一下
    while (decoder.decodeQueueSize > 24 || encoder.encodeQueueSize > 24) {
      await new Promise((r) => setTimeout(r, 0))
      if (decoderError) throw decoderError
      if (encoderError) throw encoderError
    }

    if ((i - startKeyIdx) % 30 === 0) {
      onProgress?.({ phase: 'transcoding', loaded: i - startKeyIdx, total })
    }
  }

  await decoder.flush()
  decoder.close()
  await encoder.flush()
  encoder.close()

  if (decoderError) throw decoderError
  if (encoderError) throw encoderError
  if (encodedCount === 0) {
    throw new Error('编码器没有产出任何帧——很可能所选时间范围内没有可解码的画面')
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
    outputResolution: `${crop.width}×${crop.height}`,
    sourceResolution: `${videoTrack.video.width}×${videoTrack.video.height}`,
    encoder: {
      codec: encoderConfig.codec,
      bitrate,
      framerate,
    },
    sourceSize: file.size,
  }
}
