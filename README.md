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
```

服务需要支持 Chat Completions、流式输出和模型对应的输入能力。项目会把 API key 留在 Cloudflare Worker 环境中，不会发送到浏览器端。

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

## 当前 AI 配置

- Provider：OpenAI 兼容接口
- API：Chat Completions
- 默认模型：`grok-4.6`
- 服务端：Cloudflare Worker 本地运行时
- 画布：Excalidraw infinite canvas

模型和中转配置分别位于 `worker/agent/AgentService.ts` 与 `.dev.vars`。模型输出会被校验为画布操作，成功和失败都会通过 SSE 返回给客户端。

## 主要功能

Agent 默认可以：

- 创建、修改和删除矩形、椭圆、菱形、文本、箭头、线条和自由笔迹
- 读取画布中的元素、文字、选区和视口
- 根据自然语言生成流程图或其他结构化图形
- 移动元素、清空画布并连续完成多步任务
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

协议定义位于 `shared/canvas.ts`。要扩展新的元素或操作，先更新协议，再同步修改 Worker 校验和客户端执行逻辑。

## 检查和构建

```powershell
npx tsc -b --pretty false
npm run build
```

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

打开浏览器开发者工具和终端日志。Worker 会把配置错误、上游模型错误和 JSON 解析错误作为 SSE 错误事件返回，聊天面板会显示具体原因。

## 许可证

Excalidraw 编辑器采用 MIT 许可证，详情见 [Excalidraw LICENSE](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)。本项目还包含各依赖自身的许可证，请以对应 npm 包中的许可文件为准。
