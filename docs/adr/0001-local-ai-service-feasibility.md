# ADR-0001：桌面端本地 AI 服务可行性评估

- 状态：暂缓实现
- 日期：2026-09-02
- 范围：桌面端 AI 请求路径；不改变浏览器或远程 Worker

## 决策

暂不实现桌面端 Rust 本地请求 broker，也不在安装包中加入本地模型推理服务。浏览器和 Windows 桌面继续共用远程 Cloudflare Worker；本次评估不会改变当前请求、打包或发布流程。

这里的“Rust 本地请求 broker”指 Tauri 进程内的原生请求层：它从操作系统凭据存储读取用户的 Provider 配置，然后直接请求 OpenAI 兼容接口。它不等于本地模型推理。进程内 broker 有可行性，但目前没有足够的产品收益抵消桌面专属的安全、平台和维护成本。

本地模型推理另行判定为放弃当前方案：它会引入模型文件、推理运行时和显著的内存/CPU 预算，不符合现阶段的低资源目标。只有明确的离线推理产品需求和独立的模型运行时预算出现时，才应新建一份决策评估。

## 当前基线和证据

当前实现提供了以下基线：

- `client/agent.ts` 的 `getWorkerStreamUrl` 让浏览器默认请求 `/stream`，桌面端要求配置远程 HTTPS Worker；客户端只读取 `VITE_AI_WORKER_URL`。
- `worker/environment.ts` 将 `OPENAI_API_KEY`、Provider 地址和模型保留在 Worker 环境；`worker/agent/AgentService.ts` 已包含流式 Chat Completions、有限超时、有限重试和错误分类。
- `src-tauri/tauri.conf.json` 将构建资源嵌入 Tauri，`src-tauri/Cargo.toml` 没有本地 AI 或 sidecar 依赖。发布版的应用逻辑只有桌面可执行文件，不启动 Node、Wrangler 或 Cloudflare sidecar。
- `scripts/smoke-test.mjs` 验证浏览器、Tauri 开发版和发布版的启动，并对发布版进程树检查已禁止的 sidecar 名称；`scripts/windows-installer-smoke.mjs` 另行验证 Windows 安装、启动、同样的 sidecar 名称检查和卸载。`tests/desktop-config.test.ts` 固定了这些发布约束。
- `README.md` 已声明 API key 不进入浏览器端，桌面发布版 AI 请求仍发往 `VITE_AI_WORKER_URL`。客户端源码只读取 `VITE_AI_WORKER_URL`，不读取 `OPENAI_*`；但当前没有构建产物扫描，因此这仍依赖环境变量隔离和配置不包含秘密，而不是自动化安全保证。

仓库目前没有冷启动、空闲 RSS、AI 请求期间 CPU 或内存的数值基线。下面标记为“预期”的资源差异是工程判断，不是已测量的性能承诺；采用前必须按“复评门槛”实测。

## 方案比较

| 维度 | 远程 Worker（当前） | Rust 进程内请求 broker（候选） | 判断 |
| --- | --- | --- | --- |
| 功能 | 浏览器和桌面共用一个 `/stream` 契约；Worker 负责 Provider 认证、Chat Completions 流式传输、图片上下文、校验、超时、重试和错误事件。 | 只覆盖桌面；需要在 Rust 中重做或重新承诺 HTTPS、流式解析、图片请求、超时、重试、错误码、request id 和脱敏诊断。共享 JSON 协议不能自动共享 Worker 的 TypeScript 实现。 | Worker 已有功能闭环；broker 存在长期功能漂移风险。 |
| 可靠性 | 依赖桌面到 Worker 的网络、CORS 和 Worker 部署；配置集中，故障分类和重试集中修复，浏览器与桌面行为一致。 | 去掉 Worker 中转和 CORS，可直接访问企业 Provider 或代理；同时增加操作系统凭据、原生 TLS、Provider 兼容性和桌面版本差异。进程内失败不会增加 sidecar，但错误仍可能影响 Tauri 命令链。 | 只有“必须直连”场景才有明确收益；不是离线能力。 |
| 启动时间 | Tauri 冷启动只启动当前桌面应用；AI 连接在请求时建立，不启动本地服务。 | 进程内实现不增加常驻进程；凭据读取、TLS 客户端初始化和连接建立可推迟到首次请求。预期冷启动影响较小但尚未测量。 | 不能为了省一次网络跳转而引入启动时服务初始化。 |
| 内存和 CPU | 设备端没有模型或代理进程；请求期间主要是 WebView、画布状态、JSON/图片序列化和网络流。Worker 的计算成本在云端。 | 原生 HTTP/TLS/凭据代码增加固定开销，且仍需承担同样的请求体、SSE 和图片开销；预期小于本地模型运行时，但尚未测量。 | 若目标是低资源，进程内 broker 可能可控；本地推理不可接受。 |
| 浏览器覆盖 | 浏览器和桌面使用同一条可测试链路。 | 浏览器仍需 Worker，形成双后端和双套故障排查路径。 | 不应为了桌面选项牺牲浏览器主路径。 |
| 运维 | Provider key 在 Worker 环境中集中管理；发布资源是静态前端加 Tauri。 | 每个桌面用户维护 endpoint、model 和凭据；需要密钥迁移、撤销、导入/清除、平台权限和版本兼容。 | 当前阶段集中运维成本更低。 |

