# FMT FlightLog

FMT FlightLog 是一个面向 FMT MLog 日志的纯前端解析工具。它可以在浏览器本地读取 `.bin` / `.log` / `.mlog` 等 MLog 格式日志，解析消息定义、参数组和数据帧，自动生成摘要、消息表和数据图表。

在线页面：[https://pan-chenliang.github.io/FMT-FlightLog/](https://pan-chenliang.github.io/FMT-FlightLog/)

## 核心特点

- **本地解析**：日志文件只在浏览器内处理，不会上传到服务器。
- **快速查看**：上传后自动展示日志头、模型信息、消息类型、帧数和参数组。
- **数据图表**：解析日志后提供数据绘图与分析入口。
- **缓存恢复**：使用 IndexedDB 缓存最近一次上传的日志，刷新页面后可自动恢复。
- **飞控导入**：在支持 Web Serial 的浏览器中，可通过 MAVLink FTP 从飞控读取日志。
- **静态部署**：无需后端、数据库或构建步骤，适合静态网页托管。

## 快速开始

### 在线使用

1. 打开在线页面：[FMT FlightLog](https://pan-chenliang.github.io/FMT-FlightLog/)。
2. 点击“选择或拖入本地文件”，选择 FMT 生成的日志文件。
3. 等待页面解析完成，查看状态栏、日志摘要、消息表、参数组和数据图表。
4. 如需清理浏览器缓存，点击“清除缓存”。

### 从飞控导入

1. 使用桌面版 Chrome 或 Edge 打开页面。
2. 点击“从飞控导入日志文件”，授权浏览器访问串口。
3. 选择波特率和日志路径，默认路径为 `/log/`。
4. 点击“连接飞控”，再点击“刷新文件列表”。
5. 选择日志文件后，可以直接解析单个文件，也可以下载一个或多个文件到本地。

注意：Web Serial 需要浏览器支持，并且通常要求 HTTPS 或 `localhost` 这类安全上下文。GitHub Pages 在线页面和本地 `localhost` 预览都满足这个条件。

## 本地运行

本项目是静态页面，推荐用 Python 启动本地 HTTP 服务，而不是直接双击打开 `index.html`。这样可以避免浏览器对 ES Module、缓存和 Web API 的本地文件限制。

### 使用 Python

在仓库根目录运行：

```bash
python -m http.server 8000
```

然后打开：

```text
http://localhost:8000/
```

如果系统中 `python` 指向的不是 Python 3，可以尝试：

```bash
py -3 -m http.server 8000
```

或：

```bash
python3 -m http.server 8000
```

### 直接打开文件

也可以直接打开 `index.html` 进行简单预览，但不推荐作为主要开发方式。部分浏览器会限制 `file://` 页面上的模块加载、串口能力或缓存行为。

## 浏览器要求

- 解析本地日志：现代 Chrome、Edge、Firefox、Safari 通常都可以使用。
- 从飞控导入日志：需要支持 Web Serial API，推荐桌面版 Chrome 或 Edge。
- 日志缓存：需要浏览器支持 IndexedDB。

## 支持的日志能力

当前解析器支持：

- MLog 文件头元数据：版本、头时间戳、描述、模型信息。
- Bus 定义：消息名称、消息 ID、字段名称、字段类型、数组长度。
- 参数组：尽量解析参数名称、类型和值；遇到未知类型时保留已解析信息并继续扫描数据帧。
- 数据帧：根据 bus 定义读取 payload，识别帧起始标记和结束标记。
- `delta_ts`：如果消息字段中存在名为 `timestamp` 或 `timestamp_ms` 的标量字段，则按消息 ID 计算相邻帧时间差。
- 日志时间轴：优先根据消息中的 `timestamp` / `timestamp_ms` 推导全局时间原点和时长；文件头 `timestamp` 仅作为日志启动时的原始毫秒计数备用。
- CSV 导出：字段顺序与 bus 定义一致，数组字段展开为 `field[0]`、`field[1]`，最后追加 `delta_ts`。

## 项目结构

```text
.
├── index.html              # 静态页面入口
├── styles.css              # 页面样式
├── package.json            # 测试脚本
├── src/
│   ├── app.js              # 页面交互、上传、渲染、下载、飞控导入
│   ├── logCache.js         # IndexedDB 日志缓存
│   ├── mavlinkFtp.js       # 浏览器端 Web Serial + MAVLink FTP 客户端
│   └── mlogParser.js       # MLog 二进制解析、CSV 导出、图表序列选择
└── test/
    └── smoke.test.js       # 合成 MLog 样本的冒烟测试
```

## 开发说明

### 设计原则

- 保持纯静态部署，不能依赖后端服务。
- 用户日志必须留在浏览器本地处理。
- 解析二进制日志时使用 `ArrayBuffer` / `DataView`，不要把二进制文件转成字符串再解析。
- 所有整数和浮点字段按 little-endian 读取。
- 固定长度名称按 UTF-8 解码，遇到 `0x00` 截断，并移除尾部空白。
- 参数区解析应保持容错：参数异常不应导致已解析的 bus 定义和后续日志帧全部丢失。
- GitHub Pages 部署应继续从仓库根目录直接工作，不引入必须构建的发布流程。

### 运行测试

本项目没有运行时 npm 依赖。修改解析逻辑、导出逻辑或图表序列选择后，在仓库根目录运行：

```bash
npm test
```

Windows PowerShell 中如果 `npm` 被执行策略拦截，可以使用：

```powershell
npm.cmd test
```

期望输出：

```text
smoke test passed
```

### 解析器开发参考

仓库内包含 Codex 技能说明：

```text
.codex/skills/parse-fmt-mlog/SKILL.md
```

修改 MLog 解析、CSV 导出、图表逻辑或飞控日志导入前，建议先阅读该文件。它记录了当前格式假设、实现约束、验证命令，以及与 FMT Firmware / FMT Model 中参考解析器的对照关系。

## 部署

仓库可以直接作为 GitHub Pages 静态站点发布。只要保持 `index.html`、`styles.css` 和 `src/` 位于仓库根目录，页面即可通过 GitHub Pages 访问，不需要构建产物。

## 常见问题

### 日志会上传到服务器吗？

不会。文件读取、解析、绘图、导出和缓存都发生在浏览器本地。

### 为什么建议用 Python 本地服务？

因为本项目使用 ES Module，并且部分浏览器能力在 `file://` 页面上受限。通过 `python -m http.server 8000` 访问 `http://localhost:8000/` 更接近线上 GitHub Pages 环境。

### 飞控导入按钮不可用怎么办？

请确认使用桌面版 Chrome 或 Edge，并通过 HTTPS 页面或 `localhost` 页面访问。如果浏览器不支持 Web Serial API，仍然可以先从飞控导出日志文件，再通过本地上传解析。

### 解析失败怎么办？

先确认文件是否为 FMT MLog 格式日志。如果日志来自较新的固件版本，可能存在当前解析器尚未覆盖的字段类型或格式变化。开发者可以从 `src/mlogParser.js` 和 `test/smoke.test.js` 入手添加样本和回归测试。
