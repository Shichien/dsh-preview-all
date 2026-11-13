# dsh-preview-all-in-one

在 DSH 右侧边栏补充音视频、压缩包、字体、相机 RAW、文档和二进制文件预览。点开一个 `bundle.zip`、`tool.exe`、`MyFont.woff2`、`notes.rtf`、`raw.dng`，侧边栏会打开对应的面板；具体内容能否解码取决于文件变体、大小限制和浏览器能力。

插件保留 Markdown、HTML、常见图片、PDF、Office 文档和源代码等已有预览的入口，只认领下表列出的扩展名。每个类别有对应的呈现方式：

| 类别 | 扩展名 | 面板 |
| --- | --- | --- |
| 音视频（42） | `mp4 m4v mov webm ogv mkv avi wmv flv m2ts vob rmvb` `mp3 flac wav ogg opus m4a aac wma ape wv` … | HTML5 播放器（见下） |
| 压缩包（51） | `zip 7z rar tar gz bz2 xz zst tgz cab` `jar war apk ipa nupkg vsix crx xpi whl` `epub cbz cbr` `docm dotm xlsm pptm wps et dps` `blend1 fig kra ora sketch xd` … | 条目清单 + 就地预览文本/图片 |
| 字体（7） | `ttf otf ttc woff woff2 eot pfb` | 用 `@font-face` 加载的样张 + 字体元数据 |
| 相机 RAW / 图层（10） | `tif tiff psd psb dng cr2 nef arw rw2 orf` | 主机端解码成 PNG 显示 |
| 图片容器（5） | `avif heic heif hif jxl` | 直接交给浏览器解码 |
| 文档（11） | `rtf odt ods odp odg fodt fods fodp sxw sxc sxi` | 主机端转成 HTML，在沙箱 iframe 里显示 |
| 其他二进制（38） | `exe dll so dylib bin obj wasm class pyc` `dmg iso msi deb rpm` `sqlite db pdb sys dmp` `ai eps ps icns cur crash pak dat` | 识别格式 + 文件头十六进制 |

客户端一共认领 164 个扩展名；表中数量按认领范围统计，媒体的 `.ts` / `.mts` 只保留 Host 识别，不抢占源码 tab。认领表示会打开对应面板，不保证每种内部编码都能预览。每个面板都有“下载”和“重新加载”。

## 播放器

音视频面板保留原来的完整功能：

- **右键菜单**（或点播放器下方的速度按钮）：速度档位 0.5×–4×、±0.1 微调，以及播放、快进退、逐帧（近似）、截图、循环、静音、画中画、全屏、从头播放。
- **快捷键**（先点一下播放器）：空格 播放/暂停；←/→ 5 秒，Ctrl+←/→ 30 秒；↑/↓ 音量；M 静音；`,`/`.` 逐帧（近似步进）；C/X 加减 0.1×，Z 恢复 1.0×；0–9 跳到 0%–90%；Home 从头；F 或 Enter 全屏；Ctrl+C 复制当前画面；Ctrl+S 保存 PNG；? 显示快捷键说明。
- **记住进度**：每个文件的播放位置存在浏览器里，下次打开自动接着放。离开头不到 5 秒或离结尾不到 10 秒时不记录。最多记 200 个文件。
- **记住速度和音量**：下次打开任何文件都沿用。
- **切走不停，关闭才停**：切到别的 tab 或收起侧边栏时继续播放（只顺手保存一次进度）；关闭这个预览 tab 时才暂停、保存进度并释放视频元素。
- **无法解码时明确提示**：浏览器不支持文件内部的编码（常见于 HEVC/H.265 的 mp4/mov，或 mkv 里的非常见编码）时，播放器照常打开，并给出说明和下载链接，不做转码。

## 压缩包

清单显示条目名称、目录标记、大小和加密状态。所有容器（ZIP、TAR、7z、RAR）的侧边栏清单最多返回 5000 条；面板每次显示最多 2000 行，可用筛选缩小范围。筛选只针对已经返回的条目，不能继续搜索被截断的部分。可以就地预览可提取的文本或图片条目，或下载整个压缩包。

