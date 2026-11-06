// Client half of dsh-preview-all-in-one. Hand-written for the DSH module loader
// (no build step): `require` hands out the shared React instance.
//
// Registers one right-Sidebar tab type that claims every suffix DSH's builtin
// document preview leaves to its "binary file, download" empty state. Its glob
// is far longer than Better Sidebar's catch-all `dsh-resource://file/**`, and
// both sit in the `extension` band, so the tab registry ranks this type first;
// DSH's own document preview (`fallback` band) ranks below both.
//
// The tab body asks the Host's `/preview/info` what the file is, then renders
// the matching panel: a media player, an archive listing with in-place entry
// preview, a font specimen, a decoded raster image, a picture container, a
// document rendered to HTML, or a binary info panel with a hex dump. Every
// panel can download the original file.
//
// The player keeps the feature set the video-only plugin had: a right-click
// menu with fine speed control, keyboard shortcuts while the player has focus,
// per-file resume position, and copying or saving the current frame.
window.__ModuleLoader__.load({
  id: "dsh-preview-all-in-one",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    const ID = "dsh-preview-all-in-one";
    const KIND = "preview-all-in-one";
    const NS = "dsh-preview-all-in-one";
    const FILE_PREFIX = "dsh-resource://file/";

    /**
     * Every suffix this plugin claims: the Host's classification list minus the
     * suffixes a builtin renderer already owns (markdown, HTML, images, PDF,
     * Office, spreadsheets, source code). Claiming those would shadow a better
     * preview.
     */
    const EXTENSIONS = [
      // media
      "3g2", "3gp", "aac", "ac3", "aif", "aiff", "amr", "ape", "asf", "avi", "divx", "dts", "f4v",
      "flac", "flv", "m2ts", "m2v", "m4a", "m4b", "m4v", "mid", "midi", "mka", "mkv", "mov", "mp3",
      "mp4", "mpeg", "mpg", "oga", "ogg", "ogv", "opus", "rm", "rmvb", "vob", "wav", "weba", "webm",
      "wma", "wmv", "wv",
      // archives and ZIP-shaped containers
      "7z", "apk", "blend1", "bz2", "cab", "cbr", "cbz", "crx", "docm", "dotm", "dotx", "dps", "ear",
      "epub", "et", "fig", "gz", "ipa", "jar", "kra", "lz", "lzma", "nupkg", "odc", "ora", "otf2",
      "potm", "potx", "ppsm", "ppsx", "pptm", "rar", "sketch", "tar", "tbz", "tbz2", "tgz", "txz",
      "vsix", "war", "whl", "wps", "xd", "xlsm", "xltm", "xltx", "xpi", "xz", "z", "zip", "zst",
      // opaque binaries
      "a", "ai", "bin", "class", "com", "cpl", "crash", "cur", "dat", "db", "deb", "dll", "dmg", "dmp",
      "dylib", "efi", "eps", "exe", "icns", "img", "iso", "lib", "msi", "o", "obj", "ocx", "pak",
      "pdb", "ps", "pyc", "pyo", "rpm", "scr", "so", "sqlite", "sqlite3", "sys", "wasm",
      // rasters the Host decodes
      "arw", "cr2", "dng", "nef", "orf", "psb", "psd", "rw2", "tif", "tiff",
      // pictures the browser may decode itself
      "avif", "heic", "heif", "hif", "jxl",
      // fonts
      "eot", "otf", "pfb", "ttc", "ttf", "woff", "woff2",
      // documents the Host renders
      "fodp", "fods", "fodt", "odg", "odp", "ods", "odt", "rtf", "sxc", "sxi", "sxw",
    ];
    const PATTERNS = [`dsh-resource://file/**/*.{${EXTENSIONS.join(",")}}`];
    const EXTENSION_SET = new Set(EXTENSIONS);

    const ROUTES = {
      stream: "preview/stream",
      info: "preview/info",
      entry: "preview/entry",
      raster: "preview/raster",
      font: "preview/font",
      picture: "preview/picture",
      download: "preview/download",
    };

    const RATE_MIN = 0.1;
    const RATE_MAX = 4;
    const RATE_STEP = 0.1;
    const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const SEEK_SMALL = 5;
    const SEEK_LARGE = 30;
    const VOLUME_STEP = 0.05;
    const STORE_PREFS = "dsh-preview-all-in-one:prefs";
    const STORE_POSITIONS = "dsh-preview-all-in-one:positions";
    const MAX_POSITIONS = 200;
    /** Positions closer than this to the start are not worth resuming. */
    const RESUME_MIN = 5;
    /** Positions closer than this to the end count as finished. */
    const RESUME_TAIL = 10;
    /** Seconds of playback between position saves. */
    const SAVE_EVERY = 5;
    /** Rows the archive list renders before it asks for a filter. */
    const MAX_ROWS = 2000;

    const zh = {
      reload: "重新加载",
      download: "下载",
      loading: "正在读取文件…",
      failed: "读取失败",
      notFound: "找不到这个文件，它可能已被移动或删除。",
      forbidden: "没有读取这个文件的权限（可能被沙箱策略拒绝）。",
      unauthorized: "登录状态已失效，请刷新页面后重试。",
      network: "无法连接到 DSH 主机。",
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

    const en = {
      reload: "Reload",
      download: "Download",
      loading: "Reading file…",
      failed: "Could not read the file",
      notFound: "This file is gone — it may have been moved or deleted.",
      forbidden: "No permission to read this file (the sandbox policy may deny it).",
      unauthorized: "Your session expired. Refresh the page and try again.",
      network: "Cannot reach the DSH host.",
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

    // ---- pure helpers (exported for tests) ----------------------------------

    function clampRate(value) {
      if (!Number.isFinite(value)) return 1;
      return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(value * 100) / 100));
    }

    /** `1` → `1.0×`, `1.5` → `1.5×`, `1.25` → `1.25×`. */
    function formatRate(rate) {
      return `${rate.toFixed(2).replace(/0$/, "")}×`;
    }

    /** `m:ss` or `h:mm:ss`; `precise` appends milliseconds. */
    function formatTime(seconds, precise) {
      if (!Number.isFinite(seconds)) return "--:--";
      const total = Math.max(0, seconds);
      const whole = Math.floor(total);
      const two = (n) => String(n).padStart(2, "0");
      const hours = Math.floor(whole / 3600);
      const minutes = Math.floor((whole % 3600) / 60);
      const text = hours > 0 ? `${hours}:${two(minutes)}:${two(whole % 60)}` : `${minutes}:${two(whole % 60)}`;
      if (!precise) return text;
      return `${text}.${String(Math.floor((total - whole) * 1000)).padStart(3, "0")}`;
    }

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

    /** Resume-position key: absolute paths are shared across sessions; relative ones are per session. */
    function positionKey(file) {
      const path = file.path;
      if (/^[A-Za-z]:\//.test(path)) return `abs:${path.toLowerCase()}`;
      if (path.startsWith("/")) return `abs:${path}`;
      return `rel:${file.sessionId ?? ""}:${path}`;
    }

    function readJson(key, fallback) {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return fallback;
        const value = JSON.parse(raw);
        return value !== null && typeof value === "object" ? value : fallback;
      } catch {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
      } catch {
        // Storage full or disabled: the feature degrades to "not remembered".
      }
    }

    function savePrefs(patch) {
      writeJson(STORE_PREFS, { ...readJson(STORE_PREFS, {}), ...patch });
    }

    function loadPosition(key) {
      const entry = readJson(STORE_POSITIONS, {})[key];
      return entry !== undefined && Number.isFinite(entry.t) ? entry.t : undefined;
    }

    /** Remember `time`, or forget the file when it is near the start or finished. Keeps the newest 200 files. */
    function storePosition(key, time, duration) {
      if (key === undefined || !Number.isFinite(time)) return;
      const all = readJson(STORE_POSITIONS, {});
      const finished = Number.isFinite(duration) && duration - time < RESUME_TAIL;
      if (time < RESUME_MIN || finished) {
        if (key in all) {
          delete all[key];
          writeJson(STORE_POSITIONS, all);
        }
        return;
      }
      all[key] = { t: Math.round(time * 10) / 10, at: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > MAX_POSITIONS) {
        keys.sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
        for (const stale of keys.slice(MAX_POSITIONS)) delete all[stale];
      }
      writeJson(STORE_POSITIONS, all);
    }

    /** Map a keydown to a player command, or `undefined` to let the key through. */
    function keyCommand(event) {
      if (event.altKey || event.metaKey) return undefined;
      const key = event.key;
      const lower = typeof key === "string" && key.length === 1 ? key.toLowerCase() : key;
      if (event.ctrlKey) {
        if (key === "ArrowLeft") return { cmd: "seek", arg: -SEEK_LARGE };
        if (key === "ArrowRight") return { cmd: "seek", arg: SEEK_LARGE };
        if (lower === "c") return { cmd: "copyFrame" };
        if (lower === "s") return { cmd: "saveFrame" };
        return undefined;
      }
      switch (key) {
        case " ":
          return { cmd: "toggle" };
        case "ArrowLeft":
          return { cmd: "seek", arg: -SEEK_SMALL };
        case "ArrowRight":
          return { cmd: "seek", arg: SEEK_SMALL };
        case "ArrowUp":
          return { cmd: "volume", arg: VOLUME_STEP };
        case "ArrowDown":
          return { cmd: "volume", arg: -VOLUME_STEP };
        case ",":
        case "<":
          return { cmd: "frame", arg: -1 };
        case ".":
        case ">":
          return { cmd: "frame", arg: 1 };
        case "Enter":
          return { cmd: "fullscreen" };
        case "Home":
          return { cmd: "restart" };
        case "?":
          return { cmd: "help" };
        case "Escape":
          return { cmd: "escape" };
        default:
          break;
      }
      if (lower === "f") return { cmd: "fullscreen" };
      if (lower === "m") return { cmd: "mute" };
      if (lower === "c") return { cmd: "rate", arg: RATE_STEP };
      if (lower === "x") return { cmd: "rate", arg: -RATE_STEP };
      if (lower === "z") return { cmd: "rateReset" };
      if (typeof key === "string" && key.length === 1 && key >= "0" && key <= "9") return { cmd: "percent", arg: Number(key) * 10 };
      return undefined;
    }

    // ---- frames -------------------------------------------------------------

    function frameBlob(video) {
      return new Promise((resolve, reject) => {
        if (!video || video.readyState < 2 || video.videoWidth === 0) {
          reject(new Error("no-frame"));
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("no-context"));
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        // A cross-origin (tainted) frame throws SecurityError here, rejecting the promise.
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), "image/png");
      });
    }

    function downloadBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async function playWithFeedback(video, current, success, failure) {
      try {
        await video.play();
        if (current() && !video.paused) success();
      } catch (error) {
        if (current() && error?.name !== "AbortError") failure(error);
      }
    }

    function clampTime(video, time) {
      const upper = Number.isFinite(video.duration) ? video.duration : Infinity;
      return Math.max(0, Math.min(upper, time));
    }

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
.dvp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;outline:none}
.dvp-root:fullscreen{background:#000;color:#eee}
.dvp-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden}
.dvp-video{width:100%;height:100%;object-fit:contain;outline:none}
.dvp-audio{width:100%;max-width:520px;outline:none}
.dvp-notice{position:absolute;top:0;left:0;right:0;z-index:2;margin:0;padding:8px 10px;background:rgba(120,86,20,.92);color:#fff;font-size:12px;line-height:1.55}
.dvp-notice a{color:#fff}
.dvp-error{padding:16px;font-size:13px;line-height:1.6;color:#ddd;text-align:center;max-width:420px}
.dvp-osd{position:absolute;top:12px;left:12px;padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.68);color:#fff;font-size:13px;pointer-events:none;font-variant-numeric:tabular-nums}
.dvp-resume{position:absolute;left:12px;bottom:64px;display:flex;gap:10px;align-items:center;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.75);color:#fff;font-size:12px}
.dvp-resume button{background:none;border:none;padding:0;color:inherit;font:inherit;cursor:pointer;text-decoration:underline}
.dvp-menu{position:absolute;z-index:5;min-width:212px;max-height:calc(100% - 8px);overflow-y:auto;padding:4px;box-sizing:border-box;border-radius:8px;background:rgba(32,32,34,.97);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.45);color:#eee;font-size:12.5px}
.dvp-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:5px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dvp-item:hover,.dvp-item:focus-visible{background:rgba(255,255,255,.1);outline:none}
.dvp-check{flex:0 0 12px;width:12px;text-align:center}
.dvp-label{flex:1 1 auto}
.dvp-hint{opacity:.55;font-size:11.5px}
.dvp-sep{height:1px;margin:4px 6px;background:rgba(255,255,255,.12)}
.dvp-section{padding:4px 8px 2px;opacity:.65;font-size:11.5px}
.dvp-chips{display:flex;flex-wrap:wrap;gap:4px;padding:4px 6px;max-width:220px}
.dvp-chip{min-width:40px;padding:3px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.16);background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer;font-variant-numeric:tabular-nums}
.dvp-chip:hover{background:rgba(255,255,255,.1)}
.dvp-chip[aria-pressed="true"]{background:rgba(90,150,255,.35);border-color:rgba(120,170,255,.75)}
.dvp-help{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)}
.dvp-help-card{max-width:calc(100% - 24px);max-height:calc(100% - 24px);overflow:auto;padding:12px 16px;box-sizing:border-box;border-radius:8px;background:rgba(32,32,34,.97);border:1px solid rgba(255,255,255,.12);color:#eee;font-size:12.5px}
.dvp-help-card table{border-collapse:collapse}
.dvp-help-card td{padding:3px 12px 3px 0;vertical-align:top}
.dvp-help-card kbd{font-family:inherit;padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06);font-size:11.5px;white-space:nowrap}
.dvp-help-card p{margin:8px 0 0;opacity:.75}
.dvp-help-card .dvp-help-actions{margin-top:10px;text-align:right;opacity:1}
.dvp-help-card .dvp-help-actions button{padding:3px 12px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dvp-help-card .dvp-help-actions button:hover{background:rgba(255,255,255,.16)}
.dvp-bar{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:6px 10px;font-size:12px;opacity:.85}
.dvp-bar button,.dvp-bar a{background:none;border:none;padding:0;color:inherit;cursor:pointer;text-decoration:underline;font:inherit}
.dvp-bar .dvp-rate{text-decoration:none;border:1px solid currentColor;border-radius:4px;padding:0 6px;font-variant-numeric:tabular-nums}
.dvp-spacer{flex:1 1 auto}
`;

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

    // ---- media --------------------------------------------------------------

    function MediaBody(props) {
      const { tab, file, base, info, t } = props;
      const media = info.media ?? {};
      const isVideo = media.kind !== "audio";
      const unsupported = media.playable === false;
      const [nonce, setNonce] = useState(0);
      const [error, setError] = useState(undefined);
      const [rate, setRate] = useState(() => clampRate(Number(readJson(STORE_PREFS, {}).rate ?? 1)));
      const [paused, setPaused] = useState(true);
      const [muted, setMuted] = useState(false);
      const [loop, setLoop] = useState(false);
      const [full, setFull] = useState(false);
      const [osd, setOsd] = useState(undefined);
      const [menu, setMenu] = useState(undefined);
      const [help, setHelp] = useState(false);
      const [resumed, setResumed] = useState(undefined);

      const rootRef = useRef(null);
      const stageRef = useRef(null);
      const menuRef = useRef(null);
      const videoRef = useRef(null);
      const probeRef = useRef(null);
      const frameRef = useRef(1 / 30);
      const savedAtRef = useRef(-Infinity);
      const osdTimer = useRef(undefined);
      const rateRef = useRef(rate);
      rateRef.current = rate;
      const posKey = positionKey(file);
      const posKeyRef = useRef(posKey);
      posKeyRef.current = posKey;

      const src = nonce === 0 ? previewUrl(base, "stream", file) : previewUrl(base, "stream", file, { v: String(nonce) });
      const name = info.name ?? basenameOfPath(file.path);
      const downloadHref = previewUrl(base, "download", file);

      const showOsd = useCallback((text) => {
        setOsd(text);
        clearTimeout(osdTimer.current);
        osdTimer.current = setTimeout(() => setOsd(undefined), 1300);
      }, []);
      useEffect(() => () => clearTimeout(osdTimer.current), []);

      const savePosition = useCallback((video) => {
        if (!video || video.readyState < 1) return;
        storePosition(posKeyRef.current, video.currentTime, video.duration);
        savedAtRef.current = video.currentTime;
      }, []);

      // Ref callback: initialise a new element before it loads, release the old one.
      const attachVideo = useCallback((node) => {
        const previous = videoRef.current;
        if (previous !== node) {
          probeRef.current?.abort();
          probeRef.current = null;
        }
        if (previous && previous !== node) {
          savePosition(previous);
          previous.pause();
          previous.removeAttribute("src");
          previous.load();
        }
        videoRef.current = node;
        if (node) {
          const prefs = readJson(STORE_PREFS, {});
          node.defaultPlaybackRate = rateRef.current;
          node.playbackRate = rateRef.current;
          if (Number.isFinite(prefs.volume)) node.volume = Math.min(1, Math.max(0, prefs.volume));
          node.muted = prefs.muted === true;
          setMuted(node.muted);
        }
      }, [savePosition]);

      // A hidden tab (another tab selected, sidebar collapsed, session switched) stops playing.
      useEffect(() => {
        if (tab.visible !== false) return;
        const video = videoRef.current;
        if (video) {
          video.pause();
          savePosition(video);
        }
        setMenu(undefined);
        setHelp(false);
      }, [tab.visible, savePosition]);

      useEffect(() => {
        const onHide = () => savePosition(videoRef.current);
        window.addEventListener("pagehide", onHide);
        return () => window.removeEventListener("pagehide", onHide);
      }, [savePosition]);

      useEffect(() => {
        const onChange = () => setFull(document.fullscreenElement === rootRef.current && rootRef.current !== null);
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
      }, []);

      useEffect(() => {
        if (resumed === undefined) return undefined;
        const timer = setTimeout(() => setResumed(undefined), 6000);
        return () => clearTimeout(timer);
      }, [resumed]);

      useEffect(() => {
        setError(undefined);
      }, [src]);

      // Estimate the frame duration from presented frames while playing.
      useEffect(() => {
        const video = videoRef.current;
        if (!isVideo || !video || paused || typeof video.requestVideoFrameCallback !== "function") return undefined;
        let handle;
        let last;
        let samples = 0;
        let best = Infinity;
        let stopped = false;
        const step = (_now, meta) => {
          if (stopped) return;
          if (last !== undefined) {
            const delta = meta.mediaTime - last;
            if (delta > 1 / 240 && delta < 0.25) {
              best = Math.min(best, delta);
              samples += 1;
              if (samples >= 10) frameRef.current = best;
            }
          }
          last = meta.mediaTime;
          if (samples < 60) handle = video.requestVideoFrameCallback(step);
        };
        handle = video.requestVideoFrameCallback(step);
        return () => {
          stopped = true;
          video.cancelVideoFrameCallback?.(handle);
        };
      }, [paused, src, isVideo]);

      // Close the menu on a press outside it or when the window loses focus.
      useEffect(() => {
        if (menu === undefined) return undefined;
        const onPointer = (event) => {
          // The speed button toggles the menu itself in its click handler.
          if (menuRef.current?.contains(event.target) || event.target?.closest?.("[data-dvp-rate]")) return;
          setMenu(undefined);
        };
        const onBlur = () => setMenu(undefined);
        document.addEventListener("pointerdown", onPointer, true);
        window.addEventListener("blur", onBlur);
        return () => {
          document.removeEventListener("pointerdown", onPointer, true);
          window.removeEventListener("blur", onBlur);
        };
      }, [menu]);

      // Keep the menu inside the stage once its size is known.
      useLayoutEffect(() => {
        if (menu === undefined || menu.placed) return;
        const element = menuRef.current;
        const stage = stageRef.current;
        if (!element || !stage) return;
        const x = Math.max(4, Math.min(menu.x, stage.clientWidth - element.offsetWidth - 4));
        const y = Math.max(4, Math.min(menu.y, stage.clientHeight - element.offsetHeight - 4));
        setMenu({ x, y, placed: true });
      }, [menu]);

      const focusRoot = () => rootRef.current?.focus({ preventScroll: true });

      const applyRate = (next) => {
        const value = clampRate(next);
        const video = videoRef.current;
        if (video) {
          video.defaultPlaybackRate = value;
          video.playbackRate = value;
        }
        setRate(value);
        savePrefs({ rate: value });
        showOsd(`${t("speed")} ${formatRate(value)}`);
      };

      const toggleFullscreen = () => {
        const root = rootRef.current;
        if (!root) return;
        if (document.fullscreenElement) {
          document.exitFullscreen?.().catch(() => {});
          return;
        }
        const request = root.requestFullscreen?.();
        if (request === undefined) showOsd(t("fullscreenFailed"));
        else request.catch(() => showOsd(t("fullscreenFailed")));
      };

      const shotError = (cause) => (cause?.name === "SecurityError" ? t("shotBlocked") : t("shotFailed"));
      // Filename uses the instant the frame was captured, with milliseconds so
      // rapid successive screenshots do not collide.
      const shotName = (at) => `${stemOf(name)}_${formatTime(at, true).replace(/[:.]/g, "-")}.png`;
      // Draw the current frame once, recording the presentation time it belongs
      // to *before* the async encode, so the name and message match the picture.
      const captureFrame = async () => {
        const video = videoRef.current;
        const at = video ? video.currentTime : 0;
        return { blob: await frameBlob(video), at };
      };

      const copyFrame = async () => {
        let shot;
        try {
          shot = await captureFrame();
        } catch (cause) {
          showOsd(shotError(cause));
          return;
        }
        try {
          if (typeof navigator.clipboard?.write !== "function" || typeof ClipboardItem !== "function") throw new Error("no clipboard");
          await navigator.clipboard.write([new ClipboardItem({ [shot.blob.type]: shot.blob })]);
          showOsd(`${t("shotCopied")} · ${formatTime(shot.at)}`);
        } catch {
          downloadBlob(shot.blob, shotName(shot.at));
          showOsd(t("shotSavedInstead"));
        }
      };

      const saveFrame = async () => {
        let shot;
        try {
          shot = await captureFrame();
        } catch (cause) {
          showOsd(shotError(cause));
          return;
        }
        downloadBlob(shot.blob, shotName(shot.at));
        showOsd(t("shotSaved"));
      };

      const restart = () => {
        const video = videoRef.current;
        setResumed(undefined);
        if (!video) return;
        video.currentTime = 0;
        storePosition(posKeyRef.current, 0, video.duration);
        savedAtRef.current = 0;
        showOsd(t("restart"));
      };

      const run = (cmd, arg) => {
        switch (cmd) {
          case "help":
            setMenu(undefined);
            setHelp((value) => !value);
            return;
          case "rate":
            applyRate(rateRef.current + arg);
            return;
          case "rateSet":
            applyRate(arg);
            return;
          case "rateReset":
            applyRate(1);
            return;
          case "copyFrame":
            void copyFrame();
            return;
          case "saveFrame":
            void saveFrame();
            return;
          case "fullscreen":
            toggleFullscreen();
            return;
          case "restart":
            restart();
            return;
          default:
            break;
        }
        const video = videoRef.current;
        if (!video) return;
        switch (cmd) {
          case "toggle":
            if (video.paused || video.ended) {
              void playWithFeedback(video, () => videoRef.current === video, () => showOsd(t("play")), () => showOsd(t("playFailed")));
            } else {
              video.pause();
              showOsd(t("pause"));
            }
            return;
          case "seek": {
            const target = clampTime(video, video.currentTime + arg);
            video.currentTime = target;
            showOsd(`${arg > 0 ? "+" : "−"}${Math.abs(arg)} ${t("seconds")} · ${formatTime(target)} / ${formatTime(video.duration)}`);
            return;
          }
          case "percent":
            if (Number.isFinite(video.duration)) {
              const target = (video.duration * arg) / 100;
              video.currentTime = target;
              showOsd(`${arg}% · ${formatTime(target)}`);
            }
            return;
          case "frame": {
            if (!isVideo) return;
            video.pause();
            const target = clampTime(video, video.currentTime + arg * frameRef.current);
            video.currentTime = target;
            showOsd(`${arg > 0 ? t("nextFrame") : t("prevFrame")} · ${formatTime(target, true)}`);
            return;
          }
          case "volume": {
            video.muted = false;
            const next = Math.min(1, Math.max(0, Math.round((video.volume + arg) * 100) / 100));
            video.volume = next;
            showOsd(`${t("volume")} ${Math.round(next * 100)}%`);
            return;
          }
          case "mute":
            video.muted = !video.muted;
            showOsd(video.muted ? t("muted") : t("unmuted"));
            return;
          case "loop":
            video.loop = !video.loop;
            setLoop(video.loop);
            showOsd(video.loop ? t("loopOn") : t("loopOff"));
            return;
          case "pip":
            if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
            else if (typeof video.requestPictureInPicture === "function") video.requestPictureInPicture().catch(() => showOsd(t("pipFailed")));
            else showOsd(t("pipFailed"));
            return;
          default:
            return;
        }
      };

      const onKeyDown = (event) => {
        const command = keyCommand(event);
        if (command === undefined) return;
        // Enter and Space belong to a focused button or link (menu items, bar actions).
        if ((event.key === "Enter" || event.key === " ") && event.target instanceof Element && event.target.closest("button, a[href]")) return;
        if (command.cmd === "escape") {
          if (menu !== undefined || help) {
            setMenu(undefined);
            setHelp(false);
            event.stopPropagation();
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        run(command.cmd, command.arg);
      };

      const openMenu = (clientX, clientY) => {
        const stage = stageRef.current;
        if (!stage || !videoRef.current) return;
        const rect = stage.getBoundingClientRect();
        setHelp(false);
        setMenu({ x: clientX - rect.left, y: clientY - rect.top, placed: false });
      };

      const onContextMenu = (event) => {
        event.preventDefault();
        if (menuRef.current?.contains(event.target)) return;
        openMenu(event.clientX, event.clientY);
      };

      // ---- media events ----
      const isCurrent = (event) => event.currentTarget === videoRef.current;

      const onLoadedMetadata = (event) => {
        if (!isCurrent(event)) return;
        const video = event.currentTarget;
        video.defaultPlaybackRate = rateRef.current;
        video.playbackRate = rateRef.current;
        const saved = loadPosition(posKeyRef.current);
        if (saved !== undefined && saved > RESUME_MIN && Number.isFinite(video.duration) && saved < video.duration - RESUME_TAIL) {
          video.currentTime = saved;
          savedAtRef.current = saved;
          setResumed(saved);
        }
      };

      const onTimeUpdate = (event) => {
        if (!isCurrent(event)) return;
        const video = event.currentTarget;
        if (Math.abs(video.currentTime - savedAtRef.current) >= SAVE_EVERY) savePosition(video);
      };

      const onPlay = (event) => {
        if (isCurrent(event)) setPaused(false);
      };

      const onPause = (event) => {
        if (!isCurrent(event)) return;
        setPaused(true);
        savePosition(event.currentTarget);
      };

      const onSeeked = (event) => {
        if (isCurrent(event)) savePosition(event.currentTarget);
      };

      const onEnded = (event) => {
        if (!isCurrent(event)) return;
        const video = event.currentTarget;
        storePosition(posKeyRef.current, video.duration, video.duration);
        setPaused(true);
      };

      const onRateChange = (event) => {
        if (!isCurrent(event)) return;
        const video = event.currentTarget;
        if (video.readyState < 1) return;
        const value = clampRate(video.playbackRate);
        if (value !== rateRef.current) {
          setRate(value);
          savePrefs({ rate: value });
        }
      };

      const onVolumeChange = (event) => {
        if (!isCurrent(event)) return;
        const video = event.currentTarget;
        setMuted(video.muted);
        savePrefs({ volume: video.volume, muted: video.muted });
      };

      const onError = async (event) => {
        if (!isCurrent(event)) return;
        const video = event.currentTarget;
        const code = video.error?.code;
        if (code === 1) {
          setError(t("aborted"));
          return;
        }
        if (code === 3) {
          setError(t("decode"));
          return;
        }
        // Code 2 (network) or 4 (source not supported): ask the route itself,
        // which tells an HTTP failure apart from a codec the browser lacks.
        probeRef.current?.abort();
        const controller = new AbortController();
        probeRef.current = controller;
        const current = () => !controller.signal.aborted && videoRef.current === video && probeRef.current === controller;
        try {
          const response = await fetch(src, { method: "HEAD", credentials: "same-origin", signal: controller.signal });
          if (current()) setError(response.ok ? t("unsupported") : messageForStatus(response.status, t));
        } catch {
          if (current()) setError(t("network"));
        } finally {
          if (probeRef.current === controller) probeRef.current = null;
        }
      };

      const reload = () => {
        probeRef.current?.abort();
        probeRef.current = null;
        setNonce((value) => value + 1);
      };

      // ---- menu and help ----
      const renderMenu = () => {
        const video = videoRef.current;
        const isPaused = video ? video.paused : true;
        const item = (label, hint, action, checked) => h("button", {
          type: "button",
          role: checked === undefined ? "menuitem" : "menuitemcheckbox",
          "aria-checked": checked,
          className: "dvp-item",
          onClick: () => {
            setMenu(undefined);
            focusRoot();
            action();
          },
        }, h("span", { className: "dvp-check" }, checked ? "✓" : ""), h("span", { className: "dvp-label" }, label), hint ? h("span", { className: "dvp-hint" }, hint) : null);
        const chip = (label, action, pressed) => h("button", { type: "button", className: "dvp-chip", "aria-pressed": pressed, onClick: action }, label);
        const sep = () => h("div", { className: "dvp-sep", role: "separator" });
        return h("div", { ref: menuRef, className: "dvp-menu", role: "menu", style: { left: menu.x, top: menu.y, visibility: menu.placed ? "visible" : "hidden" } },
          h("div", { className: "dvp-section" }, `${t("menuSpeed")} · ${formatRate(rate)}`),
          h("div", { className: "dvp-chips" }, ...RATE_PRESETS.map((preset) => chip(formatRate(preset), () => run("rateSet", preset), rate === preset))),
          h("div", { className: "dvp-chips" },
            chip("−0.1", () => run("rate", -RATE_STEP), false),
            chip("+0.1", () => run("rate", RATE_STEP), false)),
          sep(),
          item(isPaused ? t("play") : t("pause"), "Space", () => run("toggle")),
          item(t("back5"), "←", () => run("seek", -SEEK_SMALL)),
          item(t("fwd5"), "→", () => run("seek", SEEK_SMALL)),
          isVideo ? item(t("prevFrame"), ",", () => run("frame", -1)) : null,
          isVideo ? item(t("nextFrame"), ".", () => run("frame", 1)) : null,
          sep(),
          isVideo ? item(t("copyFrame"), "Ctrl+C", () => run("copyFrame")) : null,
          isVideo ? item(t("saveFrame"), "Ctrl+S", () => run("saveFrame")) : null,
          isVideo ? sep() : null,
          item(t("loop"), "", () => run("loop"), loop),
          item(t("mute"), "M", () => run("mute"), muted),
          item(t("pip"), "", () => run("pip")),
          item(full ? t("exitFullscreen") : t("fullscreen"), "F", () => run("fullscreen")),
          sep(),
          item(t("restart"), "Home", () => run("restart")),
          item(t("shortcuts"), "?", () => run("help")));
      };

      const renderHelp = () => {
        const rows = [
          ["Space", t("playPause")],
          ["← / →", t("helpSeek")],
          ["Ctrl + ← / →", t("helpSeekLarge")],
          ["↑ / ↓", t("helpVolume")],
          ["M", t("mute")],
          isVideo ? [", / .", t("helpFrame")] : null,
          ["C / X", t("helpRate")],
          ["Z", t("helpRateReset")],
          ["0 – 9", t("helpPercent")],
          ["Home", t("restart")],
          ["F / Enter", t("fullscreen")],
          isVideo ? ["Ctrl + C", t("copyFrame")] : null,
          isVideo ? ["Ctrl + S", t("saveFrame")] : null,
          ["?", t("helpHelp")],
        ].filter(Boolean);
        return h("div", { className: "dvp-help", role: "presentation", onClick: () => setHelp(false) },
          h("div", { className: "dvp-help-card", role: "dialog", "aria-modal": "true", "aria-label": t("shortcuts"), onClick: (event) => event.stopPropagation() },
            h("table", null, h("tbody", null, ...rows.map(([keys, label]) => h("tr", { key: keys }, h("td", null, h("kbd", null, keys)), h("td", null, label))))),
            h("p", null, t("helpMenu")),
            h("p", null, t("helpFocus")),
            h("p", { className: "dvp-help-actions" },
              h("button", { type: "button", onClick: () => { setHelp(false); focusRoot(); } }, t("close")))));
      };

      const playerProps = {
        key: src,
        ref: attachVideo,
        className: isVideo ? "dvp-video" : "dvp-audio",
        src,
        controls: true,
        loop,
        controlsList: "nofullscreen",
        preload: "metadata",
        onDoubleClick: toggleFullscreen,
        onLoadedMetadata,
        onTimeUpdate,
        onPlay,
        onPause,
        onSeeked,
        onEnded,
        onRateChange,
        onVolumeChange,
        onError,
      };
      if (isVideo) playerProps.playsInline = true;

      return h("div", { ref: rootRef, className: "dvp-root", tabIndex: 0, "data-preview-all-in-one": "", onKeyDownCapture: onKeyDown },
        h("div", { ref: stageRef, className: "dvp-stage", onContextMenu },
          error === undefined
            ? h(isVideo ? "video" : "audio", playerProps)
            : h("p", { className: "dvp-error" }, error),
          unsupported && error === undefined
            ? h("p", { className: "dvp-notice" }, t("unsupported"), " ",
              h("a", { href: downloadHref, download: name }, t("download")))
            : null,
          osd === undefined ? null : h("div", { className: "dvp-osd", role: "status", "data-dvp-osd": "" }, osd),
          resumed === undefined ? null : h("div", { className: "dvp-resume", "data-dvp-resume": "" },
            h("span", null, `${t("resumedFrom")}${formatTime(resumed)}`),
            h("button", { type: "button", onClick: () => { restart(); focusRoot(); } }, t("restart"))),
          menu === undefined ? null : renderMenu(),
          help ? renderHelp() : null),
        h("div", { className: "dvp-bar" },
          h("button", {
            type: "button",
            className: "dvp-rate",
            title: t("menuSpeed"),
            "data-dvp-rate": "",
            onClick: (event) => {
              if (menu !== undefined) {
                setMenu(undefined);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(rect.left, rect.top);
            },
          }, formatRate(rate)),
          isVideo ? h("button", { type: "button", title: `${t("copyFrame")} (Ctrl+C)`, onClick: () => run("copyFrame") }, t("screenshot")) : null,
          h("button", { type: "button", onClick: () => run("help") }, t("shortcuts")),
          h("span", { className: "dvp-spacer" }),
          h("button", { type: "button", onClick: reload }, t("reload")),
          h("a", { href: downloadHref, download: name }, t("download"))));
    }

    // ---- archive ------------------------------------------------------------

    /** One archive member: bytes fetched on demand, text or image by type. */
    function EntryView({ tab, file, base, entry, t }) {
      const [state, setState] = useState({ status: "loading" });
      const tRef = useRef(t);
      tRef.current = t;

      useEffect(() => {
        const controller = new AbortController();
        const signal = tab.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, tab.signal]);
        let live = true;
        let objectUrl;
        setState({ status: "loading" });
        const url = previewUrl(base, "entry", file, { entry: entry.name });
        fetch(url, { credentials: "same-origin", signal })
          .then(async (response) => {
            if (!response.ok) throw Object.assign(new Error("status"), { status: response.status });
            if (entry.image) {
              const blob = await response.blob();
              if (!live) return;
              objectUrl = URL.createObjectURL(blob);
              setState({ status: "image", url: objectUrl });
              return;
            }
            const text = await response.text();
            if (!live) return;
            setState({ status: "text", text });
          })
          .catch((error) => {
            if (!live || signal.aborted) return;
            const status = error?.status;
            setState({ status: "error", message: status === undefined ? tRef.current("network") : messageForStatus(status, tRef.current) });
          });
        return () => {
          live = false;
          controller.abort();
          if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
        };
      }, [entry, file, base, tab.signal]);

      if (state.status === "loading") return statusPanel(t("entryLoading"));
      if (state.status === "error") return statusPanel(`${t("archiveEntryFailed")}：${state.message}`);
      if (state.status === "image") {
        return h("img", { className: "dpa-image", src: state.url, alt: entry.name });
      }
      return h("pre", { className: "dpa-text" }, state.text);
    }

    function ArchiveBody({ tab, file, base, info, t }) {
      const archive = info.archive ?? {};
      const entries = useMemo(() => archive.entries ?? [], [archive.entries]);
      const [filter, setFilter] = useState("");
      const [picked, setPicked] = useState(undefined);

      const query = filter.trim().toLowerCase();
      const matching = useMemo(
        () => (query === "" ? entries : entries.filter((entry) => entry.name.toLowerCase().includes(query))),
        [entries, query],
      );
      const rows = matching.slice(0, MAX_ROWS);

      if (picked !== undefined) {
        return h("div", { className: "dpa-body" },
          h("div", { className: "dpa-toolbar" },
            h("button", { type: "button", className: "dpa-button", onClick: () => setPicked(undefined) }, t("archiveBack")),
            h("span", { className: "dpa-sub dpa-row-name", title: picked.name }, picked.name),
            h("span", { className: "dpa-sub" }, formatSize(picked.size))),
          h(EntryView, { tab, file, base, entry: picked, t }));
      }

      return h("div", { className: "dpa-body" },
        h("div", { className: "dpa-toolbar" },
          h("span", { className: "dpa-sub" }, `${archive.format ?? ""} · ${t("archiveCount", { count: entries.length })}`)),
        archive.note ? h("p", { className: "dpa-notice" }, archive.note) : null,
        entries.length === 0
          ? h("p", { className: "dpa-empty" }, t("archiveNone"))
          : h("input", {
            className: "dpa-filter",
            type: "search",
            value: filter,
            placeholder: t("archiveFilter"),
            "aria-label": t("archiveFilter"),
            onChange: (event) => setFilter(event.target.value),
          }),
        entries.length === 0 ? null : h("p", { className: "dpa-sub", style: { margin: "0 0 6px" } }, t("archivePick")),
        h("div", { className: "dpa-list" },
          ...rows.map((entry) => {
            const openable = entry.previewable === true;
            return h(openable ? "button" : "div", {
              key: entry.name,
              type: openable ? "button" : undefined,
              className: "dpa-row",
              "data-open": openable ? "" : undefined,
              title: entry.name,
              onClick: openable ? () => setPicked(entry) : undefined,
            },
            h("span", { className: "dpa-row-name" }, entry.dir ? `${entry.name}/` : entry.name),
            entry.encrypted ? h("span", { className: "dpa-tag" }, t("archiveEncrypted")) : null,
            entry.image ? h("span", { className: "dpa-tag" }, t("archiveImage")) : null,
            !entry.dir && !entry.image && openable ? h("span", { className: "dpa-tag" }, t("archiveText")) : null,
            h("span", { className: "dpa-row-size" }, entry.dir ? "" : formatSize(entry.size)));
          })),
        matching.length > rows.length
          ? h("p", { className: "dpa-sub", style: { marginTop: 8 } }, t("archiveShown", { count: rows.length }))
          : null,
        matching.length === 0 && entries.length > 0
          ? h("p", { className: "dpa-empty" }, t("archiveNone"))
          : null);
    }

    // ---- font ---------------------------------------------------------------

    function FontBody({ file, base, info, t }) {
      const font = info.font ?? {};
      const family = useMemo(() => `dpa-face-${Math.random().toString(36).slice(2, 10)}`, []);
      const url = previewUrl(base, "font", file);
      const format = String(font.format ?? "").toLowerCase();
      const renderable = format !== "pfb" && format !== "eot";
      const [loaded, setLoaded] = useState(undefined);

      useEffect(() => {
        if (!renderable) return undefined;
        const fonts = typeof document === "undefined" ? undefined : document.fonts;
        if (fonts === undefined || typeof fonts.load !== "function") return undefined;
        let live = true;
        fonts.load(`16px "${family}"`).then(
          () => { if (live) setLoaded(fonts.check(`16px "${family}"`)); },
          () => { if (live) setLoaded(false); },
        );
        return () => { live = false; };
      }, [family, renderable, url]);

      const face = renderable ? `@font-face{font-family:"${family}";src:url("${url}");font-display:swap}` : "";
      const stack = `"${family}", -apple-system, "Segoe UI", system-ui, sans-serif`;
      const line = (size, text) => h("p", { style: { fontFamily: stack, fontSize: `${size}px` } }, text);

      return h("div", { className: "dpa-body" },
        renderable ? h("style", null, face) : null,
        renderable ? null : h("p", { className: "dpa-notice" }, t("fontUnsupported")),
        renderable && loaded === false ? h("p", { className: "dpa-notice" }, t("fontMissing")) : null,
        h("div", { className: "dpa-section" }, t("fontSpecimen")),
        h("div", { className: "dpa-specimen" },
          line(46, "Aa 汉字永"),
          line(30, t("fontSample")),
          line(20, "0123456789 !?&@#%¥$€"),
          line(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
          line(14, "abcdefghijklmnopqrstuvwxyz")),
        h("div", { className: "dpa-section" }, t("fontInfo")),
        detailList([
          [t("fontFamily"), font.family],
          [t("fontSubfamily"), font.subfamily],
          [t("fontFullName"), font.fullName],
          [t("fontFormat"), font.format],
          [t("fontVersion"), font.version],
          [t("fontGlyphs"), font.glyphCount],
          [t("fontUnits"), font.unitsPerEm],
          [t("fontDesigner"), font.designer],
          [t("fontLicense"), font.license],
          [t("fontCopyright"), font.copyright],
        ]),
        h("p", { className: "dpa-sub" }, loaded === true ? t("fontLoaded") : renderable && loaded === undefined ? t("fontLoading") : ""));
    }

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

    function RasterBody(props) {
      return h(ImageBody, { ...props, route: "raster", failureKey: "rasterFailed", detailsKey: "raster" });
    }

    function PictureBody(props) {
      return h(ImageBody, { ...props, route: "picture", failureKey: "pictureFailed", detailsKey: "raster" });
    }

    // ---- document -----------------------------------------------------------

    function DocumentBody({ info }) {
      const doc = info.document ?? {};
      const title = doc.title ?? info.name ?? "";
      const src = useMemo(() => documentHtml(doc.html ?? "", title), [doc.html, title]);
      return h("div", { className: "dpa-frame-wrap" },
        h("iframe", { className: "dpa-frame", sandbox: "", title, srcDoc: src }));
    }

    // ---- binary -------------------------------------------------------------

    function BinaryBody({ info, t }) {
      const binary = info.binary ?? {};
      return h("div", { className: "dpa-body" },
        info.notice ? h("p", { className: "dpa-notice" }, info.notice) : null,
        binary.summary ? h("p", { className: "dpa-summary" }, binary.summary) : h("p", { className: "dpa-empty" }, t("binaryUnviewable")),
        detailList([
          [t("binaryInfo"), binary.format],
          [t("fontFormat"), binary.kind],
          [t("binarySize"), info.sizeLabel],
          ...(binary.details ?? []),
        ]),
        info.hex ? h("div", { className: "dpa-section" }, t("binaryHex")) : null,
        info.hex ? h("pre", { className: "dpa-pre" }, info.hex) : null);
    }

    // ---- root body ----------------------------------------------------------

    const BODIES = {
      media: MediaBody,
      archive: ArchiveBody,
      font: FontBody,
      raster: RasterBody,
      picture: PictureBody,
      document: DocumentBody,
      binary: BinaryBody,
    };

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
        fetch(previewUrl(base, "info", file), { credentials: "same-origin", signal })
          .then(async (response) => {
            if (!response.ok) throw Object.assign(new Error("status"), { status: response.status });
            return response.json();
          })
          .then((info) => {
            if (live && !signal.aborted) setState({ status: "ready", info });
          })
          .catch((error) => {
            if (!live || signal.aborted) return;
            const status = error?.status;
            setState({ status: "error", message: status === undefined ? tRef.current("network") : messageForStatus(status, tRef.current) });
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
      const Body = BODIES[info.kind] ?? BinaryBody;
      if (info.kind === "media") {
        return h(MediaBody, { tab, file, base, info, t });
      }
      return h("div", { className: "dpa-root" },
        headerBar(info, file, base, t, reload),
        h(Body, { tab, file, base, info, t }));
    }

    const inject = ["slots", "locale", "sidebarRightTabs"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => {
        // One stylesheet for every preview tab, removed when the plugin unloads.
        const style = document.createElement("style");
        style.dataset.dshPreviewAllInOne = "";
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "dsh-preview-all-in-one: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-preview-all-in-one: dictionaries");
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
      }), "dsh-preview-all-in-one: tab type");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: ID,
        locale: NS,
        inject: () => ({ t }),
      }, PreviewBody)), "dsh-preview-all-in-one: tab body");
    }

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
      EXTENSIONS,
      PATTERNS,
      ROUTES,
      keyCommand,
      clampRate,
      formatRate,
      formatTime,
      positionKey,
      storePosition,
      loadPosition,
    };
  },
});
