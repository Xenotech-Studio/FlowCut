// 这个文件曾经持有 mp4box 解析 + 样本定位 helper。已抽到 FlowCutSDK
// （src/FlowCutSDK 子模块），这里仅 re-export 保持已有 import 路径不变。
export {
  parseMp4,
  findStartKeyframeIndex,
  findEndIndex,
  pickMuxerCodec,
  extractDescription,
} from '../FlowCutSDK/src/index.js'