- ZIP 提取支持未加密的 Stored / Deflate 条目；TAR 支持直接读取，也支持 gzip、bzip2、xz 和运行时可用的 zstd 压缩流。普通 `.gz`、`.bz2`、`.xz`、`.zst` 内若检测到 TAR，也按 TAR 条目显示和提取。
- 7z / RAR 当前只提供清单，不支持成员提取；加密头或不支持的编码也可能无法列出。认领的后缀不代表能解码其所有变体，例如 CAB 或不同版本的应用专用容器可能只能显示提示与下载入口。
- ZIP 及其同类容器（`.jar`、`.apk`、`.epub`、`.whl` 等）按字节范围读取：清单只读中央目录，预览只读该条目自己的压缩数据，不受文件大小限制，也不会把整包读进内存。
- TAR、压缩流、7z、RAR 没有可随机访问的索引，需要整包读入：文件上限 192 MiB，压缩流解压后的大小上限同样是 192 MiB（超过即拒绝并说明原因；gzip 先看尾部声明的大小，不解压就能拒绝）。解析在 worker 线程里进行。
- 文件与解压结果合计不超过 64 MiB 的压缩包，worker 会保留最近打开的一个，最多 1 分钟：列完清单再点条目时不用重新读文件、重新解压。文件一旦改动（版本标记变化）就不再复用。
- 单个预览条目上限为 16 MiB。具体路由限制见 [archive/index.js](<lib/formats/archive/index.js>)。
- 项目要求 Node.js 20 或更新版本；zstd 是可选能力。[Node 原生 zstd API](https://nodejs.org/api/zlib.html#zlibzstddecompresssyncbuffer-options) 从 v22.15.0 / v23.8.0 引入。代码检测 `zstdDecompressSync` 是否存在；Node 20 等缺少该 API 的运行时会对 zstd 返回不支持，其余压缩格式仍可加载。

字体解析/样张请求的文件上限为 64 MiB，文档与主机端图像解码的文件上限各为 96 MiB。RAW、PSD、TIFF 的可预览范围取决于解码器支持的布局和压缩方式；HEIC、AVIF、JXL、字体样张和音视频则还取决于浏览器的解码能力。主机端图像解码另有约 6700 万像素（64 Mi px）的上限。文档转换提供可读的 HTML，不保证原应用的完整排版；转换结果超过约 100 万字符时只显示开头部分并给出提示，完整内容请下载查看。

## 按需加载与内存

插件启用后，没有打开预览时只常驻两样东西：一份后缀清单，和一个不含任何面板的入口 bundle。其余代码都在第一次用到时才加载，类似 VS Code 的 activation event。

- **Host**：路由表和后缀分类只来自 manifest 数据。某个类别的 Host 模块连同它的解析器，在该类别的文件第一次被预览时才 `import()`，之后缓存。只看视频时，7z、TIFF、字体等解析器不会进内存。
- **Client**：入口 [client.js](<lib/client.js>) 随页面加载，只负责注册 tab 类型和外壳。每个类别的面板是独立的 `lib/client.<kind>.js`，打开该类文件时才由 DSH 加载器拉取一次。拉取与 `/preview/info` 请求并行发出，不增加等待。播放器（面板、运行时、样式）整体在 media chunk 里。
- **整文件解析排队**：需要把文件读进内存的类别（manifest 里 `buffersWholeFile: true`：压缩包、字体、图像解码、文档）同一时刻只处理一个请求，其余排队；请求被取消时直接离队。恢复会话时同时打开多个预览，峰值内存是一个文件而不是全部相加。音视频、下载和二进制信息是流式或只读文件头，不排队。整文件按 4 MiB 一段读进一个独占的缓冲区，而不是用文件服务的 `readBytes`（它会在拼接时短暂持有两份）。
- **耗时解析放到 worker 线程**：压缩包（非 ZIP）、TIFF/PSD 解码和文档转换在一个按需启动的 worker 里执行（[offload.js](<lib/shared/offload.js>)，各类别的任务在 `tasks.js`）。Host 与 DSH 其余部分共用一个事件循环，解码器在上面跑几秒就是整个应用卡几秒；放进 worker 后，关掉 tab 会直接终止正在进行的解析，单个任务超过 30 秒或超出 worker 的 768 MiB 堆上限时返回 413 而不是拖垮 Host，空闲 20 秒后 worker 退出、内存归还系统。运行时无法启动 worker 时退回到 Host 线程解析并记录一条警告，结果不变。

## 组成

- **Host**（[插件入口](<lib/index.js>) 接入，[服务端](<lib/server.js>) 分发，各渲染类别负责解析与专用路由）：在 `/preview` 前缀下注册一组路由。
  - `GET|HEAD /preview/stream?sessionId=&path=` 音视频字节流，支持 HTTP Range（206/416），按 1 MiB 窗口发送，内存占用不随文件大小增长。
  - `GET /preview/info?sessionId=&path=` 文件分类与元数据 JSON：压缩包条目清单、字体信息、图像信息、渲染好的文档 HTML、二进制识别结果 + 十六进制头。
  - `GET /preview/entry?…&entry=` 一个压缩包条目，用于就地预览。
  - `GET /preview/raster` TIFF/PSD/RAW 解码后的 PNG。
  - `GET /preview/font` 字体文件本身，供 `@font-face` 使用。
  - `GET /preview/picture` AVIF/HEIC/JXL 原始容器，交给浏览器。
  - `GET /preview/download` 原始文件字节，带 attachment 文件名。
  - 认证沿用 GUI 自己路由的连接校验（`ctx.connection.requestRejection`）；文件一律经 `ctx.fs` 读取，沙箱读权限与 DSH 自带文档预览一致；相对路径按会话工作目录解析，`absolute` 作用域的地址按绝对路径解析。
  - 文件内容与 JSON 响应使用 [共享响应头](<lib/shared/http.js>)：`cache-control: private, no-store`、`nosniff` 和 `content-security-policy: sandbox; default-src 'none'`。
- **Client**（共享源码与各类别的组件工厂由 `npm run build` 生成 [入口 bundle](<lib/client.js>) 和每个类别一个的 `client.<kind>.js`）：注册右侧边栏 tab 类型 `preview-all-in-one`，模式为 `dsh-resource://file/**/*.{…164 个扩展名…}`。它和 Better Sidebar 的 `dsh-resource://file/**` 同在 `extension` 档，模式更长，所以这些文件由本插件打开，其余文件照旧。文档面板里的 HTML 片段放在 `sandbox=""` 的 iframe 里，脚本无法执行。

## 安装

```sh
dsh plugin --profile desktop add github:Shichien/dsh-video-preview
```

`dsh plugin add` 只安装依赖，不会启用插件。还要在 profile 的 `package.json`（例如 `~/.dsh/profiles/desktop/package.json`）里，把 `"dsh-preview-all-in-one"` 加到 `dsh.profile.bundles` 列表里，然后刷新 DSH 页面。

本地开发时可以用 `link:` 安装源码目录；客户端修改需要重新构建后刷新页面，Host 修改需要重启 DSH，具体步骤见下方“客户端构建与本地开发”：

```sh
dsh plugin --profile desktop add link:/path/to/dsh-video-preview
```

## 项目结构

项目按 **7 个渲染类别**组织：`media`、`archive`、`font`、`raster`、`picture`、`document`、`binary`。一个目录可以处理多个后缀，例如 `.zip`、`.tar` 和 `.7z` 都归压缩包目录；已有类别增加后缀时，通常沿用该目录的面板。

```text
lib/
  index.js              Cordis 入口：把插件接入 DSH
  server.js             认证、参数校验、通用 info/download 路由与错误映射
  kinds.js              从 manifest 派生后缀分类与复合后缀解析
  offload-worker.js     worker 线程入口：按需加载 formats/<kind>/tasks.js 并执行
  shared/
    http.js             响应头、错误类型、分块写入
    fs.js               ctx.fs 文件读取、字节范围读取、Range 流式发送、大小与十六进制格式化
    path.js             跨平台路径的末尾扩展名解析
    gate.js             整文件解析的并发闸门
    offload.js          把耗时解析交给 worker 线程：启动、超时、取消、空闲退出
    transfer.js         跨线程时哪些缓冲区可以移交而不是复制
  formats/
    catalog.js          唯一的类别清单：导入各 manifest
    index.js            按需加载并缓存各类别的 Host 模块（loadFormat / loadRoute）
    media/              manifest.js index.js format.js client.js client-runtime.js client-css.js
    archive/            manifest.js index.js tasks.js zip.js sevenzip.js decompress.js entry-types.js client.js
    font/               manifest.js index.js parse.js client.js
    raster/             manifest.js index.js tasks.js decode.js client.js
    picture/            manifest.js index.js client.js
    document/           manifest.js index.js tasks.js xml.js render.js client.js client-css.js
    binary/             manifest.js index.js inspect.js client.js
  client/
    image.js            raster 与 picture 共用的图片组件工厂
    legacy-tabs.js      旧 video-preview tab 的持久化记录迁移
    *-*.js              常量、词典、URL 工具、共享样式与 UI、面板按需加载、注册与根面板
  client.js             生成的入口 bundle，不含面板（勿手改）
  client.<kind>.js      生成的按需 chunk，每个类别一个（勿手改）
scripts/
  build-client.mjs       零依赖客户端构建与 --check 校验
```

### 格式声明与模块接口

各类别的 `manifest.js` 声明 `kind`、`extensions`、`routes`（没有专用路由时用空对象），以及可选的 `unclaimedExtensions`、`compoundExtensions`。以 [压缩包 manifest](<lib/formats/archive/manifest.js>) 与 [媒体 manifest](<lib/formats/media/manifest.js>) 为例：

- `extensions` 列出 Host 识别的后缀；扣除 `unclaimedExtensions` 后生成客户端 tab 认领范围。
- `unclaimedExtensions` 是上述后缀中的排除项：保留 Host 分类，但不加入客户端 tab glob。媒体的 `.ts` / `.mts` 使用此项，避免抢占 TypeScript 源码预览。
- `compoundExtensions` 用于优先识别 `.tar.gz` 等复合后缀。
- `routes` 将子路由名映射到本类别 Host 模块的导出函数名，例如压缩包的 `entry` 对应 `serveEntry`。
- `buffersWholeFile: true`（可选）表示本类别会把文件读进内存解析；服务端据此让它的 `describe` 与路由处理器排队执行。
- `ownChrome: true`（可选）表示面板自己绘制顶部区域，外壳不再加“文件名 / 大小 / 下载”条。目前只有媒体使用。

[类别清单](<lib/formats/catalog.js>) 是类别枚举的唯一入口，并在加载时校验类别名、后缀与路由的合法性及重复归属，以及排除项是否属于已识别后缀。[分类模块](<lib/kinds.js>)、[Host 注册表](<lib/formats/index.js>)、[服务端路由表](<lib/server.js>) 和 [客户端构建](<scripts/build-client.mjs>) 都由这份清单派生，无需分别维护后缀表、路由表和面板名表。

每个类别的 `index.js` 导出 `describe()`，为 `/preview/info` 提供该类别的 JSON；有专用路由时，按 manifest 的 `routes` 导出相应处理函数。可选的 `downloadTypeOf()` 提供下载 MIME。需要退回二进制信息面板时，`describe()` 返回 `kind: 'binary'` 与提示，由服务端统一补充二进制信息。解析器留在同目录，例如 [ZIP/TAR 解析器](<lib/formats/archive/zip.js>) 和 [字体解析器](<lib/formats/font/parse.js>)。

Host 调用时传入一个对象；模块只需解构自己使用的字段：

```js
async function describe({ ctx, target, size, path, signal, suffix, base }) {
  // target 已解析并 stat；返回要合并进 /preview/info 的 JSON 字段。
}

async function serve({ ctx, req, res, url, sessionId, path, signal }) {
  // 按需解析/读取文件，通过 res 写响应；函数名由 manifest.routes 指定。
}
```

`base` 包含文件名、路径、大小、大小文案、后缀与初始类别；`signal` 用于取消读取。路由处理器会收到完整 URL，可自行读取额外查询参数，例如 `serveEntry` 的 `entry`。

每个类别的 `client.js` 是原生 ES 模块，默认导出 `createPanel(services)`，返回 React 面板组件。依赖通过 `services` 显式传入，可以单独导入工厂进行测试。类别还可以在同目录放两个可选文件，它们只进入本类别的 chunk：

- `client-runtime.js`：默认导出 `() => runtime`，结果以 `services.runtime` 传给面板。播放器的状态存储、快捷键与截帧工具在 [媒体运行时工厂](<lib/formats/media/client-runtime.js>)。
- `client-css.js`：默认导出一段 CSS 字符串，chunk 到达时追加进插件的样式表，例如 [播放器样式](<lib/formats/media/client-css.js>)。

[共享图片工厂](<lib/client/image.js>) 为 raster 与 picture 提供共用展示组件，留在入口里。

### 客户端构建与本地开发

DSH 的客户端加载入口是 `exports["./client"]`，指向生成的 [入口 bundle](<lib/client.js>)。源码仍按类别分开放置；[构建脚本](<scripts/build-client.mjs>) 导入 manifest 和客户端工厂，将工厂函数序列化进产物，并通过 DSH 的加载器取得共享 React。构建不依赖额外打包工具。产物全部平铺在 `lib/`：

- `client.js`：入口。内容依次为 manifest 数据、序号小于 45 的共享片段、共享图片组件、`services`、后缀注册表、旧 tab 迁移函数、序号大于 45 的共享片段。数字前缀片段按文件名排序。
- `client.<kind>.js`：每个类别一个 chunk，包含该类别的面板工厂及可选的运行时与样式，导出 `{ kind, createPanel, css?, runtime? }`。入口用 `require.async("./client.<kind>.js")` 拉取，再把自己的 `services` 传给 `createPanel`。

工厂需要把实现放在函数体内，外部依赖从 `services` 获取；构建不会自动收集函数闭包里的模块变量。原生模块需要显式导入和初始化，不能当作普通片段直接拼接。DSH 加载器对 chunk 有三条硬性要求，构建和测试都会检查：文件名形如 `client.<name>.js` 且与入口同目录；不能以 `client.node.` 开头（所以类别不能叫 `node`）；chunk 必须自包含，不能同步 `require` 入口或其他 chunk。

chunk 的 URL 版本号取自入口文件的 stat，所以 `npm run build` 每次都会重写全部产物；不要单独手改某个 chunk。类别被删除后，构建会清理它留下的 chunk。

```sh
npm run build
npm test
```

修改客户端源码、manifest 或构建逻辑后，先运行 `npm run build`。`npm test` 的前置检查会比较源码应生成的内容与 `lib/` 里的入口和全部 chunk；任何一个过期或多余都会直接失败。重新构建后刷新 DSH 页面以验证客户端变更。修改 Host 代码或影响 Host 分类/路由的 manifest 后，需要重启承载插件的 DSH 进程；仅刷新页面不会重新加载 Host 模块。

### 扩展已有类别或增加新类别

**给已有类别增加 `.foo`：** 在该类别 manifest 的 `extensions` 中登记，然后在同目录补足解析、MIME 或展示逻辑。若只希望 Host 识别而不认领 tab，使用 `unclaimedExtensions`。添加回归测试，重新构建并运行测试；无需修改 [分类模块](<lib/kinds.js>) 或通用路由分发器。

**增加一个新渲染类别：** 新建 `lib/formats/foo/`，放三个文件，再在 [类别清单](<lib/formats/catalog.js>) 中导入并登记一次（两行）：

| 文件 | 内容 |
| --- | --- |
| `manifest.js` | `kind`、`extensions`、`routes`（没有专用路由写 `{}`） |
| `index.js` | Host：导出 `describe()`，以及 `routes` 里声明的处理函数 |
| `client.js` | 默认导出 `createPanel(services)` |

构建会自动产出 `lib/client.foo.js`，Host 模块和面板都只在打开 `.foo` 文件时加载，无需改动路由分发、分类、构建脚本或入口。面板专用的样式放 `client-css.js`，较大的辅助逻辑放 `client-runtime.js`。界面文案目前仍登记在共享词典 [中文](<lib/client/20-locale-zh.js>) / [英文](<lib/client/21-locale-en.js>) 里。需要整文件解析时在 manifest 加 `buffersWholeFile: true`；解析可能超过几十毫秒时，把纯计算部分写成 `tasks.js` 的具名导出 `(bytes, args) => result`，在 Host 模块里用 `runTask('foo', '任务名', bytes, args, signal)` 调用（`bytes` 会被移交，之后不能再用）。只有需要新的共享依赖时，才扩展构建阶段提供的 `services`。最后补测试，执行构建和测试。

## 测试

```sh
npm test
```

`npm test` 先检查构建产物是否最新，再运行 `test/*.test.js`，包括归档提取与条目上限的回归测试。新增测试应使用 `.test.js` 后缀。

### 大文件压力测试

```sh
npm run stress                         # 全部 23 个场景，一两分钟
npm run stress -- --only=rtf-long,tiff-photo
npm run stress -- --keep               # 保留夹具，下次不用重新生成
npm run stress -- --dir=D:\scratch     # 夹具目录，默认 .stress-tmp
```

不属于 `npm test`。脚本先在本地生成夹具（仓库里不存大文件）：5 GiB 的稀疏 ZIP64 / 视频 / 镜像、20 万条目的 ZIP、15 万成员的 175 MiB TAR、10 万条目的 7z、解压后 500–600 MiB 的 gzip / zstd / bzip2 / xz 炸弹、32 MiB 文本的 `.tar.bz2` / `.tar.xz`、90 MiB 的 TIFF、8192×8192 的 TIFF 与 PSD、90 MiB 的 RTF、60 MiB XML 的 ODT、63 MiB 的字体。实际占用磁盘约 600 MiB（几个 GiB 级文件是稀疏的），结束后自动删除。生成压缩夹具需要系统的 `tar`（bsdtar），稀疏文件在 Windows 上用 `fsutil`；缺工具的场景标记为 SKIP。

每个场景在独立进程里对真实路由发请求，记录耗时、Host 事件循环最长阻塞（`stall ms`）、进程峰值内存增量（`+peak MiB`，含 worker）和读取字节数，并与 [scenarios.mjs](<test/stress/scenarios.mjs>) 里的预算比较；结果不对或超预算则退出码非零。预算来自代码里的硬上限，不是某次运行的实测值；所有场景的 Host 阻塞上限都是 150 ms。`+rest MiB` 是请求结束 0.3 秒后的采样：Windows 在 worker 退出后 20–30 秒才把它的内存页收回，所以这一列偏高，只作参考。

[排名检查脚本](<test/ranking.check.mjs>) 用真实的 picomatch 规则验证 tab 类型排名；设置 `PICOMATCH_FROM` 为能解析到 picomatch 的绝对文件路径。下面是 Windows 上的一种安装路径示例：

```sh
$env:PICOMATCH_FROM='D:\DSHDesktop\DSH Desktop\resources\app\node_modules\picomatch\package.json'
node test/ranking.check.mjs
```

生成一个 8 秒的 H.264 测试视频，用于手动试播：

```sh
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440 -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart samples/test.mp4
```
