# ADR-0002：macOS 和 Linux 桌面目标评估

- 状态：评估完成，暂不加入当前发布范围
- 日期：2026-09-02
- 范围：Tauri 桌面构建、分发、更新、安装卸载和运行时差异
- 相关范围：不改变浏览器和 Windows 发布路径

## 决策

当前继续只发布浏览器版本和 Windows 桌面版本。macOS 是下一个优先评估的桌面目标，Linux 暂定为有明确用户需求后再做受限试点；本次不新增目标平台配置、安装包、Updater、原生凭据插件或 sidecar。

macOS 的技术路径可行，增量成本主要集中在 Apple 构建机、双架构产物、Developer ID 签名、公证和真实设备验收。Linux 的 Tauri 代码路径同样可行，但 Linux 不是一个单一运行时：WebKitGTK、glibc、显示服务器、桌面环境、包管理器和沙箱分布在不同发行版和格式中。基于持续维护成本，不能把“能构建 Linux 二进制”当作“支持 Linux”。这是基于下文平台事实的工程判断。

## 当前基线

仓库现状决定了这次评估的主要风险在发布和平台运行时，而不是前端业务逻辑：

- `src-tauri/tauri.conf.json` 将 `../dist/client` 作为 `frontendDist`，应用只有一个 `main` 窗口，当前 bundle 目标是 `nsis` 和 `msi`。
- `vite.config.ts` 使用 `base: './'`，桌面发布资源使用相对路径；没有配置额外 `bundle.resources`，也没有本地 HTTP 服务。
- `src-tauri/src/lib.rs` 已首先注册 `tauri-plugin-single-instance`，重复启动时会唤回、显示并聚焦 `main` 窗口；Cargo 依赖中没有 AI 服务或外部二进制。
- `client/agent.ts` 只读取 `VITE_AI_WORKER_URL`，桌面 AI 请求仍发送到远程 HTTPS Worker；画布持久化使用 WebView 的 `localStorage`。
- 当前 `capabilities/default.json` 只授予 `core:default`，没有文件系统、shell、opener、凭据或网络插件权限。
- `scripts/smoke-test.mjs` 和 `scripts/windows-installer-smoke.mjs` 只对浏览器和 Windows 做启动、进程树、安装及卸载验证；没有 macOS/Linux 设备或发行版矩阵的实测数据。

