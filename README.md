# FMT FlightLog

一个面向 GitHub Pages 的纯静态 FMT MLog 解析工具。用户在浏览器中上传日志文件后，页面直接在本地解析二进制日志、统计消息帧，并绘制数值字段曲线。

## 当前能力

- 上传 `.bin` / `.mlog` 文件
- 解析 MLog 头部、bus 定义、参数组和消息帧
- 自动统计每个消息类型的帧数
- 自动选择变化的数值字段绘图
- 下载摘要 JSON 和单个消息 CSV
- 使用 IndexedDB 缓存最近一次上传的日志，刷新页面后自动恢复
- 不依赖后端服务，文件不会上传到服务器

## 本地预览

可以直接打开 `index.html`，也可以用任意静态文件服务器预览。

```bash
npm test
```

## 开发技能

仓库内包含 Codex 技能 `.codex/skills/parse-fmt-mlog`，记录了 MLog 二进制格式、解析流程、验证命令和当前项目文件职责。后续修改解析器或图表逻辑时，先读取该技能。

## GitHub Pages

当前版本不需要构建步骤。仓库推送到 GitHub 后，可在仓库 Settings -> Pages 中选择从 `main` 分支根目录发布。
