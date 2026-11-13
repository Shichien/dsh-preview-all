// GENERATED FILE — edit the sources, then run npm run build.
// Lazy chunk: fetched by lib/client.js the first time a media file is opened.
window.__ModuleLoader__.load({
  id: "dsh-preview-all-in-one",
  chunk: "client.media.js",
  factory: (require) => {
    // Source: lib/formats/media/client-css.js
    const css = ".dvp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;outline:none}\n.dvp-root:fullscreen{background:#000;color:#eee}\n.dvp-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden}\n.dvp-video{width:100%;height:100%;object-fit:contain;outline:none}\n.dvp-audio{width:100%;max-width:520px;outline:none}\n.dvp-notice{position:absolute;top:0;left:0;right:0;z-index:2;margin:0;padding:8px 10px;background:rgba(120,86,20,.92);color:#fff;font-size:12px;line-height:1.55}\n.dvp-notice a{color:#fff}\n.dvp-error{padding:16px;font-size:13px;line-height:1.6;color:#ddd;text-align:center;max-width:420px}\n.dvp-osd{position:absolute;top:12px;left:12px;padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.68);color:#fff;font-size:13px;pointer-events:none;font-variant-numeric:tabular-nums}\n.dvp-resume{position:absolute;left:12px;bottom:64px;display:flex;gap:10px;align-items:center;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.75);color:#fff;font-size:12px}\n.dvp-resume button{background:none;border:none;padding:0;color:inherit;font:inherit;cursor:pointer;text-decoration:underline}\n.dvp-menu{position:absolute;z-index:5;min-width:212px;max-height:calc(100% - 8px);overflow-y:auto;padding:4px;box-sizing:border-box;border-radius:8px;background:rgba(32,32,34,.97);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.45);color:#eee;font-size:12.5px}\n.dvp-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:5px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}\n.dvp-item:hover,.dvp-item:focus-visible{background:rgba(255,255,255,.1);outline:none}\n.dvp-check{flex:0 0 12px;width:12px;text-align:center}\n.dvp-label{flex:1 1 auto}\n.dvp-hint{opacity:.55;font-size:11.5px}\n.dvp-sep{height:1px;margin:4px 6px;background:rgba(255,255,255,.12)}\n.dvp-section{padding:4px 8px 2px;opacity:.65;font-size:11.5px}\n.dvp-chips{display:flex;flex-wrap:wrap;gap:4px;padding:4px 6px;max-width:220px}\n.dvp-chip{min-width:40px;padding:3px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.16);background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer;font-variant-numeric:tabular-nums}\n.dvp-chip:hover{background:rgba(255,255,255,.1)}\n.dvp-chip[aria-pressed=\"true\"]{background:rgba(90,150,255,.35);border-color:rgba(120,170,255,.75)}\n.dvp-help{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)}\n.dvp-help-card{max-width:calc(100% - 24px);max-height:calc(100% - 24px);overflow:auto;padding:12px 16px;box-sizing:border-box;border-radius:8px;background:rgba(32,32,34,.97);border:1px solid rgba(255,255,255,.12);color:#eee;font-size:12.5px}\n.dvp-help-card table{border-collapse:collapse}\n.dvp-help-card td{padding:3px 12px 3px 0;vertical-align:top}\n.dvp-help-card kbd{font-family:inherit;padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06);font-size:11.5px;white-space:nowrap}\n.dvp-help-card p{margin:8px 0 0;opacity:.75}\n.dvp-help-card .dvp-help-actions{margin-top:10px;text-align:right;opacity:1}\n.dvp-help-card .dvp-help-actions button{padding:3px 12px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:inherit;font:inherit;font-size:12px;cursor:pointer}\n.dvp-help-card .dvp-help-actions button:hover{background:rgba(255,255,255,.16)}\n.dvp-bar{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:6px 10px;font-size:12px;opacity:.85}\n.dvp-bar button,.dvp-bar a{background:none;border:none;padding:0;color:inherit;cursor:pointer;text-decoration:underline;font:inherit}\n.dvp-bar .dvp-rate{text-decoration:none;border:1px solid currentColor;border-radius:4px;padding:0 6px;font-variant-numeric:tabular-nums}\n.dvp-spacer{flex:1 1 auto}";

    // Source: lib/formats/media/client-runtime.js
    const runtime = (function createMediaRuntime() {
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
    })();

    // Source: lib/formats/media/client.js
    const createPanel = function createPanel(services) {
      const { React, previewUrl, messageForStatus, basenameOfPath, stemOf, runtime } = services;
      const { createElement: h, useCallback, useEffect, useLayoutEffect, useRef, useState } = React;
      const {
        RATE_STEP,
        RATE_PRESETS,
        SEEK_SMALL,
        STORE_PREFS,
        RESUME_MIN,
        RESUME_TAIL,
        SAVE_EVERY,
        clampRate,
        formatRate,
        formatTime,
        positionKey,
        readJson,
        savePrefs,
        loadPosition,
        storePosition,
        keyCommand,
        frameBlob,
        downloadBlob,
        playWithFeedback,
        clampTime,
      } = runtime;

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

        // Switching away (another tab selected, sidebar collapsed, session switched)
        // keeps playing: the tab type is kept mounted so audio carries on in the
        // background. Only the overlays close, and the position is saved.
        useEffect(() => {
          if (tab.visible !== false) return;
          savePosition(videoRef.current);
          setMenu(undefined);
          setHelp(false);
        }, [tab.visible, savePosition]);

        // Closing the tab is what stops playback. The element is released when this
        // component unmounts (see attachVideo); the tab's own signal is honoured as
        // well, so playback ends even if the body outlives the close for a moment.
        useEffect(() => {
          const signal = tab.signal;
          if (signal === undefined) return undefined;
          const stop = () => {
            const video = videoRef.current;
            if (!video) return;
            savePosition(video);
            video.pause();
          };
          if (signal.aborted) {
            stop();
            return undefined;
          }
          signal.addEventListener("abort", stop, { once: true });
          return () => signal.removeEventListener("abort", stop);
        }, [tab.signal, savePosition]);

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

      return MediaBody;
    };

    return {
      kind: "media",
      css,
      runtime,
      createPanel: (services) => createPanel({ ...services, runtime }),
    };
  },
});
