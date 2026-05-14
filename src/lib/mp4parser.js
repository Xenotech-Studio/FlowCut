// mp4 解析共享实现：用 mp4box 把整个文件流式吃进去，吐出视频轨样本列表 + 解码配置盒子
import MP4Box from 'mp4box'

const { DataStream } = MP4Box

export function extractDescription(mp4, trackId) {
  const trak = mp4.getTrackById(trackId)
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
    if (!box) continue
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
    box.write(stream)
    // mp4-muxer / WebCodecs 要的是去掉 8 字节 box header 后的纯 payload
    return new Uint8Array(stream.buffer.slice(8))
  }
  throw new Error('No codec config box found')
}

export async function parseMp4(file, onProgress) {
  return new Promise(async (resolve, reject) => {
    const mp4 = MP4Box.createFile()
    let info = null
    const samplesByTrack = new Map()

    mp4.onError = (e) => reject(new Error(`mp4box parse error: ${e}`))

    mp4.onReady = (mp4info) => {
      info = mp4info
      for (const track of info.tracks) {
        if (track.type !== 'video') continue
        samplesByTrack.set(track.id, [])
        mp4.setExtractionOptions(track.id, null, { nbSamples: 100000 })
      }
      mp4.start()
    }

    mp4.onSamples = (id, _user, samples) => {
      const arr = samplesByTrack.get(id)
      if (!arr) return
      for (const s of samples) {
        arr.push({
          cts: s.cts,
          dts: s.dts,
          duration: s.duration,
          timescale: s.timescale,
          size: s.size,
          is_sync: s.is_sync,
          data: new Uint8Array(s.data),
        })
      }
    }

    try {
      const reader = file.stream().getReader()
      let offset = 0
      const total = file.size
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        ab.fileStart = offset
        offset += value.byteLength
        mp4.appendBuffer(ab)
        onProgress?.({ phase: 'parsing', loaded: offset, total })
      }
      mp4.flush()

      const videoTrack = info.tracks.find((t) => t.type === 'video')
      if (!videoTrack) throw new Error('No video track in file')

      resolve({
        info,
        videoTrack,
        videoSamples: samplesByTrack.get(videoTrack.id),
        description: extractDescription(mp4, videoTrack.id),
      })
    } catch (e) {
      reject(e)
    }
  })
}

export function findStartKeyframeIndex(samples, startSec) {
  let best = -1
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].cts / samples[i].timescale
    if (t > startSec) break
    if (samples[i].is_sync) best = i
  }
  if (best === -1) {
    for (let i = 0; i < samples.length; i++) if (samples[i].is_sync) return i
    throw new Error('No keyframe found')
  }
  return best
}

export function findEndIndex(samples, endSec) {
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].cts / samples[i].timescale
    if (t > endSec) return Math.max(0, i - 1)
  }
  return samples.length - 1
}

export function pickMuxerCodec(codecStr) {
  if (codecStr.startsWith('avc1') || codecStr.startsWith('avc3')) return 'avc'
  if (codecStr.startsWith('hev1') || codecStr.startsWith('hvc1')) return 'hevc'
  if (codecStr.startsWith('vp09')) return 'vp9'
  if (codecStr.startsWith('av01')) return 'av1'
  throw new Error(`Unsupported video codec: ${codecStr}`)
}