Tauri 的进程模型是一个 Rust core 进程管理一个或多个系统 WebView 进程；WebView 库在运行时由操作系统提供，而不是随最终可执行文件一起打包。[Tauri Process Model](https://v2.tauri.app/concept/process-model/) 说明了这一点。因此，下文的启动、内存和 CPU 结论均为风险评估，不是性能承诺。

## 构建和发布路径

| 维度 | macOS | Linux | 结论 |
| --- | --- | --- | --- |
| 构建 | Tauri CLI 可直接生成 `.app` 和 DMG。需要 macOS 构建机；Tauri 要求安装 Xcode 或仅桌面开发所需的 Xcode Command Line Tools。可分别构建 `aarch64-apple-darwin`、`x86_64-apple-darwin`，或安装两个 Rust target 后生成 `universal-apple-darwin`。依据：[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)、[Tauri CLI](https://v2.tauri.app/reference/cli/)。 | Tauri CLI 原生可生成 AppImage、Debian 和 RPM；Snap、Flatpak 与 AUR 需要各自的清单或包仓流程，不能视为同一条 CLI bundle 路径。开发依赖随发行版变化，且 Tauri 要求 `webkit2gtk-4.1`；Debian/Ubuntu、Fedora、Arch 等构建环境不能随意混用。依据：[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)、[Tauri CLI](https://v2.tauri.app/reference/cli/)、[Tauri distribution overview](https://v2.tauri.app/distribute/)。 | macOS 可以在一个受控的 Apple runner 上形成小矩阵；Linux 必须先声明支持的发行版和构建基线。 |
| 签名 | 浏览器下载的应用需要代码签名；直接分发应使用 Developer ID Application，并启用 Hardened Runtime、secure timestamp 后提交 Apple notarization。Tauri 需要 Apple 设备，生产签名需要付费 Apple Developer 账户；免费账户只能用于测试。依据：[Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)、[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。 | Linux artifact 签名不是部署硬要求。AppImage 可用 GPG 签名，但 AppImage 本身不会验证嵌入签名，用户仍需使用验证工具；发布方必须通过经过认证的渠道发布公钥指纹。Debian/RPM 还要按所选仓库或包签名流程建立信任。依据：[Tauri Linux signing](https://v2.tauri.app/distribute/sign/linux/)。 | macOS 的签名和公证是发布门槛；Linux 不能把一个 GPG 签名流程等同于发行版仓库信任。 |
| 首次安装 | DMG 包含 `.app` 和 Applications 文件夹，用户将应用拖入 Applications。也可后续评估 Mac App Store；该路径要求 App Sandbox 和另一套签名/审核流程。依据：[Tauri DMG](https://v2.tauri.app/distribute/dmg/)、[Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)。 | AppImage 下载后赋予可执行权限即可运行，不需要包管理器；`.deb` 由 Debian/Ubuntu 包管理器安装，并声明 `libwebkit2gtk-4.1-0` 和 `libgtk-3-0` 等运行依赖。依据：[Tauri AppImage](https://v2.tauri.app/distribute/appimage/)、[Tauri Debian](https://v2.tauri.app/distribute/debian/)。 | macOS 先走直接 DMG；Linux 先限定 AppImage，是否同时提供 `.deb` 取决于明确的 Ubuntu/Debian 用户需求。 |
| 卸载 | 直接分发的 `.app` 从 Applications 移到废纸篓即可移除程序本体；应用容器、Keychain 条目和用户数据不应被默认推断为已删除，必须在产品中定义保留/清除策略。Apple 文档说明沙盒容器位于 `~/Library/Containers` 并有独立生命周期。[Apple sandbox file access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)。 | AppImage 的程序本体是一个文件，删除该文件即可移除；它不会自动清理用户目录中的数据。[AppImage update and removal](https://docs.appimage.org/packaging-guide/optional/updates.html)。`.deb` 的 `dpkg --remove` 会保留 conffiles，`--purge` 也不负责清理用户 home 目录数据。[Debian dpkg](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html) | 安装验收必须分别验证程序本体、画布数据和未来凭据是否保留或清除，不能只检查可执行文件消失。 |
| 自动更新 | Tauri Updater 支持 macOS，生成 `.app.tar.gz` 和 `.sig`；DMG 是首次安装载体，不应直接当作应用内更新载体。 | Tauri Updater 支持以 AppImage 为基础生成 `.AppImage.tar.gz` 和 `.sig`；`.deb`/RPM 的更新更适合由发行版仓库或重新安装管理。Updater 的静态 JSON 必须为每个平台和架构提供 URL 与签名。依据：[Tauri Updater](https://v2.tauri.app/plugin/updater/)。 | 两个平台都需要先设计版本、签名私钥托管和回滚；不能在本次评估中直接引入 Updater。Linux 的首个可更新格式应是 AppImage，除非选择仓库分发。 |

### macOS 具体路径

未来 macOS 版本应在 macOS runner 上执行：

1. `npm run build` 生成 `dist/client`，使用当前 `frontendDist` 和 `base: './'` 构建 `.app`。
2. 先产出 Apple Silicon 和 Intel 两个架构；若产品需要一个下载链接，再评估 universal binary。Tauri CLI 明确要求 universal 构建同时安装两个 Rust target。[Tauri CLI](https://v2.tauri.app/reference/cli/)
3. 对 `.app` 使用 Developer ID Application 签名，启用 Hardened Runtime，提交 Apple notary service，并把 ticket staple 到发布物。Apple 要求分发到 App Store 之外的软件使用 Developer ID 和 notarization。[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
4. 以 DMG 做首次安装；使用 Tauri Updater 时，发布 `.app.tar.gz`、签名和静态 JSON 中对应的 `darwin-aarch64`、`darwin-x86_64` 或统一的自定义 target。[Tauri Updater](https://v2.tauri.app/plugin/updater/)
5. 在 Intel 和 Apple Silicon 真机上验证安装、重复启动、刷新后画布恢复、更新后画布恢复、从 Applications 移除和重新安装。

### Linux 具体路径

未来 Linux 试点只承诺一个明确基线：Ubuntu 22.04 和 Debian 12、x86_64、常用桌面会话。Tauri 文档建议使用同时提供 WebKitGTK 4.1 的最老目标系统构建；在更新系统上构建可能引入更高的 glibc 要求，因此应使用固定容器或 GitHub Actions。[Tauri Debian limitations](https://v2.tauri.app/distribute/debian/)

试点顺序如下：

- 首选 AppImage，覆盖不想配置包管理器的用户，并使用 Tauri Updater 的 AppImage 产物；发布页面必须带 HTTPS 下载、公钥指纹和手动签名验证说明。
- 按用户需求再增加 `.deb`，只承诺上述 Ubuntu/Debian 基线，明确 `webkit2gtk-4.1` 运行依赖和 `apt`/`dpkg` 的安装、升级、remove、purge 行为。
- 暂不承诺 RPM、Snap、Flatpak、AUR、ARM 或 Alpine。每增加一种格式，就增加包元数据、运行时依赖、沙箱、更新和安装卸载验收；Snap/Flatpak 还会改变单实例所需的 DBus 配置。

## 运行时差异

### 窗口和单实例

当前窗口尺寸、最小尺寸、`main` label 和重复启动回调可以复用。Tauri 的单实例插件明确支持 Windows、Linux 和 macOS，且插件必须尽早注册；当前 `lib.rs` 已把它注册在首位。[Tauri Single Instance](https://v2.tauri.app/plugin/single-instance/)

仍需平台验收的差异是：

- macOS 的原生标题栏、traffic lights、Retina 缩放、全屏/关闭窗口语义；当前配置没有自定义标题栏，因此不应假定 Windows 的像素和按钮行为完全相同。
- Linux 的 X11 与 Wayland、窗口管理器装饰、分数缩放和多显示器位置。必须至少在一个 X11 和一个 Wayland 会话中检查窗口打开、最小尺寸、聚焦和退出。
- Linux 单实例由 DBus 服务协调。在 deb、RPM 和 AppImage 中通常可直接工作；Snap/Flatpak 的沙箱默认阻断所需 DBus 通信，必须在 manifest 中声明 plug/slot。[Tauri Single Instance](https://v2.tauri.app/plugin/single-instance/)

### 本地资源和浏览器运行时

当前没有文件路径拼接或外部资源服务，`dist/client` 通过 Tauri 内置资源加载，`base: './'` 让构建后的脚本和样式使用相对 URL。这是两平台共用路径的低风险部分，但必须检查产物实际落点：macOS App Bundle 的资源位于 `Contents/Resources`；Linux 则可能位于包安装目录或 AppImage 挂载目录。[Tauri macOS App Bundle](https://v2.tauri.app/distribute/macos-application-bundle/)、[Tauri resources](https://v2.tauri.app/develop/resources/)

真正的兼容性风险来自系统 WebView：macOS 使用系统 WKWebView，Linux 使用 `webkit2gtk`；macOS WebKit 随系统更新，Linux WebKitGTK 随发行版仓库更新。[Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/) 因此必须在目标系统中验证 Excalidraw 绘制、图片元素、SSE 流、刷新后的 `localStorage` 和相对资源加载，而不是只在 Windows 或普通浏览器中验证。

### 权限和系统凭据

当前发布路径不需要新增 OS 权限：应用不读写原生文件、不启动 shell、不开放本地监听端口、不在 Tauri 中保存 API key，AI 继续通过远程 Worker 访问。Tauri capabilities 可以按窗口和平台授予权限；能力默认应保持最小，并可用 `platforms` 区分 Linux、macOS 和 Windows。[Tauri capabilities](https://v2.tauri.app/security/capabilities/)

若未来选择 Mac App Store 或增加原生文件/凭据能力，平台差异如下：

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 当前需要 | 无新增权限；现有 Windows smoke test 验证安装和启动。 | 直接 DMG 路径无新增业务权限；App Store 路径必须考虑 App Sandbox。 | 无新增权限；AppImage/deb 试点先不启用文件系统插件。 |
| 受限网络 | 当前前端访问远程 Worker，不在 Rust 中直连 Provider。 | App Sandbox 应显式声明 outgoing network client；App Store 分发必须启用 App Sandbox。[Apple App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox) | 普通 deb/AppImage 不提供 macOS 式 entitlement，但 Snap/Flatpak 需要通过接口/manifest 授权网络和 DBus。 |
| 用户凭据 | Windows Credential Manager 提供用户凭据的读、写、删除 API，如 `CredRead`、`CredWrite`、`CredDelete`。[Microsoft wincred.h](https://learn.microsoft.com/en-us/windows/win32/api/wincred/) | Keychain Services 将小型秘密放在加密 keychain 中，访问控制还受到 app 签名、ACL 或 keychain access group 影响。[Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)、[Apple Keychain ACL](https://developer.apple.com/documentation/security/access-control-lists) | Secret Service 是用户会话中的 DBus API，按 service、collection、item、session 和 prompt 管理秘密；具体可用性取决于运行中的实现。[freedesktop Secret Service](https://specifications.freedesktop.org/secret-service/latest/) |
| 迁移和删除 | 以稳定的 target name 区分 Provider；卸载器不应擅自删除用户凭据。 | 以稳定 bundle identifier 和 Provider 维度标识条目；更换签名身份、App Store/DMG 渠道或 access group 可能影响访问。 | 必须处理无图形会话、无 Secret Service、锁定 collection 和用户取消 prompt；不能把 keychain 成功外推到所有 Linux 桌面。 |

如果未来实现 Provider 直连，必须沿用 ADR-0001 的边界：API key 不能进入前端 bundle、普通 `invoke` 参数、日志、错误文本或诊断；Rust 只返回已配置状态，且请求时才从系统凭据存储读取。此次平台评估不授权实现该 broker。

## 启动、资源和 sidecar 风险

### 现状判断

- 启动：增加 macOS 或 Linux target 本身不会引入 Node、Wrangler、Cloudflare 或本地 AI 进程。Tauri 的 core 加系统 WebView 是既有架构；macOS 和 Linux 的 WebView 初始化时间仍需真实测量。
- 内存和 CPU：当前设备端没有模型运行时或 localhost 服务，主要开销预计来自 WebView、Excalidraw 画布状态、图片数据、JSON 序列化和 SSE 流。系统 WebView 版本及图形栈差异可能导致结果不同，不能从 Windows 可执行文件大小推导 RSS 或 CPU。
- sidecar：当前 Cargo、Tauri 配置和 release smoke test 都没有 sidecar。若未来只加入 Tauri Updater，它仍是应用内插件；若加入本地 AI 服务、Node、模型运行时或 Cloudflare 进程，则会重新引入端口、子进程退出、升级替换、残留进程和包体积风险，必须另开评估。
- 诊断：平台错误至少要区分 WebView 初始化、图形栈、网络/CORS、Updater 签名、公证/沙箱和凭据存储；不得将用户 key、完整画布或图片写入日志。

### 复评测量方案

这些数据目前都没有，必须在决定进入 beta 前由目标设备测量：

1. 每个平台和架构冷启动 10 次，记录进程开始到 `main` 窗口可交互的 p50/p95；目标为不比 Windows 基线增加超过 250 ms。
2. 空画布和复杂画布分别运行 60 秒，记录 core/WebView 总 RSS 与 CPU；空闲 CPU 不应持续超过 1%，相对 Windows 的空闲 RSS 增量不超过 50 MB。
3. 在相同 Worker、模型、提示词和画布上下文下运行流式 AI 请求，分离模型生成时间、网络时间和前端渲染时间；不能把系统 WebView 差异误判为 Worker 回归。
4. 对发布版进程树做白名单检查：除应用本身及系统 WebView 进程外，不得出现 Node、Wrangler、Cloudflared、模型服务或未声明的 helper。
5. 以干净用户目录验证首次启动、重复启动、相对资源、图片加载、localStorage 恢复、退出和更新；Linux 还要覆盖 X11/Wayland，macOS 还要覆盖 Intel/Apple Silicon。

测量结果应进入后续平台发布 ADR 或 release checklist。本文件中的门槛是 go/no-go 条件，不是本次已经达成的低资源基线。

## 支持时机和前置条件

### macOS：下一目标，完成前不发布

进入 macOS beta 前必须满足：

- Windows 的启动、空闲和 AI 请求资源基线已记录，且当前 Windows/browser 发布门禁保持通过。
- 有可复现的 macOS CI，能安全注入 Apple signing/notarization secrets；至少覆盖 `aarch64` 和 `x86_64`。
- Developer ID 签名、Hardened Runtime、公证、ticket stapling 和 Gatekeeper 首次启动通过真实 macOS 验收。
- DMG 安装、复制后启动、更新、降级/失败回滚、重复启动、卸载和用户数据保留策略通过测试。
- Tauri Updater 的公钥固定在应用配置中，私钥有备份和轮换/丢失应对方案；静态 JSON 为每个架构提供正确签名产物。

满足后，macOS 可先以直接 DMG + 应用内更新支持；Mac App Store 另行评估，不作为第一阶段前置范围。

### Linux：限定试点，晚于 macOS

进入 Linux beta 前必须满足：

- 书面声明支持 Ubuntu 22.04/Debian 12 x86_64；用固定构建环境验证 `webkit2gtk-4.1`、glibc 和桌面依赖。
- 先完成 AppImage 安装、执行权限、签名验证、更新和单文件移除；若发布 `.deb`，单独验证依赖、desktop entry、upgrade、remove 和 purge。
- 至少验证一套 X11 和一套 Wayland；检查窗口聚焦、DBus 单实例、剪贴板/图片、画布恢复和 AI 流式请求。
- 明确 AppImage 与 `.deb` 的更新责任，不把包管理器更新和 Tauri 应用内更新混在一个用户承诺中。
- 暂不因“Linux 用户可以手动修复依赖”扩大支持矩阵；RPM、Snap、Flatpak、AUR、ARM 和更多发行版需有需求、构建环境和维护负责人后再添加。

## 交付影响

本 ADR 只记录评估和发布顺序，不改变 `tauri.conf.json`、Vite、Tauri 依赖、AI Worker、浏览器发布或 Windows 安装器。当前产品交付继续由现有浏览器 smoke test、Windows 桌面 smoke test 和 NSIS 安装卸载 smoke test 负责；macOS/Linux 评估不会成为这些门禁的阻塞条件。

## 复核依据

- [Tauri distribution overview](https://v2.tauri.app/distribute/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri Process Model](https://v2.tauri.app/concept/process-model/)
- [Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/)
- [Tauri macOS Application Bundle](https://v2.tauri.app/distribute/macos-application-bundle/)
- [Tauri DMG](https://v2.tauri.app/distribute/dmg/)
- [Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [Tauri AppImage](https://v2.tauri.app/distribute/appimage/)
- [Tauri Debian](https://v2.tauri.app/distribute/debian/)
- [Tauri RPM](https://v2.tauri.app/distribute/rpm/)
- [Tauri Linux Code Signing](https://v2.tauri.app/distribute/sign/linux/)
- [Tauri Updater](https://v2.tauri.app/plugin/updater/)
- [Tauri Single Instance](https://v2.tauri.app/plugin/single-instance/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri resources](https://v2.tauri.app/develop/resources/)
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [Apple Access Control Lists](https://developer.apple.com/documentation/security/access-control-lists)
- [Microsoft wincred.h](https://learn.microsoft.com/en-us/windows/win32/api/wincred/)
- [freedesktop Secret Service](https://specifications.freedesktop.org/secret-service/latest/)
- [AppImage update and removal](https://docs.appimage.org/packaging-guide/optional/updates.html)
- [Debian dpkg](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html)
- [项目 Tauri 配置](../../src-tauri/tauri.conf.json)
- [项目 Vite 配置](../../vite.config.ts)
- [项目桌面启动 smoke test](../../scripts/smoke-test.mjs)
- [项目 Windows 安装器 smoke test](../../scripts/windows-installer-smoke.mjs)
- [ADR-0001：桌面端本地 AI 服务可行性评估](./0001-local-ai-service-feasibility.md)
