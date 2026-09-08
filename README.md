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

## 提交钩子

仓库自带 `scripts/git-hooks/commit-msg`，拒绝带 AI 署名的提交消息（`Co-Authored-By: Claude/Cursor …`、`Generated with Claude Code` 之类），和 GitHub Actions 里的 commit message check 是同一条规则——本地不拦，推上去也会被 CI 拦。clone 之后启用一次：

```bash
git config core.hooksPath scripts/git-hooks
```

子模块各自是独立的 git 仓库，上面这条本地设置不会传播进去；要连子模块和本机其他仓库一起覆盖，改装成全局钩子：

```bash
mkdir -p ~/.git-hooks-global
cp scripts/git-hooks/commit-msg ~/.git-hooks-global/commit-msg
chmod +x ~/.git-hooks-global/commit-msg
git config --global core.hooksPath ~/.git-hooks-global
```

紧急情况可以 `git commit --no-verify` 跳过本地钩子，不推荐。
