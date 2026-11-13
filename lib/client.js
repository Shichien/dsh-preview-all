// GENERATED FILE — edit the sources, then run npm run build.
// Entry bundle: no panel lives here; each one is a lazy chunk, client.<kind>.js.
window.__ModuleLoader__.load({
  id: "dsh-preview-all",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;
    // Source: lib/formats/catalog.js
    const FORMAT_DEFINITIONS = [
      {
        "kind": "media",
        "extensions": [
          "3g2",
          "3gp",
          "aac",
          "ac3",
          "aif",
          "aiff",
          "amr",
          "ape",
          "asf",
          "avi",
          "divx",
          "dts",
          "f4v",
          "flac",
          "flv",
          "m2ts",
          "m2v",
          "m4a",
          "m4b",
          "m4v",
          "mid",
          "midi",
          "mka",
          "mkv",
          "mov",
          "mp3",
          "mp4",
          "mpeg",
          "mpg",
          "mts",
          "oga",
          "ogg",
          "ogv",
          "opus",
          "rm",
          "rmvb",
          "ts",
          "vob",
          "wav",
          "weba",
          "webm",
          "wma",
          "wmv",
          "wv"
        ],
        "unclaimedExtensions": [
          "ts",
          "mts"
        ],
        "routes": {
          "stream": "serve"
        },
        "ownChrome": true
      },
      {
        "kind": "archive",
        "extensions": [
          "7z",
          "apk",
          "blend1",
          "bz2",
          "cab",
          "cbr",
          "cbz",
          "crx",
          "docm",
          "dotm",
          "dotx",
          "dps",
          "ear",
          "epub",
          "et",
          "fig",
          "gz",
          "ipa",
          "jar",
          "kra",
          "lz",
          "lzma",
          "nupkg",
          "odc",
          "ora",
          "otf2",
          "potm",
          "potx",
          "ppsm",
          "ppsx",
          "pptm",
          "rar",
          "sketch",
          "tar",
          "tbz",
          "tbz2",
          "tgz",
          "txz",
          "vsix",
          "war",
          "whl",
          "wps",
          "xd",
          "xlsm",
          "xltm",
          "xltx",
          "xpi",
          "xz",
          "z",
          "zip",
          "zst"
        ],
        "compoundExtensions": [
          "tar.gz",
          "tar.bz2",
          "tar.xz",
          "tar.zst",
          "tar.lz"
        ],
        "routes": {
          "entry": "serveEntry"
        },
        "buffersWholeFile": true
      },
      {
        "kind": "font",
        "extensions": [
          "eot",
          "otf",
          "pfb",
          "ttc",
          "ttf",
          "woff",
          "woff2"
        ],
        "routes": {
          "font": "serve"
        },
        "buffersWholeFile": true
      },
      {
        "kind": "raster",
        "extensions": [
          "arw",
          "cr2",
          "dng",
          "nef",
          "orf",
          "psb",
          "psd",
          "rw2",
          "tif",
          "tiff"
        ],
        "routes": {
          "raster": "serve"
        },
        "buffersWholeFile": true
      },
      {
        "kind": "picture",
        "extensions": [
          "avif",
          "heic",
          "heif",
          "hif",
          "jxl"
        ],
        "routes": {
          "picture": "serve"
        }
      },
      {
        "kind": "document",
        "extensions": [
          "fodp",
          "fods",
          "fodt",
          "odg",
          "odp",
          "ods",
          "odt",
          "rtf",
          "sxc",
          "sxi",
          "sxw"
        ],
        "routes": {},
        "buffersWholeFile": true
      },
      {
        "kind": "binary",
        "extensions": [
          "a",
          "ai",
          "bin",
          "class",
          "com",
          "cpl",
          "crash",
          "cur",
          "dat",
          "db",
          "deb",
          "dll",
          "dmg",
          "dmp",
          "dylib",
          "efi",
          "eps",
          "exe",
          "icns",
          "img",
          "iso",
          "lib",
          "msi",
          "o",
          "obj",
          "ocx",
          "pak",
          "pdb",
          "ps",
          "pyc",
          "pyo",
          "rpm",
          "scr",
          "so",
          "sqlite",
          "sqlite3",
          "sys",
          "wasm"
        ],
        "routes": {}
      }
    ];

    // Source: lib/client/10-constants.js
    const ID = "dsh-preview-all";
    const KIND = "preview-all";
    const NS = "dsh-preview-all";
    const FILE_PREFIX = "dsh-resource://file/";

    // Source: lib/client/11-routes.js
    /** Reserved routes plus format routes from the serialized catalog. */
    const ROUTES = Object.fromEntries(
      ['info', 'download', ...FORMAT_DEFINITIONS.flatMap(({ routes }) => Object.keys(routes))]
        .map(route => [route, 'preview/' + route]),
    );

    // Source: lib/client/20-locale-zh.js
    const zh = {
      reload: "重新加载",
      download: "下载",
      loading: "正在读取文件…",
      failed: "读取失败",
      notFound: "找不到这个文件，它可能已被移动或删除。",
      forbidden: "没有读取这个文件的权限（可能被沙箱策略拒绝）。",
      unauthorized: "登录状态已失效，请刷新页面后重试。",
      network: "无法连接到 DSH 主机。",
      panelFailed: "预览组件加载失败，请重新加载。",
      documentTruncated: "文档很长，这里只显示开头部分。完整内容请下载后查看。",
      noSession: "这个文件不属于任何会话，无法预览。",
      tooLarge: "文件太大，无法完整解析。",
      unsupported: "浏览器无法解码这个文件的编码（常见于 HEVC/H.265 的 mp4/mov，或 mkv 里的非常见编码）。可以下载后用本地播放器打开。",
      decode: "解码出错，文件可能已损坏或编码不受支持。",
      aborted: "加载被中断。",
      speed: "速度",
      menuSpeed: "播放速度",
      play: "播放",
      playFailed: "无法播放",
      pause: "暂停",
      playPause: "播放 / 暂停",
      back5: "后退 5 秒",
      fwd5: "前进 5 秒",
      prevFrame: "上一帧",
      nextFrame: "下一帧",
      copyFrame: "复制当前帧",
      saveFrame: "保存当前帧",
      screenshot: "截图",
      loop: "循环播放",
      loopOn: "循环开启",
      loopOff: "循环关闭",
      mute: "静音",
      muted: "已静音",
      unmuted: "已取消静音",
      volume: "音量",
      pip: "画中画",
      pipFailed: "无法进入画中画",
      fullscreen: "全屏",
      exitFullscreen: "退出全屏",
      fullscreenFailed: "无法进入全屏",
      restart: "从头播放",
      shortcuts: "快捷键",
      seconds: "秒",
      shotCopied: "已复制当前帧",
      shotSaved: "已保存当前帧",
      shotSavedInstead: "剪贴板不可用，已改为保存文件",
      shotFailed: "无法截取当前帧",
      shotBlocked: "浏览器阻止了跨源画面截取",
      resumedFrom: "已从上次位置继续：",
      helpSeek: "前进 / 后退 5 秒",
      helpSeekLarge: "前进 / 后退 30 秒",
      helpVolume: "音量增减",
      helpFrame: "逐帧前进 / 后退",
      helpRate: "播放速度加减",
      helpRateReset: "恢复正常速度",
      helpPercent: "跳到 0% – 90%",
      helpHelp: "显示本帮助",
      helpMenu: "在画面上右键可打开播放速度菜单。",
      helpFocus: "快捷键在播放器获得焦点时生效，点击画面即可。",
      close: "关闭",
      archiveCount: "共 {count} 项",
      archiveShown: "仅显示前 {count} 项，请用筛选缩小范围。",
      archiveFilter: "筛选条目",
      archiveNone: "没有匹配的条目。",
      archivePick: "点选一个条目即可在这里预览文本或图片。",
      archiveBack: "返回列表",
      archiveEncrypted: "已加密",
      archiveText: "文本",
      archiveImage: "图片",
      archiveEntryFailed: "无法读取这个条目",
      fontSpecimen: "字体样张",
      fontSample: "永远相信美好的事情即将发生",
      fontUnsupported: "浏览器无法渲染这种字体格式，下面是文件里的信息。",
      fontLoading: "字体加载中…",
      fontLoaded: "字体已加载",
      fontMissing: "字体无法加载，样张使用替代字体显示。",
      fontFamily: "字体名称",
      fontSubfamily: "字重 / 样式",
      fontFullName: "全名",
      fontFormat: "格式",
      fontGlyphs: "字形数",
      fontUnits: "em 单位",
      fontVersion: "版本",
      fontDesigner: "设计者",
      fontLicense: "许可",
      fontCopyright: "版权",
      fontInfo: "字体信息",
      rasterDetails: "图像信息",
      rasterFailed: "无法解码这张图像，可以下载后用其他软件打开。",
      pictureFailed: "浏览器无法显示这种图片格式，可以下载后用其他软件打开。",
      binaryInfo: "文件信息",
      binarySize: "大小",
      binaryHex: "文件头",
      binaryUnviewable: "这个文件没有可用的预览，下面是识别到的格式和文件头。",
      entryLoading: "正在解压…",
    };

    // Source: lib/client/21-locale-en.js
    const en = {
      reload: "Reload",
      download: "Download",
      loading: "Reading file…",
      failed: "Could not read the file",
      notFound: "This file is gone — it may have been moved or deleted.",
      forbidden: "No permission to read this file (the sandbox policy may deny it).",
      unauthorized: "Your session expired. Refresh the page and try again.",
      network: "Cannot reach the DSH host.",
      panelFailed: "The preview panel could not be loaded. Reload to try again.",
      documentTruncated: "This document is long; only its beginning is shown. Download it to read the rest.",
      noSession: "This file belongs to no session, so it cannot be previewed.",
      tooLarge: "The file is too large to parse completely.",
      unsupported: "The browser cannot decode this file (common for HEVC/H.265 in mp4/mov, or uncommon codecs inside mkv). Download it and open it in a local player.",
      decode: "Decoding failed — the file may be damaged or use an unsupported codec.",
      aborted: "Loading was interrupted.",
      speed: "Speed",
      menuSpeed: "Playback speed",
      play: "Play",
      playFailed: "Cannot play",
      pause: "Paused",
      playPause: "Play / pause",
      back5: "Back 5 seconds",
      fwd5: "Forward 5 seconds",
      prevFrame: "Previous frame",
      nextFrame: "Next frame",
      copyFrame: "Copy current frame",
      saveFrame: "Save current frame",
      screenshot: "Screenshot",
      loop: "Loop",
      loopOn: "Loop on",
      loopOff: "Loop off",
      mute: "Mute",
      muted: "Muted",
      unmuted: "Unmuted",
      volume: "Volume",
      pip: "Picture in picture",
      pipFailed: "Picture in picture is unavailable",
      fullscreen: "Fullscreen",
      exitFullscreen: "Exit fullscreen",
      fullscreenFailed: "Fullscreen is unavailable",
      restart: "Restart",
      shortcuts: "Shortcuts",
      seconds: "s",
      shotCopied: "Frame copied",
      shotSaved: "Frame saved",
      shotSavedInstead: "Clipboard unavailable — saved the file instead",
      shotFailed: "Could not capture the frame",
      shotBlocked: "The browser blocked capturing a cross-origin frame",
      resumedFrom: "Resumed from ",
      helpSeek: "Seek 5 seconds",
      helpSeekLarge: "Seek 30 seconds",
      helpVolume: "Volume up / down",
      helpFrame: "Step one frame",
      helpRate: "Faster / slower",
      helpRateReset: "Normal speed",
      helpPercent: "Jump to 0% – 90%",
      helpHelp: "Show this help",
      helpMenu: "Right-click the picture for the speed menu.",
      helpFocus: "Shortcuts work while the player has focus — click the picture.",
      close: "Close",
      archiveCount: "{count} entries",
      archiveShown: "Showing the first {count} entries — narrow the filter to see more.",
      archiveFilter: "Filter entries",
      archiveNone: "No matching entry.",
      archivePick: "Pick an entry to preview its text or image here.",
      archiveBack: "Back to the list",
      archiveEncrypted: "Encrypted",
      archiveText: "Text",
      archiveImage: "Image",
      archiveEntryFailed: "Could not read this entry",
      fontSample: "The quick brown fox jumps over the lazy dog",
      fontSpecimen: "Font specimen",
      fontUnsupported: "The browser cannot render this font format; the file's own metadata is below.",
      fontLoading: "Loading the font…",
      fontLoaded: "Font loaded",
      fontMissing: "The font did not load; the specimen falls back to another face.",
      fontFamily: "Family",
      fontSubfamily: "Style",
      fontFullName: "Full name",
      fontFormat: "Format",
      fontGlyphs: "Glyphs",
      fontUnits: "Units per em",
      fontVersion: "Version",
      fontDesigner: "Designer",
      fontLicense: "License",
      fontCopyright: "Copyright",
      fontInfo: "Font information",
      rasterDetails: "Image information",
      rasterFailed: "This image could not be decoded — download it and open it elsewhere.",
      pictureFailed: "The browser cannot display this image format — download it and open it elsewhere.",
      binaryInfo: "File information",
      binarySize: "Size",
      binaryHex: "File header",
      binaryUnviewable: "There is no preview for this file; its detected format and header follow.",
      entryLoading: "Extracting…",
    };

    // ---- addresses and URLs -------------------------------------------------

    /**
     * Read `dsh-resource://file/<scope>/…` back into its parts. Both the
     * `session` and the `absolute` scope are accepted: a file opened from
     * outside a workspace has no session to read through.
     * @param {string} address
     * @returns {{scope: string, sessionId?: string, path: string} | undefined}
     */

    // Source: lib/client/30-helpers.js
    function fileOf(address) {
      try {
        if (typeof address !== "string" || !address.startsWith(FILE_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const parts = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end).split("/");
        const scope = parts[0];
        if (scope === "session") {
          const id = parts[1];
          const segments = parts.slice(2);
          if (id === undefined || id === "" || segments.length === 0) return undefined;
          const path = segments.map(decodeURIComponent).join("/");
          if (path === "") return undefined;
          return { scope: "session", sessionId: decodeURIComponent(id), path };
        }
        if (scope === "absolute") {
          const tail = parts.slice(1);
          const unc = tail[0] === "" && tail.length > 1;
          const segments = (unc ? tail.slice(1) : tail).map(decodeURIComponent);
          if (segments.length === 0 || segments[0] === "") return undefined;
          if (unc) return { scope: "absolute", path: `//${segments.join("/")}` };
          const path = /^[A-Za-z]:$/.test(segments[0]) ? segments.join("/") : `/${segments.join("/")}`;
          return { scope: "absolute", path };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    /** Whether the path ends in a suffix this plugin claims. */
    function hasSuffix(path) {
      const name = String(path).replaceAll("\\", "/");
      const base = name.slice(name.lastIndexOf("/") + 1);
      const dot = base.lastIndexOf(".");
      if (dot <= 0) return false;
      return EXTENSION_SET.has(base.slice(dot + 1).toLowerCase());
    }

    function basenameOfPath(path) {
      return path.slice(path.lastIndexOf("/") + 1) || path;
    }

    function basenameOf(address) {
      const file = fileOf(address);
      return file === undefined ? String(address) : basenameOfPath(file.path);
    }

    function stemOf(name) {
      const dot = name.lastIndexOf(".");
      return dot > 0 ? name.slice(0, dot) : name;
    }

    /** Directory base for a route, keeping any reverse-proxy prefix. */
    function directoryBase(base) {
      const url = new URL(base);
      url.search = "";
      url.hash = "";
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      return url.href;
    }

    /**
     * Base the preview routes resolve against. In a browser the page base is the
     * Host itself; in the desktop shell `dsh-app://app/` forwards to the Host.
     * Staying same-origin keeps the login cookie and an untainted canvas for
     * screenshots.
     */
    function pageBase() {
      return typeof document !== "undefined" && document.baseURI ? directoryBase(document.baseURI) : undefined;
    }

    /**
     * Build one preview URL. `sessionId` is only sent for session-scoped
     * addresses; an absolute one must stand on its own.
     */
    function previewUrl(base, route, file, extra) {
      const url = new URL(ROUTES[route], base);
      if (file.sessionId !== undefined) url.searchParams.set("sessionId", file.sessionId);
      url.searchParams.set("path", file.path);
      for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value);
      return url.href;
    }

    function messageForStatus(status, t) {
      if (status === 401) return t("unauthorized");
      if (status === 403) return t("forbidden");
      if (status === 404) return t("notFound");
      if (status === 413) return t("tooLarge");
      return `${t("failed")} (HTTP ${status})`;
    }

    // Source: lib/client/31-numbers.js
    /** Human-readable byte count, for archive entries and details. */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return "";
      if (bytes < 1024) return `${bytes} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let value = bytes / 1024;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
    }

    // Source: lib/client/34-document-html.js
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
    }

    /** A standalone document around the Host's HTML fragment, for `srcDoc`. */
    const DOCUMENT_CSS = `:root{color-scheme:light dark}
    body{margin:0;padding:16px 18px;font:14px/1.7 -apple-system,"Segoe UI",system-ui,"Noto Sans CJK SC",sans-serif;color:#1c1c1e;background:#fff;overflow-wrap:break-word}
    @media (prefers-color-scheme:dark){body{color:#e9e9ec;background:#1b1b1d}}
    h1,h2,h3,h4{line-height:1.3;margin:1.1em 0 .5em}
    h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.15em}
    p{margin:.6em 0}
    a{color:#2f7de1}
    table{border-collapse:collapse;margin:.6em 0;max-width:100%}
    td,th{border:1px solid rgba(128,128,128,.35);padding:4px 8px;vertical-align:top}
    img{max-width:100%;height:auto}
    pre{overflow:auto;padding:8px 10px;border-radius:6px;background:rgba(128,128,128,.15);font-size:12px}
    blockquote{margin:.6em 0;padding:.1em 0 .1em 12px;border-left:3px solid rgba(128,128,128,.4);opacity:.9}
    ul,ol{padding-left:1.4em}`;

    function documentHtml(body, title) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8">`
        + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`
        + `<title>${escapeHtml(title)}</title><style>${DOCUMENT_CSS}</style></head>`
        + `<body>${body ?? ""}</body></html>`;
    }

    // ---- styles -------------------------------------------------------------

    // Source: lib/client/35-css.js
    const CSS = `
    .dpa-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;font-size:13px;color:inherit}
    .dpa-bar{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;padding:7px 12px;border-bottom:1px solid rgba(128,128,128,.22)}
    .dpa-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
    .dpa-size{opacity:.6;font-variant-numeric:tabular-nums;font-size:12px}
    .dpa-grow{flex:1 1 auto}
    .dpa-link{background:none;border:none;padding:0;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;opacity:.85}
    .dpa-link:hover{opacity:1}
    .dpa-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;box-sizing:border-box}
    .dpa-notice{margin:0 0 10px;padding:8px 10px;border-radius:6px;background:rgba(214,158,46,.14);border:1px solid rgba(214,158,46,.42);line-height:1.6}
    .dpa-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;box-sizing:border-box;text-align:center;line-height:1.65;opacity:.85}
    .dpa-button{padding:4px 12px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:rgba(128,128,128,.12);color:inherit;font:inherit;font-size:12px;cursor:pointer}
    .dpa-button:hover{background:rgba(128,128,128,.22)}
    .dpa-list{display:flex;flex-direction:column}
    .dpa-row{display:flex;gap:8px;align-items:baseline;width:100%;padding:4px 6px;border:none;border-radius:4px;background:none;color:inherit;font:inherit;text-align:left;cursor:default}
    .dpa-row[data-open]{cursor:pointer}
    .dpa-row[data-open]:hover{background:rgba(128,128,128,.16)}
    .dpa-row-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
    .dpa-row-size{flex:0 0 auto;opacity:.55;font-variant-numeric:tabular-nums;font-size:11.5px}
    .dpa-tag{flex:0 0 auto;font-size:10.5px;padding:0 5px;border-radius:4px;background:rgba(128,128,128,.2);opacity:.85}
    .dpa-filter{width:100%;box-sizing:border-box;margin:0 0 8px;padding:5px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:inherit;font-size:12.5px}
    .dpa-pre{margin:0;padding:10px;border-radius:6px;background:rgba(128,128,128,.12);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5;overflow:auto;white-space:pre}
    .dpa-text{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
    .dpa-image{display:block;max-width:100%;height:auto;margin:0 auto 10px}
    .dpa-frame{display:block;width:100%;height:100%;border:none;background:transparent}
    .dpa-frame-wrap{flex:1 1 auto;min-height:0}
    .dpa-dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 12px;margin:0 0 10px;font-size:12.5px;align-items:baseline}
    .dpa-dl dt{opacity:.6;white-space:nowrap}
    .dpa-dl dd{margin:0;overflow-wrap:anywhere}
    .dpa-section{margin:14px 0 6px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;opacity:.55}
    .dpa-specimen{padding:12px 14px;margin-bottom:10px;border-radius:8px;border:1px solid rgba(128,128,128,.25)}
    .dpa-specimen p{margin:0 0 10px;line-height:1.28;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dpa-specimen p:last-child{margin-bottom:0}
    .dpa-empty{padding:16px 4px;text-align:center;opacity:.6;line-height:1.6}
    .dpa-summary{margin:0 0 10px;font-weight:600}
    .dpa-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:8px}
    .dpa-sub{opacity:.6;font-size:12px}
    `;

    // Source: lib/client/40-ui.js
    // ---- shared panel pieces ------------------------------------------------

    function statusPanel(text, action) {
      return h("div", { className: "dpa-status" },
        h("p", { style: { margin: 0 } }, text),
        action ?? null);
    }

    function detailList(rows) {
      const shown = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
      if (shown.length === 0) return null;
      return h("dl", { className: "dpa-dl" },
        ...shown.flatMap(([label, value]) => [
          h("dt", { key: `t-${label}` }, label),
          h("dd", { key: `d-${label}` }, String(value)),
        ]));
    }

    function headerBar(info, file, base, t, onReload) {
      return h("div", { className: "dpa-bar" },
        h("span", { className: "dpa-name", title: info.path ?? info.name }, info.name ?? ""),
        info.sizeLabel === undefined ? null : h("span", { className: "dpa-size" }, info.sizeLabel),
        h("span", { className: "dpa-grow" }),
        h("button", { type: "button", className: "dpa-link", onClick: onReload }, t("reload")),
        h("a", { className: "dpa-link", href: previewUrl(base, "download", file), download: info.name ?? "" }, t("download")));
    }

    // Source: lib/client/image.js
    const ImageBody = (function createImageBody({ React, previewUrl, detailList }) {
      const { createElement: h, useState } = React;

      // ---- images -------------------------------------------------------------

      function ImageBody({ file, base, info, t, route, failureKey, detailsKey }) {
        const [failed, setFailed] = useState(false);
        const details = info[detailsKey]?.details ?? [];
        return h("div", { className: "dpa-body" },
          failed
            ? h("p", { className: "dpa-notice" }, t(failureKey))
            : h("img", {
              className: "dpa-image",
              src: previewUrl(base, route, file),
              alt: info.name ?? "",
              onError: () => setFailed(true),
            }),
          info[detailsKey]?.format === undefined ? null : h("div", { className: "dpa-section" }, t("rasterDetails")),
          detailList([[t("fontFormat"), info[detailsKey]?.format], ...details]));
      }

      return ImageBody;
    })({ React, previewUrl, detailList });

    // What every panel factory receives. A chunk adds its own `runtime`.
    const services = { React, previewUrl, messageForStatus, statusPanel, detailList, formatSize, documentHtml, ImageBody, basenameOfPath, stemOf };

    // Source: lib/client/45-registry.js
    /** Sidebar suffixes are derived from the same format catalog the Host classifies with. */
    const EXTENSIONS = [...new Set(FORMAT_DEFINITIONS.flatMap(({ extensions, unclaimedExtensions = [] }) =>
      extensions.filter(extension => !unclaimedExtensions.includes(extension))))].sort();
    const EXTENSION_SET = new Set(EXTENSIONS);
    const PATTERNS = [`dsh-resource://file/**/*.{${EXTENSIONS.join(',')}}`];

    const KINDS = new Set(FORMAT_DEFINITIONS.map(({ kind }) => kind));
    /** Kinds whose panel draws its own header instead of the shared name/size/download bar. */
    const OWN_CHROME = new Set(FORMAT_DEFINITIONS.filter(({ ownChrome }) => ownChrome === true).map(({ kind }) => kind));
    const KIND_BY_EXTENSION = new Map(FORMAT_DEFINITIONS.flatMap(({ kind, extensions }) =>
      extensions.map(extension => [extension, kind])));

    /**
     * The kind a path's suffix implies. Only a hint for which panel to start
     * fetching: the Host has the final say and may answer with another kind.
     */
    function kindHint(path) {
      const dot = String(path).lastIndexOf(".");
      return dot === -1 ? undefined : KIND_BY_EXTENSION.get(String(path).slice(dot + 1).toLowerCase());
    }

    // Source: lib/client/legacy-tabs.js
    function migrateLegacyTabs(storage, newKind = 'preview-all') {
      // This is a private sidebar persistence format, not its public tabs API.
      // Only the exact v1 prefix/layout below is understood; future versions must
      // be reviewed explicitly rather than swept into this migration.
      const prefix = 'dsh.sidebar-right.v1.';
      // Kinds this plugin registered before it was renamed; `newKind` is the current one.
      const legacyKinds = ['video-preview', 'preview-all-in-one'];
      // No completion marker: scan each initialization, writing only changed records.
      // Ignore (and preserve) the old dsh-video-preview:tabs-migrated marker so failed
      // writes and legacy records restored after a successful run remain retryable.
      try {
        const length = storage.length;
        for (let index = 0; index < length; index += 1) {
          try {
            const key = storage.key(index);
            if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
            const state = JSON.parse(storage.getItem(key));
            let changed = false;
            for (const session of Object.values(state?.bySession ?? {})) {
              for (const tab of Object.values(session?.layout?.tabs ?? {})) {
                if (legacyKinds.includes(tab?.kind) && tab.kind !== newKind) {
                  tab.kind = newKind;
                  changed = true;
                }
              }
            }
            if (changed) storage.setItem(key, JSON.stringify(state));
          } catch {
            // A malformed/denied record must not block the other sessions. Leave its
            // stored value intact and retry on the next initialization.
          }
        }
      } catch {
        // Storage itself (including length access) may be unavailable or restricted.
      }
    }

    // Source: lib/client/46-panels.js
    // ---- panels, loaded on demand ---------------------------------------------
    //
    // The entry bundle carries no panel. Each format's panel, with its private
    // runtime and styles, is its own chunk `client.<kind>.js`, fetched the first
    // time a file of that kind is opened and kept for the lifetime of the page.

    /** kind → Promise of its panel component. */
    const panelLoads = new Map();
    /** Styles that arrived with chunks; `apply` puts them in the plugin's stylesheet. */
    const chunkStyles = [];
    /** The live stylesheet element while the plugin is applied. */
    let styleElement;

    /**
     * Load one kind's panel. An unknown kind gets the binary panel. A failed load
     * is forgotten, so the tab's reload button retries it.
     */
    function loadPanel(kind) {
      const name = KINDS.has(kind) ? kind : "binary";
      let pending = panelLoads.get(name);
      if (pending === undefined) {
        pending = Promise.resolve()
          .then(() => require.async(`./client.${name}.js`))
          .then((chunk) => {
            if (typeof chunk.css === "string" && chunk.css !== "") {
              chunkStyles.push(chunk.css);
              if (styleElement !== undefined) styleElement.textContent += chunk.css;
            }
            return chunk.createPanel(services);
          });
        pending.catch(() => {
          if (panelLoads.get(name) === pending) panelLoads.delete(name);
        });
        panelLoads.set(name, pending);
      }
      return pending;
    }

    // Source: lib/client/50-body.js
    function PreviewBody(props) {
      const { useTabInfo, t } = props;
      const { tab } = useTabInfo();
      const address = tab.contentId ?? tab.navigation?.address;
      const file = useMemo(() => fileOf(address), [address]);
      const base = useMemo(pageBase, []);
      const [state, setState] = useState({ status: "loading" });
      const [generation, setGeneration] = useState(0);
      const tRef = useRef(t);
      tRef.current = t;

      const reload = useCallback(() => setGeneration((value) => value + 1), []);

      useEffect(() => {
        const bind = tab.actions?.bindCommands;
        if (typeof bind !== "function") return undefined;
        return bind.call(tab.actions, { refresh: reload });
      }, [tab.actions, reload]);

      useEffect(() => {
        if (file === undefined || base === undefined) return undefined;
        const controller = new AbortController();
        const signal = tab.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, tab.signal]);
        let live = true;
        setState({ status: "loading" });
        // Fetch the panel the suffix implies while the Host classifies the file,
        // so loading it on demand adds no wait of its own.
        const hint = kindHint(file.path);
        if (hint !== undefined) loadPanel(hint).catch(() => {});
        fetch(previewUrl(base, "info", file), { credentials: "same-origin", signal })
          .then(async (response) => {
            if (!response.ok) throw Object.assign(new Error("status"), { status: response.status });
            return response.json();
          })
          .then(async (info) => {
            let Body;
            try {
              Body = await loadPanel(info.kind);
            } catch (cause) {
              throw Object.assign(new Error("panel"), { panel: true, cause });
            }
            if (live && !signal.aborted) setState({ status: "ready", info, Body });
          })
          .catch((error) => {
            if (!live || signal.aborted) return;
            const status = error?.status;
            const message = error?.panel === true ? tRef.current("panelFailed")
              : status === undefined ? tRef.current("network")
              : messageForStatus(status, tRef.current);
            setState({ status: "error", message });
          });
        return () => {
          live = false;
          controller.abort();
        };
      }, [file, base, generation, tab.signal]);

      if (file === undefined) {
        return h("div", { className: "dpa-root" }, statusPanel(t("noSession")));
      }
      if (state.status === "loading") {
        return h("div", { className: "dpa-root" }, statusPanel(t("loading")));
      }
      if (state.status === "error") {
        return h("div", { className: "dpa-root" },
          statusPanel(state.message, h("button", { type: "button", className: "dpa-button", onClick: reload }, t("reload"))));
      }

      const info = state.info ?? {};
      const { Body } = state;
      if (OWN_CHROME.has(info.kind)) {
        return h(Body, { tab, file, base, info, t });
      }
      return h("div", { className: "dpa-root" },
        headerBar(info, file, base, t, reload),
        h(Body, { tab, file, base, info, t }));
    }

    // Source: lib/client/60-apply.js
    const inject = ["slots", "locale", "sidebarRightTabs"];

    function apply(ctx) {
      try {
        migrateLegacyTabs(globalThis.localStorage);
      } catch {
        // Accessing localStorage itself can throw; tab registration must still run.
      }
      const t = ctx.locale.bind(NS);
      ctx.effect(() => {
        // One stylesheet for every preview tab, removed when the plugin unloads.
        // It starts with the shared rules; each panel chunk appends its own.
        const style = document.createElement("style");
        style.dataset.dshPreviewAll = "";
        style.textContent = CSS + chunkStyles.join("");
        document.head.appendChild(style);
        styleElement = style;
        return () => {
          style.remove();
          if (styleElement === style) styleElement = undefined;
        };
      }, ID + ": styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": dictionaries");
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        patterns: PATTERNS,
        priority: "extension",
        canOpen: (address) => {
          const file = fileOf(address);
          return file !== undefined && hasSuffix(file.path);
        },
        title: basenameOf,
        keepMounted: true,
      }), ID + ": tab type");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: ID,
        locale: NS,
        inject: () => ({ t }),
      }, PreviewBody)), ID + ": tab body");
    }

    // Source: lib/client/70-api.js
    return {
      inject,
      apply,
      fileOf,
      hasSuffix,
      basenameOf,
      previewUrl,
      messageForStatus,
      documentHtml,
      formatSize,
      kindHint,
      loadPanel,
      EXTENSIONS,
      PATTERNS,
      ROUTES,
    };
  },
});
