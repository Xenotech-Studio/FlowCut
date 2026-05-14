# FlowCut

跑在浏览器里的极简视频工具：对单段视频做局部修改。
不需要安装、不需要上传、不调任何后端。

**只做三件事：** 时间裁剪 · 画面裁剪 · 局部打码。

完整设计与技术细节见 [docs/WHITEPAPER.md](docs/WHITEPAPER.md)。

## 开发

```bash
yarn install
yarn dev     # http://localhost:4100/
yarn build
```

需要 Node 20+ 与现代浏览器（Chrome / Edge / Safari 16.4+）支持 WebCodecs。
