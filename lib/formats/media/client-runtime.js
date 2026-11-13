/** Self-contained media helpers, serializable with the panel factories. */
export default function createMediaRuntime() {
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

  return {
    RATE_MIN,
    RATE_MAX,
    RATE_STEP,
    RATE_PRESETS,
    SEEK_SMALL,
    SEEK_LARGE,
    VOLUME_STEP,
    STORE_PREFS,
    STORE_POSITIONS,
    MAX_POSITIONS,
    RESUME_MIN,
    RESUME_TAIL,
    SAVE_EVERY,
    clampRate,
    formatRate,
    formatTime,
    positionKey,
    readJson,
    writeJson,
    savePrefs,
    loadPosition,
    storePosition,
    keyCommand,
    frameBlob,
    downloadBlob,
    playWithFeedback,
    clampTime,
  };
}