### 与本地模型服务的边界

如果“本地服务”指独立 localhost 服务或随包运行模型，则成本不再是上表中的小型 broker：需要额外可执行文件、模型下载/缓存、模型版本兼容、端口或 IPC、显存/内存检测和更长的首次启动。它还会直接破坏当前“单窗口、无应用 sidecar、低资源”的发布基线。因此本 ADR 不授权实现本地模型服务。

## 操作系统凭据存储

结论是“技术可行，产品上暂缓”。目标平台可以使用用户范围的系统存储：Windows Credential Manager、macOS Keychain、Linux Secret Service。Linux 的 keyring 是否可用取决于桌面会话和 Secret Service 实现，不能把 Windows 的成功直接外推到 Linux。

未来实现必须满足以下数据流约束：

1. key 不得通过 `VITE_*` 注入、写入 `dist/client`、写入 Tauri 资源、进入日志、错误文本、诊断事件或崩溃报告。构建产物只允许包含不带凭据或秘密查询参数的 Worker URL、Provider endpoint 和 model 配置。
2. key 不得由 WebView 表单或普通 `invoke` 参数往返。配置入口应由 Rust 侧调用系统凭据 API，并只向前端返回“已配置/未配置”和脱敏状态；否则 key 会短暂进入前端运行时，无法满足本 ADR 的保密边界。
3. 请求时由 Rust 侧读取 key，直接构造 HTTPS `Authorization` 请求头，不把 key 返回给前端；读取应尽可能晚，使用后尽快释放，日志和 crash diagnostics 不得包含秘密。
4. 凭据条目标识必须包含应用标识和 Provider 维度，升级时保持稳定；更换 Provider、清除凭据、导入失败和 key 无效都要有可诊断但不泄密的错误。卸载是否删除凭据需要明确的产品选项，不能由安装器静默猜测。
5. 任何未来的 broker 方案都要增加构建产物扫描、凭据边界测试、错误/日志脱敏测试，并在每个支持的桌面平台上做真实 keyring 验证。不能只用内存 mock 宣称已完成安全评估。

因此，保存用户配置本身可行，但它不能把 key 安全地放进当前浏览器配置模型；它要求新的原生配置 UX 和平台测试，这也是暂缓的主要原因之一。

## 安装包、进程、升级和诊断影响

### 进程和安装包

首选的未来形态如果仍要尝试，应是 Tauri 进程内 broker，而不是 localhost sidecar。进程内形态不需要开放端口、处理端口冲突、管理子进程退出或让安装器携带第二套可执行文件。它仍会增加 Rust 依赖、平台适配代码、签名审查和发布测试。

独立本地服务会额外增加安装包体积和生命周期：安装时复制/注册，启动时拉起并等待健康检查，运行时处理崩溃和残留进程，升级时替换正在运行的文件，卸载时清理服务、端口和缓存。它还会使当前 `findSidecarProcesses` 对 Node、Wrangler 和 Cloudflared 等已禁止进程名称的检查需要改成明确的进程白名单；现有检查不能保证不存在任意名称的 sidecar。

