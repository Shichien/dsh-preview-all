# dsh-preview-all-in-one

在 DSH 右侧边栏预览**所有** DSH 自带预览不处理的文件。点开一个 `bundle.zip`、`tool.exe`、`MyFont.woff2`、`notes.rtf`、`raw.dng`，侧边栏会打开对应的面板，而不是“二进制文件，下载”。

DSH 自带预览已经覆盖 Markdown、HTML、图片、PDF、Office 文档、表格和源代码，这些扩展名本插件一个都不碰，仍旧交给它们。剩下的文件按下面几类各自有专门的呈现方式：

| 类别 | 扩展名 | 面板 |
| --- | --- | --- |
| 音视频（42） | `mp4 m4v mov webm ogv mkv avi wmv flv m2ts vob rmvb` `mp3 flac wav ogg opus m4a aac wma ape wv` … | HTML5 播放器（见下） |
| 压缩包（51） | `zip 7z rar tar gz bz2 xz zst tgz cab` `jar war apk ipa nupkg vsix crx xpi whl` `epub cbz cbr` `docm dotm xlsm pptm wps et dps` `blend1 fig kra ora sketch xd` … | 条目清单 + 就地预览文本/图片 |
| 字体（7） | `ttf otf ttc woff woff2 eot pfb` | 用 `@font-face` 加载的样张 + 字体元数据 |
| 相机 RAW / 图层（10） | `tif tiff psd psb dng cr2 nef arw rw2 orf` | 主机端解码成 PNG 显示 |
| 图片容器（5） | `avif heic heif hif jxl` | 直接交给浏览器解码 |
| 文档（11） | `rtf odt ods odp odg fodt fods fodp sxw sxc sxi` | 主机端转成 HTML，在沙箱 iframe 里显示 |
| 其他二进制（38） | `exe dll so dylib bin obj wasm class pyc` `dmg iso msi deb rpm` `sqlite db pdb sys dmp` `ai eps ps icns cur crash pak dat` | 识别格式 + 文件头十六进制 |

一共 164 个扩展名。每个面板都有“下载”和“重新加载”。

## 播放器

音视频面板保留原来的完整功能：

- **右键菜单**（或点播放器下方的速度按钮）：速度档位 0.5×–4×、±0.1 微调，以及播放、快进退、逐帧（近似）、截图、循环、静音、画中画、全屏、从头播放。
- **快捷键**（先点一下播放器）：空格 播放/暂停；←/→ 5 秒，Ctrl+←/→ 30 秒；↑/↓ 音量；M 静音；`,`/`.` 逐帧（近似步进）；C/X 加减 0.1×，Z 恢复 1.0×；0–9 跳到 0%–90%；Home 从头；F 或 Enter 全屏；Ctrl+C 复制当前画面；Ctrl+S 保存 PNG；? 显示快捷键说明。
- **记住进度**：每个文件的播放位置存在浏览器里，下次打开自动接着放。离开头不到 5 秒或离结尾不到 10 秒时不记录。最多记 200 个文件。
- **记住速度和音量**：下次打开任何文件都沿用。
- **无法解码时明确提示**：浏览器不支持文件内部的编码（常见于 HEVC/H.265 的 mp4/mov，或 mkv 里的非常见编码）时，播放器照常打开，并给出说明和下载链接，不做转码。

## 压缩包

列出条目（最多 5000 条，可用筛选缩小范围），目录、大小、加密状态、修改时间都显示。点一个文本或图片条目，它会在原地面板里解压显示；二进制条目仍然可以下载整个压缩包。受 `LIMITS.entry`（16 MiB）限制，超大条目会提示改用下载。

## 组成

- **Host**（`lib/index.js`）：在 `/preview` 前缀下注册一组路由。
  - `GET|HEAD /preview/stream?sessionId=&path=` 音视频字节流，支持 HTTP Range（206/416），按 1 MiB 窗口发送，内存占用不随文件大小增长。
  - `GET /preview/info?sessionId=&path=` 文件分类与元数据 JSON：压缩包条目清单、字体信息、图像信息、渲染好的文档 HTML、二进制识别结果 + 十六进制头。
  - `GET /preview/entry?…&entry=` 一个压缩包条目，用于就地预览。
  - `GET /preview/raster` TIFF/PSD/RAW 解码后的 PNG。
  - `GET /preview/font` 字体文件本身，供 `@font-face` 使用。
  - `GET /preview/picture` AVIF/HEIC/JXL 原始容器，交给浏览器。
  - `GET /preview/download` 原始文件字节，带 attachment 文件名。
  - 认证沿用 GUI 自己路由的连接校验（`ctx.connection.requestRejection`）；文件一律经 `ctx.fs` 读取，沙箱读权限与 DSH 自带文档预览一致；相对路径按会话工作目录解析，`absolute` 作用域的地址按绝对路径解析。
  - 所有响应都带 `cache-control: private, no-store`、`nosniff` 和 `content-security-policy: sandbox; default-src 'none'`。
- **Client**（`lib/client.js`）：注册右侧边栏 tab 类型 `preview-all-in-one`，模式为 `dsh-resource://file/**/*.{…164 个扩展名…}`。它和 Better Sidebar 的 `dsh-resource://file/**` 同在 `extension` 档，模式更长，所以这些文件由本插件打开，其余文件照旧。文档面板里的 HTML 片段放在 `sandbox=""` 的 iframe 里，脚本无法执行。

## 安装

```sh
dsh plugin --profile desktop add github:Shichien/dsh-video-preview
```

`dsh plugin add` 只安装依赖，不会启用插件。还要在 profile 的 `package.json`（例如 `~/.dsh/profiles/desktop/package.json`）里，把 `"dsh-preview-all-in-one"` 加到 `dsh.profile.bundles` 列表里，然后刷新 DSH 页面。

本地开发时可以用 `link:` 安装源码目录，改完代码刷新页面即可生效：

```sh
dsh plugin --profile desktop add link:/path/to/dsh-video-preview
```

## 测试

```sh
npm test
```

`test/ranking.check.mjs` 用真实的 picomatch 规则验证 tab 类型排名（需要指向含 picomatch 的 `NODE_PATH`）：

```sh
$env:PICOMATCH_FROM='D:\DSHDesktop\DSH Desktop\resources\app\node_modules\picomatch\package.json'
node test/ranking.check.mjs
```

生成一个 8 秒的 H.264 测试视频，用于手动试播：

```sh
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440 -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart samples/test.mp4
```
