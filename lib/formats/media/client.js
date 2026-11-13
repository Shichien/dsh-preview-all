export default function createPanel(services) {
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

    return h("div", { ref: rootRef, className: "dvp-root", tabIndex: 0, "data-preview-all": "", onKeyDownCapture: onKeyDown },
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
}
