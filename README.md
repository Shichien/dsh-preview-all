# dsh-video-preview

在 DSH 右侧边栏预览视频文件。点击会话里的视频文件链接或文件树里的视频，侧边栏会打开一个可拖动进度条的 HTML5 播放器，不再显示“二进制文件，下载”面板。

支持的扩展名：`mp4` `m4v` `mov` `webm` `ogv` `mkv`。能否播放取决于 Chromium 是否支持文件内部的编码：H.264/AAC、VP8/VP9/AV1、Opus/Vorbis 都可以；HEVC/H.265 视多数机器的硬件解码支持而定，不支持时播放器会给出提示并提供下载。`avi`、`wmv`、`flv` 浏览器无法播放，不在支持列表里。

## 播放器功能

- **右键菜单**（或点播放器下方的速度按钮）：速度档位 0.5×–4×、±0.1 微调，以及播放、快进退、逐帧、截图、循环、静音、画中画、全屏、从头播放。
- **快捷键**（先点一下播放器）：空格 播放/暂停；←/→ 5 秒，Ctrl+←/→ 30 秒；↑/↓ 音量；M 静音；`,`/`.` 逐帧；C/X 加减 0.1×，Z 恢复 1.0×；0–9 跳到 0%–90%；Home 从头；F 或 Enter 全屏；Ctrl+C 复制当前画面；Ctrl+S 保存 PNG；? 显示快捷键说明。
- **记住进度**：每个文件的播放位置存在浏览器里，下次打开自动接着放。离开头不到 5 秒或离结尾不到 10 秒时不记录。最多记 200 个文件。
- **记住速度和音量**：下次打开任何视频都沿用。

## 组成

- **Host**（`lib/index.js`）：注册 `GET|HEAD /video-preview/stream?sessionId=&path=`。
  - 认证沿用 GUI 自己路由的连接校验（`ctx.connection.requestRejection`）。
  - 文件经 `ctx.fs` 读取，沙箱读权限与 DSH 自带文档预览一致；相对路径按会话工作目录解析。
  - 支持 HTTP Range（206/416），按 1 MiB 窗口流式发送，内存占用不随文件大小增长。
  - 只服务上面列出的视频扩展名，其他文件返回 415。
- **Client**（`lib/client.js`）：注册右侧边栏 tab 类型 `video-preview`，模式为 `dsh-resource://file/**/*.{mp4,…}`。它和 Better Sidebar 的 `dsh-resource://file/**` 同在 `extension` 档，模式更长，所以视频文件由本插件打开，其他文件照旧。

## 安装

```sh
dsh plugin --profile desktop add github:Shichien/dsh-video-preview
```

`dsh plugin add` 只安装依赖，不会启用插件。还要在 profile 的 `package.json`（例如 `~/.dsh/profiles/desktop/package.json`）里，把 `"dsh-video-preview"` 加到 `dsh.profile.bundles` 列表里，然后刷新 DSH 页面。

本地开发时可以用 `link:` 安装源码目录，改完代码刷新页面即可生效：

```sh
dsh plugin --profile desktop add link:/path/to/dsh-video-preview
```

## 测试

```sh
npm test
```

生成一个 8 秒的 H.264 测试视频，用于手动试播：

```sh
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440 -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart samples/test.mp4
```
