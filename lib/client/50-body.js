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
