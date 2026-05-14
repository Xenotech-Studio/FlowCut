# FlowCut 技术白皮书

> 一个跑在浏览器里、对单段视频做局部修改的极简工具。
> 不需要安装、不需要上传，不调任何后端。

版本：与 [changelog.json](../changelog.json) 对齐。本文档描述截至当前版本的实现与边界。

---

## 0. 产品定位

**核心承诺：极度轻量化 + 超高导出速度。**

**只做这三件事：**

1. **时间裁剪**（trim） — 选起止点，得到截取后的视频
2. **画面尺寸裁剪**（crop） — 选矩形区域，得到只保留该区域的视频
3. **局部打码**（mosaic） — 选区域，输出该区域被模糊或马赛克化的视频

三件事的共同点：**对单段视频的局部修改**。FlowCut 不做时间线、不做多段拼接、不做转场、不做调色、不做特效、不做字幕、不做音轨混音、不做工程文件——任何"剪辑器"功能一律不进。

**为什么是网页，不是 Electron。**
"无启动时间"不是营销词，是物理事实——打开浏览器 Tab 比启动任何客户端都快。Electron 都嫌重。网页形态本身就是这个定位的兑现。

**性能承诺分两档（不能混用）：**

| 操作 | 路径 | 承诺 |
| --- | --- | --- |
| 时间裁剪 | stream copy，**不解码不重编码** | **瞬时**（毫秒~秒级，1 GB 文件约 3 秒） |
| 画面裁剪 / 局部打码 | WebCodecs 硬件加速重编码 | **接近实时**（1080p 约 1×~3× 实时） |

混用这两档话术会让用户拿长视频做 crop 等了 30 秒觉得被骗。

---

## 1. 问题陈述

视频"裁剪后导出"这件事在用户感知里有两类完全不同的体验：

- **macOS Finder 右键 Trim / QuickTime Player Trim**：拖完入出点，点确认，几乎瞬时拿到结果。
- **绝大多数网页剪辑工具 / 早年的 ffmpeg.wasm 方案**：等几秒到几十秒，进度条爬。

差距不是"硬件不一样"或"工程优化够不够",而是**走的根本不是同一条路径**。FlowCut 的目标就是把第一种体验完整搬到网页里，并把代价讲清楚。

---

## 2. 为什么"瞬间"成立：容器与编码的解耦

一个 mp4 文件在物理上是两层东西的叠加：

```
+-----------------------------------------------+
| moov atom（元数据：每个 sample 的偏移、时长、 |
|           是否关键帧、解码配置等）           |
+-----------------------------------------------+
| mdat（媒体数据：H.264 / HEVC 的编码字节流）   |
+-----------------------------------------------+
```

- **mdat 里的字节是已经编码完的**。它是一连串 NAL unit，每一段对应一帧的压缩数据。
- **moov 里只是描述这些字节在哪、对应什么时间**。

只要时间范围的起点落在某个关键帧（IDR）上，"截取 [t1, t2] 之间这段视频"在物理上就等价于：

1. 从 mdat 里把 [t1, t2] 覆盖的那段字节切出来。
2. 写一个新的 moov，指向新文件里这段字节的新偏移。
3. 拼成一个新的 mp4 文件。

这条路径里 **完全没有解码、没有重编码**。所有 CPU 重活（H.264 熵解码、运动补偿、变换、量化、再编码）一个都不做。耗时只取决于内存/磁盘 IO。

行业里这条路径有几个等价叫法：**stream copy**（ffmpeg `-c copy`）、**passthrough export**（AVFoundation `AVAssetExportPresetPassthrough`）、**remux**。macOS Finder Trim 走的就是 AVFoundation 的 passthrough。

---

## 3. 浏览器里能做到的前提：WebCodecs 时代的工具链

2024 年起，浏览器才真正具备"在 JS 里以零拷贝精度操作 mp4 容器"的能力。两个关键库：

### 3.1 mp4box.js — 拆解 mp4

负责把上传的 mp4 文件解析成结构化的 sample 列表：

- 每个 sample 的 cts / dts / duration / size / is_sync
- 每条轨道的 codec 字符串与解码配置盒子（avcC / hvcC / vpcC / av1C）
- 增量 / 流式喂入（`appendBuffer` + `fileStart`），不必一次性把整个文件读进内存

它本身就是 W3C MSE 测试套件背后的解析器，成熟稳定。

### 3.2 mp4-muxer — 重写 mp4

负责把若干 `EncodedVideoChunk` / `EncodedAudioChunk` 序列写回一个新的 mp4 文件：

- 自动生成 moov / mdat / 各种描述盒子
- 支持 `fastStart: 'in-memory'`，把 moov 放到文件头部（关键，否则浏览器/网页播放器要拉到文件尾才能起播）
- 支持 H.264 / H.265 / VP9 / AV1

注意 `EncodedVideoChunk` 的 data 可以来自 WebCodecs 的 `VideoEncoder` 编码输出，**也可以来自 mp4box 解析出来的原始字节**。后一种用法等价于流拷贝。

