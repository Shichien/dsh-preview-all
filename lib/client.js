// Client half of dsh-video-preview. Hand-written for the DSH module loader
// (no build step): `require` hands out the shared React instance.
//
// Registers a right-Sidebar tab type for session file addresses that end in a
// video extension. Its glob is longer than Better Sidebar's catch-all
// `dsh-resource://file/**`, and both sit in the `extension` band, so the tab
// registry ranks this type first; DSH's own document preview (`fallback`
// band) ranks below both. The body is a native <video> element pointed at the
// host's byte-range route, so seeking works without loading the whole file.
//
// Player features on top of the native controls: a right-click menu with fine
// speed control, keyboard shortcuts while the player has focus, per-file
// resume position, and copying or saving the current frame.
window.__ModuleLoader__.load({
  id: "dsh-video-preview",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    const ID = "dsh-video-preview";
    const KIND = "video-preview";
    const NS = "dsh-video-preview";
    const ROUTE = "video-preview/stream";
    const EXTENSIONS = ["mp4", "m4v", "mov", "webm", "ogv", "mkv"];
    const PATTERNS = [`dsh-resource://file/**/*.{${EXTENSIONS.join(",")}}`];
    const FILE_PREFIX = "dsh-resource://file/";

    const RATE_MIN = 0.1;
    const RATE_MAX = 4;
    const RATE_STEP = 0.1;
    const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const SEEK_SMALL = 5;
    const SEEK_LARGE = 30;
    const VOLUME_STEP = 0.05;
    const STORE_PREFS = "dsh-video-preview:prefs";
    const STORE_POSITIONS = "dsh-video-preview:positions";
    const MAX_POSITIONS = 200;
    /** Positions closer than this to the start are not worth resuming. */
    const RESUME_MIN = 5;
    /** Positions closer than this to the end count as finished. */
    const RESUME_TAIL = 10;
    /** Seconds of playback between position saves. */
    const SAVE_EVERY = 5;

    const zh = {
      reload: "重新加载",
      download: "下载",
      unsupported: "浏览器无法解码这个视频（常见于 HEVC/H.265 编码的 mp4/mov，或 mkv 里的非常见编码）。可以下载后用本地播放器打开。",
      decode: "视频解码出错，文件可能已损坏或编码不受支持。",
      aborted: "视频加载被中断。",
      notFound: "找不到这个文件，它可能已被移动或删除。",
      forbidden: "没有读取这个文件的权限（可能被沙箱策略拒绝）。",
      unauthorized: "登录状态已失效，请刷新页面后重试。",
      network: "无法连接到 DSH 主机。",
      failed: "视频加载失败",
      noSession: "这个文件不属于任何会话，无法预览。",
      speed: "速度",
      menuSpeed: "播放速度",
      play: "播放",
      playFailed: "无法开始播放，请检查视频或重试。",
      pause: "暂停",
      playPause: "播放 / 暂停",
      back5: "后退 5 秒",
      fwd5: "前进 5 秒",
      prevFrame: "上一帧（近似）",
      nextFrame: "下一帧（近似）",
      copyFrame: "复制当前画面",
      saveFrame: "保存当前画面 (PNG)",
      screenshot: "截图",
      loop: "循环播放",
      loopOn: "循环播放：开",
      loopOff: "循环播放：关",
      mute: "静音",
      muted: "已静音",
      unmuted: "取消静音",
      volume: "音量",
      pip: "画中画",
      pipFailed: "无法进入画中画",
      fullscreen: "全屏",
      exitFullscreen: "退出全屏",
      fullscreenFailed: "无法进入全屏",
      restart: "从头播放",
      shortcuts: "快捷键",
      seconds: "秒",
      shotCopied: "已复制画面到剪贴板",
      shotSaved: "已保存 PNG",
      shotSavedInstead: "无法写入剪贴板，已改为保存 PNG",
      shotFailed: "截图失败：视频还没有可用的画面",
      shotBlocked: "截图失败：浏览器不允许读取这个视频的画面",
      resumedFrom: "已从上次位置继续：",
      helpSeek: "快退 / 快进 5 秒",
      helpSeekLarge: "快退 / 快进 30 秒",
      helpVolume: "音量 ±5%",
      helpFrame: "上一帧 / 下一帧（近似步进，会暂停）",
      helpRate: "加速 / 减速 0.1×",
      helpRateReset: "恢复 1.0×",
      helpPercent: "跳到 0%–90% 位置",
      helpHelp: "显示 / 关闭本说明",
      helpMenu: "右键点视频打开完整菜单。",
      helpFocus: "快捷键在播放器获得焦点时生效：先点一下播放器。",
      close: "关闭",
    };
    const en = {
      reload: "Reload",
      download: "Download",
      unsupported: "The browser cannot decode this video (common with HEVC/H.265 mp4/mov files, or uncommon codecs inside mkv). Download it and open it in a local player.",
      decode: "The video failed to decode. The file may be damaged or use an unsupported codec.",
      aborted: "Loading the video was interrupted.",
      notFound: "The file was not found. It may have been moved or deleted.",
      forbidden: "Permission denied reading this file (possibly refused by the sandbox policy).",
      unauthorized: "The login has expired. Refresh the page and try again.",
      network: "Cannot reach the DSH host.",
      failed: "The video failed to load",
      noSession: "This file does not belong to a session and cannot be previewed.",
      speed: "Speed",
      menuSpeed: "Playback speed",
      play: "Play",
      pause: "Pause",
      playPause: "Play / pause",
      back5: "Back 5 s",
      fwd5: "Forward 5 s",
      prevFrame: "Previous frame (approx.)",
      nextFrame: "Next frame (approx.)",
      copyFrame: "Copy current frame",
      saveFrame: "Save current frame (PNG)",
      screenshot: "Screenshot",
      loop: "Loop",
      loopOn: "Loop: on",
      loopOff: "Loop: off",
      mute: "Mute",
      muted: "Muted",
      unmuted: "Unmuted",
      volume: "Volume",
      pip: "Picture in picture",
      pipFailed: "Picture in picture is unavailable",
      fullscreen: "Full screen",
      exitFullscreen: "Exit full screen",
      fullscreenFailed: "Full screen is unavailable",
      restart: "Play from start",
      shortcuts: "Shortcuts",
      seconds: "s",
      shotCopied: "Frame copied to the clipboard",
      shotSaved: "PNG saved",
      shotSavedInstead: "Clipboard unavailable; saved a PNG instead",
      shotFailed: "Screenshot failed: no frame is available yet",
      shotBlocked: "Screenshot failed: the browser does not allow reading this video's pixels",
      resumedFrom: "Resumed from ",
      helpSeek: "Back / forward 5 s",
      helpSeekLarge: "Back / forward 30 s",
      helpVolume: "Volume ±5%",
      helpFrame: "Previous / next frame (approx. step, pauses)",
      helpRate: "Faster / slower by 0.1×",
      helpRateReset: "Reset to 1.0×",
      helpPercent: "Jump to 0%–90%",
      helpHelp: "Show / hide this help",
      helpMenu: "Right-click the video for the full menu.",
      helpFocus: "Shortcuts work while the player has focus: click the player first.",
      close: "Close",
    };

    // ---- addresses and URLs -------------------------------------------------

    /** Parse `dsh-resource://file/session/<id>/<path>`; other scopes carry no session. */
    function sessionFileOf(address) {
      try {
        if (typeof address !== "string" || !address.startsWith(FILE_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const [scope, id, ...segments] = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end).split("/");
        if (scope !== "session" || id === undefined || id === "" || segments.length === 0) return undefined;
        const path = segments.map(decodeURIComponent).join("/");
        if (path === "") return undefined;
        return { sessionId: decodeURIComponent(id), path };
      } catch {
        return undefined;
      }
    }

    function isVideoPath(path) {
      const dot = path.lastIndexOf(".");
      return dot > path.lastIndexOf("/") && EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
    }

    function basenameOfPath(path) {
      return path.slice(path.lastIndexOf("/") + 1) || path;
    }

    function basenameOf(address) {
      const file = sessionFileOf(address);
      return file === undefined ? address : basenameOfPath(file.path);
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
     * Base the stream route resolves against. In a browser the page base is the
     * Host itself; in the desktop shell `dsh-app://app/` forwards to the Host.
     * Staying same-origin keeps the login cookie and an untainted canvas for
     * screenshots.
     */
    function pageBase() {
      return typeof document !== "undefined" && document.baseURI ? directoryBase(document.baseURI) : undefined;
    }

    function streamUrl(base, file, extra) {
      const url = new URL(ROUTE, base);
      url.searchParams.set("sessionId", file.sessionId);
      url.searchParams.set("path", file.path);
      for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value);
      return url.href;
    }

    function messageForStatus(status, t) {
      if (status === 401) return t("unauthorized");
      if (status === 403) return t("forbidden");
      if (status === 404) return t("notFound");
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

    /** Resume-position key: absolute paths are shared across sessions; relative ones are per session. */
    function positionKey(file) {
      const path = file.path;
      if (/^[A-Za-z]:\//.test(path)) return `abs:${path.toLowerCase()}`;
      if (path.startsWith("/")) return `abs:${path}`;
      return `rel:${file.sessionId}:${path}`;
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

    // ---- styles -------------------------------------------------------------

    const CSS = `
.dvp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;outline:none}
.dvp-root:fullscreen{background:#000;color:#eee}
.dvp-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden}
.dvp-video{width:100%;height:100%;object-fit:contain;outline:none}
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

    // ---- body ---------------------------------------------------------------

    function VideoBody(props) {
      const { useTabInfo, t } = props;
      const { tab } = useTabInfo();
      const file = useMemo(() => sessionFileOf(tab.contentId ?? tab.navigation?.address), [tab.contentId, tab.navigation?.address]);
      const base = useMemo(pageBase, []);
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
      const posKey = file === undefined ? undefined : positionKey(file);
      const posKeyRef = useRef(posKey);
      posKeyRef.current = posKey;

      const src = file === undefined || base === undefined ? undefined : streamUrl(base, file, nonce === 0 ? undefined : { v: String(nonce) });
      const name = file === undefined ? "" : basenameOfPath(file.path);

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
        if (!video || paused || typeof video.requestVideoFrameCallback !== "function") return undefined;
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
      }, [paused, src]);

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

      if (file === undefined) {
        return h("div", { className: "dvp-root" },
          h("div", { className: "dvp-stage" }, h("p", { className: "dvp-error" }, t("noSession"))));
      }

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
          item(t("prevFrame"), ",", () => run("frame", -1)),
          item(t("nextFrame"), ".", () => run("frame", 1)),
          sep(),
          item(t("copyFrame"), "Ctrl+C", () => run("copyFrame")),
          item(t("saveFrame"), "Ctrl+S", () => run("saveFrame")),
          sep(),
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
          [", / .", t("helpFrame")],
          ["C / X", t("helpRate")],
          ["Z", t("helpRateReset")],
          ["0 – 9", t("helpPercent")],
          ["Home", t("restart")],
          ["F / Enter", t("fullscreen")],
          ["Ctrl + C", t("copyFrame")],
          ["Ctrl + S", t("saveFrame")],
          ["?", t("helpHelp")],
        ];
        return h("div", { className: "dvp-help", role: "presentation", onClick: () => setHelp(false) },
          h("div", { className: "dvp-help-card", role: "dialog", "aria-modal": "true", "aria-label": t("shortcuts"), onClick: (event) => event.stopPropagation() },
            h("table", null, h("tbody", null, ...rows.map(([keys, label]) => h("tr", null, h("td", null, h("kbd", null, keys)), h("td", null, label))))),
            h("p", null, t("helpMenu")),
            h("p", null, t("helpFocus")),
            h("p", { className: "dvp-help-actions" },
              h("button", { type: "button", onClick: () => { setHelp(false); focusRoot(); } }, t("close")))));
      };

      return h("div", { ref: rootRef, className: "dvp-root", tabIndex: 0, "data-video-preview": "", onKeyDownCapture: onKeyDown },
        h("div", { ref: stageRef, className: "dvp-stage", onContextMenu },
          error === undefined
            ? h("video", {
              key: src,
              ref: attachVideo,
              className: "dvp-video",
              src,
              controls: true,
              loop,
              controlsList: "nofullscreen",
              preload: "metadata",
              playsInline: true,
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
            })
            : h("p", { className: "dvp-error" }, error),
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
          h("button", { type: "button", title: `${t("copyFrame")} (Ctrl+C)`, onClick: () => run("copyFrame") }, t("screenshot")),
          h("button", { type: "button", onClick: () => run("help") }, t("shortcuts")),
          h("span", { className: "dvp-spacer" }),
          h("button", { type: "button", onClick: reload }, t("reload")),
          base === undefined ? null : h("a", { href: streamUrl(base, file, { download: "1" }), download: name }, t("download"))));
    }

    const inject = ["slots", "locale", "sidebarRightTabs"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => {
        // One stylesheet for every player tab, removed when the plugin unloads.
        const style = document.createElement("style");
        style.dataset.dshVideoPreview = "";
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "dsh-video-preview: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-video-preview: dictionaries");
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        patterns: PATTERNS,
        priority: "extension",
        canOpen: (address) => {
          const file = sessionFileOf(address);
          return file !== undefined && isVideoPath(file.path);
        },
        title: basenameOf,
        keepMounted: true,
      }), "dsh-video-preview: tab type");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: ID,
        locale: NS,
        inject: () => ({ t }),
      }, VideoBody)), "dsh-video-preview: tab body");
    }

    return {
      inject,
      apply,
      sessionFileOf,
      isVideoPath,
      PATTERNS,
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
