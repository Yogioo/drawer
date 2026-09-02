# Excalidraw AI 画布

这是一个基于 [Excalidraw](https://excalidraw.com/) 的 AI 无限画布应用。你可以通过右侧聊天面板让 AI 读取并修改画布，例如创建流程图、移动元素、整理布局或生成手绘内容。

## 快速开始

### 1. 安装依赖

在项目根目录执行：

```powershell
npm install
```

### 2. 配置本地环境变量

复制环境变量模板：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

然后编辑 `.dev.vars`：

```env
OPENAI_API_KEY=填写你的 API key
OPENAI_BASE_URL=https://你的 OpenAI 兼容服务地址/v1
OPENAI_MODEL=grok-4.6
ALLOWED_ORIGINS=http://localhost:5173
AI_UPSTREAM_TIMEOUT_MS=30000
AI_UPSTREAM_MAX_RETRIES=2
AI_UPSTREAM_RETRY_DELAY_MS=250
```

服务需要支持 Chat Completions、流式输出和模型对应的输入能力。项目会把 API key 留在 Cloudflare Worker 环境中，不会发送到浏览器端。

浏览器默认请求当前站点的 `/stream`，由本地 Wrangler Worker 处理。部署 Worker 后，在项目根目录的 `.env.local` 中设置浏览器请求目标；可以填写完整的稳定 HTTPS 地址，也可以继续使用本地地址：

```env
VITE_AI_WORKER_URL=https://drawer-ai.example.workers.dev/stream
```

`VITE_AI_WORKER_URL` 只能配置 Worker 地址，客户端不会读取 `OPENAI_*` 变量。生产 Worker 的 `ALLOWED_ORIGINS` 必须填写实际浏览器来源，多个来源使用逗号分隔；不要配置 `*`。

不要把真实 key 写入 README、源码或提交记录。`.dev.vars`、构建产物和本地 Wrangler 目录已经加入 `.gitignore`。

### 3. 启动开发服务器

```powershell
npm run dev
```

打开：<http://localhost:5173/>

如果端口已被占用，可以使用其他端口：

```powershell
npm run dev -- --port 5174
```

停止服务器时，在终端按 `Ctrl+C`。

### 4. 启动 Tauri 桌面应用

桌面开发模式使用 `http://localhost:1420` 的 Vite 服务；浏览器开发仍使用上面的 `npm run dev` 和默认端口。运行桌面应用前，在项目根目录的 `.env.local` 中配置远程 Worker：

```env
VITE_AI_WORKER_URL=https://drawer-ai.example.workers.dev/stream
```

然后执行：

```powershell
npm run desktop:dev
```

生产构建会先生成 `dist/client`，再把这些静态资源嵌入 Tauri 应用；不会启动 Node 进程、开发服务器或 Cloudflare sidecar：

```powershell
npm run desktop:build
```

Windows 安装包输出到 `src-tauri/target/release/bundle/nsis` 和 `src-tauri/target/release/bundle/msi`。发布版的 AI 请求仍发送到 `VITE_AI_WORKER_URL`，不是本地 `/stream`。远程 Worker 的 `ALLOWED_ORIGINS` 需要包含 `http://tauri.localhost`；桌面开发模式还需要允许 `http://localhost:1420`。

## 当前 AI 配置

- Provider：OpenAI 兼容接口
- API：Chat Completions
- 默认模型：`grok-4.6`
- 服务端：Cloudflare Worker（本地开发或稳定 HTTPS 部署）
- 画布：Excalidraw infinite canvas

模型和上游配置位于 Worker 环境变量，模型输出会被校验为画布操作，成功、失败和结束都会通过 SSE 返回给客户端。Worker 对上游请求使用有限超时和重试，并记录 request id、状态、耗时和重试次数；日志不会记录 API key、完整提示词或画布内容。

## 主要功能

Agent 默认可以：

- 创建、修改和删除矩形、椭圆、菱形、文本、箭头、线条和自由笔迹
- 读取画布中的元素、文字、选区和视口
- 根据自然语言生成流程图或其他结构化图形
- 移动元素、清空画布并连续完成多步任务
- 对选中的多个元素执行对齐、分布和排序
- 创建或更新箭头端点绑定，移动目标元素时保持连接
- 在聊天记录中展示 AI 的反馈和错误

Excalidraw 本身还提供选择、缩放、撤销、重做、图片、导出和本地文件等画布能力。

## 项目结构

```text
client/   浏览器端 React 组件、画布和聊天 UI
worker/   Cloudflare Worker、模型请求和 SSE 流
shared/   客户端与 Worker 共用的画布协议
public/   静态资源
```

## 画布操作协议

Agent 通过 JSON 返回以下操作：

- `message`：向用户发送反馈
- `create`：创建一个或多个画布元素
- `update`：修改元素属性
- `move`：移动元素
- `delete`：删除元素
- `clear`：清空画布
- `layout`：对选中的元素进行对齐、分布或排序
- `bind`：创建、更新或解除箭头端点与元素的绑定

协议定义位于 `shared/canvas.ts`。要扩展新的元素或操作，先更新协议，再同步修改 Worker 校验和客户端执行逻辑。

## 检查和构建

```powershell
npx tsc -b --pretty false
npm run build
npm test
npm run test:smoke
```

在 Windows 上，`npm run test:smoke` 还会启动 Tauri 开发模式、构建发布版并启动发布版可执行文件；其他平台执行浏览器 dev/preview smoke test。

## 常见问题

### AI 请求失败

检查以下内容：

- `.dev.vars` 是否存在
- `OPENAI_API_KEY` 是否有效
- `OPENAI_BASE_URL` 是否是兼容服务提供的 `/v1` 基础地址
- 服务是否支持 `/chat/completions` 和流式响应
- `OPENAI_MODEL` 是否和服务端实际提供的模型名称一致

修改 `.dev.vars` 后需要重启开发服务器。

### 页面没有反馈

打开浏览器开发者工具和 Worker 终端日志。Worker 会把配置、认证、网络、超时、Provider、JSON 解析、客户端和 CORS 错误区分为 SSE 或 HTTP 错误事件返回，聊天面板会显示具体原因。请求完成或失败都会发送终止事件，客户端不会一直保持忙碌状态。

## 许可证

Excalidraw 编辑器采用 MIT 许可证，详情见 [Excalidraw LICENSE](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)。本项目还包含各依赖自身的许可证，请以对应 npm 包中的许可文件为准。