### 3.3 WebCodecs API（本版未启用，备用）

`VideoDecoder` / `VideoEncoder` 提供硬件加速的解码/编码能力。本版的极速 Trim 不需要它们——但二阶段画面裁剪、转码、压缩会需要。

---

## 4. 极速 Trim 的实现 ([src/lib/trim.js](../src/lib/trim.js))

整个流程分三步：

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
│ 用户文件 │ -> │ mp4box       │ -> │ 范围筛选 +   │ -> │ mp4-muxer│ -> 新 mp4
│ (Blob)   │    │ 解析 sample  │    │ EncChunk 包装│    │ 重写盒子 │
└──────────┘    └──────────────┘    └──────────────┘    └──────────┘
                  几百 ms              < 10 ms              几十 ms
```

### 4.1 解析：流式读入

```js
const reader = file.stream().getReader()
let offset = 0
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  const ab = value.buffer.slice(...)
  ab.fileStart = offset
  offset += value.byteLength
  mp4.appendBuffer(ab)
}
mp4.flush()
```

`File.stream()` 让我们不必一次性把整个文件读进内存，对几百 MB 的视频很有意义。

`onSamples` 回调里我们把每个 sample 的元信息和原始字节都收集起来。**注意必须 `new Uint8Array(s.data)` 复制一份**，mp4box 内部会复用底层 buffer。

### 4.2 范围筛选：snap 到关键帧

非关键帧（P / B）依赖前面的关键帧才能解码。所以入点必须对齐到关键帧——这跟 macOS Finder Trim 隐式的 snap 行为完全一致：

```js
function findStartIndex(samples, startSec) {
  let best = -1
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].cts / samples[i].timescale
    if (t > startSec) break
    if (samples[i].is_sync) best = i
  }
  return best === -1 ? firstSyncIndex(samples) : best
}
```

策略：**向前 snap**——找到不晚于用户入点的最后一个关键帧。这样选中区间一定能完整解码，代价是实际起点可能比用户期望早一点（通常 0.5~2 秒，取决于源视频的 GOP 长度）。结果页面会显式告诉用户"实际范围"是什么。

### 4.3 包装为 EncodedVideoChunk

对每个范围内的 sample，构造一个 `EncodedVideoChunk`，**data 字段就是 mdat 里原本那段字节**——这是整个方案的灵魂：

```js
const chunk = new EncodedVideoChunk({
  type: s.is_sync ? 'key' : 'delta',
  timestamp: cts,
  duration: s.duration * scale,
  data: s.data,         // 原始 H.264 / H.265 NAL，不动一字节
})
muxer.addVideoChunk(chunk, meta, cts, cts - dts)
```

构造 `EncodedVideoChunk` **不会调用 WebCodecs 解码器**——只是把一段字节加上元信息打包成一个 JS 对象。mp4-muxer 拿到后也只是把这段字节摆进新文件的 mdat，再在新 moov 里记下它的偏移和时长。

---

## 5. 关键技术细节：B-frame 与 DTS / CTS

这是开发过程中真实踩到的坑，单列一节。

### 5.1 现象

直接把 `s.cts` 当 chunk 的 timestamp 喂给 mp4-muxer，遇到带 B-frame 的视频立刻报：

```
Timestamps must be monotonically increasing (DTS went from 133333 to 66666).
```

### 5.2 原因

H.264 / HEVC 用 B-frame 做双向预测，编码顺序（DTS, decode timestamp）和呈现顺序（CTS, composition timestamp）不一致。一个典型 GOP：

```
解码序: I  P  B  B  P  B  B
DTS:    0  1  2  3  4  5  6
CTS:    0  3  1  2  6  4  5
```

mp4box 的 `onSamples` 是**按 DTS（解码序）回调**的。如果直接把 cts 序列 `[0, 3, 1, 2, 6, 4, 5]` 当 timestamp，第三个就比第二个小，muxer 内部"时间戳必须单调"的断言立刻挂掉。

### 5.3 mp4-muxer 的契约

读 `mp4-muxer.d.ts` 第 164~167 行，原文：

> `timestamp` — Optionally, the presentation timestamp to use for the video chunk.
> `compositionTimeOffset` — Optionally, the composition time offset (i.e. presentation timestamp minus decode timestamp).

所以 muxer 内部是这么算 DTS 的：

```
内部 DTS = timestamp - compositionTimeOffset = CTS - (CTS - DTS) = DTS
```

正确的传法：

| 字段                     | 应该传什么 |
| ------------------------ | ---------- |
| `chunk.timestamp`        | CTS        |
| 第 3 参数 `timestamp`    | CTS        |
| 第 4 参数 `compositionTimeOffset` | CTS − DTS |

这样推回去的内部 DTS 就是原始 DTS，按 mp4box 的回调顺序自然单调。

### 5.4 时间平移

裁剪后新文件必须从 0 开始计时。我们以 `videoSamples[startIdx].dts`（对齐后的入点关键帧）作为 0 点，对所有样本统一减去这个偏移。dts 和 cts 减相同的值，`(cts - dts)` 不变，B-frame 的呈现关系完整保留。

---

## 6. 解码配置盒子的提取

每条视频轨在 mp4 里都带一个解码配置盒子——H.264 是 `avcC`，HEVC 是 `hvcC` 等。它包含 SPS / PPS，是解码器的入门钥匙。

新 mp4 必须把这个盒子原样写回去。mp4-muxer 通过 `meta.decoderConfig.description` 接收它，但要的是**去掉 8 字节 box header 后的纯 payload**：

```js
function extractDescription(mp4, trackId) {
  const trak = mp4.getTrackById(trackId)
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
    if (!box) continue
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
    box.write(stream)
    return new Uint8Array(stream.buffer.slice(8))  // 砍掉 size + type
  }
  throw new Error('No codec config box found')
}
```

只在第一个 chunk 上传 `decoderConfig` 即可，后续 chunk 复用。

---

## 7. 性能模型

理论上限就是磁盘/内存 IO。实测（macOS, Chrome, 1080p H.264 mp4）：

| 文件大小 | 解析耗时 | 搬运耗时 | 总耗时 |
| -------- | -------- | -------- | ------ |
| 30 MB    | ~150 ms  | ~30 ms   | ~200 ms |
| 200 MB   | ~600 ms  | ~80 ms   | ~700 ms |
| 1 GB     | ~3 s     | ~200 ms  | ~3.2 s |

对比口径：

- **ffmpeg.wasm 同样规模**：1 GB 文件需要数十秒到数分钟，因为它即便走 `-c copy`，纯 JS/WASM 解析容器和管理内存也比原生慢一个量级。
- **MediaRecorder 路径**：物理上不可能快过 1× 实时——10 秒视频导出至少 10 秒。
- **Mac 原生 AVFoundation passthrough**：跟 FlowCut 同一档，差距在几百毫秒级别（容器解析的 C 实现稍快）。

---

## 8. 当前局限与取舍

| 局限                       | 原因                                                       | 后续打算 |
| -------------------------- | ---------------------------------------------------------- | -------- |
| 音轨被丢弃                 | AAC 的 `esds` / AudioSpecificConfig 提取代码未写           | v0.0.2   |
| 只支持 mp4 / mov / m4v     | 都是 ISO BMFF 容器，mp4box 原生支持                        | mkv / webm 后续 |
| 入点对齐到关键帧（向前）   | 非关键帧无法独立解码——任何 stream copy 工具同此限制       | 二阶段："smart cut" 模式只对切点 GOP 重编码 |
| 整文件先进内存             | mp4box 接受流式输入，但当前实现一次性收集所有 sample data | 大文件场景改成 sample 索引 + 按需 slice |
| 没有画面裁剪 / 缩放 / 转码 | 这些需要解码—操作—编码全流程                              | 二阶段：WebCodecs 硬件加速路径 |

---

## 9. Roadmap

主线只有 §0 的三件事。其余功能一律不进。

**主线（按优先级）：**

1. **画面裁剪（crop）** — `VideoDecoder` 硬解 → `OffscreenCanvas` 裁剪 → `VideoEncoder` 硬编 → mp4-muxer。当前正在实现。
2. **局部打码（mosaic）** — 复用 crop 的 WebCodecs 管道，画面操作改成"指定区域降采样后回贴 / 高斯模糊"。边际工程成本接近零。
3. **音轨流拷贝** — 当前 trim 丢音频。补上 AAC `esds`/`AudioSpecificConfig` 提取，让音频也走 stream copy，与视频起点对齐。

**评估中（不承诺）：**

- 大文件流式 demux — 只囤 sample 索引、按需从 Blob `slice()` 读，让 10 GB 文件也能秒级 trim
- Smart cut — 入点附近 GOP 局部重编码，绕开关键帧 snap 限制（仅 trim 模式）

这两项是优化项，不影响核心承诺，做不做要看真实用户场景反馈。

---

## 10. 工程上的几条断言

写在这里以避免未来反复重新发现：

1. **mp4box.onSamples 返回的 data 是临时缓冲区**，必须 copy，否则后续 sample 会覆盖。
2. **mp4-muxer 的 timestamp 参数是 CTS，不是 DTS**——容易传反，传反会在 B-frame 视频上炸。见 §5。
3. **`fastStart: 'in-memory'` 必须开**，否则 moov 在文件尾，浏览器播放器要拉到文件末尾才能起播，下载下来用 QuickTime 也是同样问题。
4. **入点 snap 是不可妥协的物理约束**，UI 层必须显式告诉用户实际范围，不能假装精确。
5. **WebCodecs ≠ FFmpeg.wasm**。前者调系统硬件解码器、性能接近原生；后者是纯 WASM 软件实现、慢一个量级。混淆这俩会让所有性能预算估错。