本地模型服务还要为模型文件单独处理下载、磁盘空间、校验、回滚和版本兼容；不应把这些成本隐藏在普通 Tauri 安装包中。

### 升级

远程 Worker 只需发布 Worker 和静态桌面资源，Provider 配置留在部署侧。Rust broker 需要维护凭据命名空间、配置 schema 和协议版本；升级不能把 key 复制到新的配置文件，也不能因为旧版本不认识配置而回退到明文存储。若引入依赖或原生权限，Windows NSIS/MSI 以及未来的 macOS/Linux 包都要重新验收。

### 故障诊断

当前 Worker 已能以 request id、状态、耗时、重试次数和错误分类支持诊断，且不记录 key、完整提示词或画布内容。未来 broker 若实现，应保持同一诊断字段，并额外记录 `backend=rust`、Provider 主机（不含路径中的秘密）和凭据存储错误类别。诊断不得记录 Authorization、key、完整请求体、完整模型输出或画布图片。

支持流程也会分叉：远程路径可以通过 Worker 日志定位部署/Provider 问题；本地路径还要收集应用版本、操作系统、keyring 可用性、代理/TLS 错误和进程退出原因。没有这些信息时，用户看到的“AI 请求失败”会比当前路径更难归因。

## 采用建议和复评门槛

当前建议：

- 采用：继续采用远程 Worker，作为浏览器和 Windows 桌面默认 AI 路径。
- 暂缓：不实现 Rust 进程内请求 broker，待下列触发条件和实测门槛满足后再做桌面限定的 spike。
- 放弃（当前范围）：不实现随包本地模型推理或常驻 localhost AI 服务。

只有同时满足以下条件，才重新评估 Rust broker：

1. 产品有明确需求要求 Provider 直连、企业代理/私有 endpoint、数据不经当前 Worker，且需求不能由 Worker 配置和部署解决。Rust broker 本身不提供离线能力；离线需求应单独评估本地推理。
2. 先补齐 Windows 发布版基线：冷启动 p95、空闲 60 秒 RSS/CPU、空画布和复杂画布的 AI 请求期 RSS/CPU，以及同一 Provider 的 Worker 网络开销。当前仓库没有这些数值，不能用“Rust 更省资源”作为采用理由。
3. broker spike 满足建议门槛：冷启动 p95 不比基线增加超过 250 ms，空闲 RSS 增量不超过 50 MB，空闲 CPU 在 60 秒窗口内不持续超过 1%，且同一 Provider 的流式请求 p95 不劣于 Worker 路径（拆开模型生成时间和网络时间比较）。这些是复评门槛，不是本次已测量结果。
4. 安全设计确认 key 永不进入前端 bundle、Tauri 资源、日志和诊断；Windows Credential Manager 的真实读写、凭据清除、升级保留和异常行为通过测试。扩展到 macOS/Linux 前，还要分别验证 Keychain/Secret Service 和安装包流程。
5. broker 保持进程内、桌面限定、可关闭的能力开关，且浏览器继续走 Worker；Tauri 开发/发布、NSIS/MSI 安装卸载、无已禁止 sidecar 名称的断言和 AI 协议兼容测试全部通过。

若产品需求只是“减少一次远程跳转”或“让桌面端也能配置 key”，而没有隐私、企业网络或可量化 SLO 问题，则继续暂缓。

## 对交付的影响

本 ADR 是评估结果，不引入 Rust 请求代码、凭据插件、本地服务、sidecar、安装器变更或前端配置变更。因此它不阻塞远程 Worker、浏览器版本或 Windows 桌面版本的交付；现有发布 smoke test 和安装器 smoke test 继续作为门禁。

## 复核依据

- [Windows password handling and Credential Manager](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [freedesktop Secret Service API](https://whot.pages.freedesktop.org/xdg-specs/secret-service/latest/ch01.html)
- [远程请求入口](../../client/agent.ts)
- [Worker 配置](../../worker/environment.ts)
- [Tauri 配置](../../src-tauri/tauri.conf.json)
- [发布进程检查](../../scripts/release-assertions.mjs)
- [桌面启动 smoke test](../../scripts/smoke-test.mjs)
- [Windows 安装器 smoke test](../../scripts/windows-installer-smoke.mjs)
