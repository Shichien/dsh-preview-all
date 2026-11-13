// GENERATED FILE — edit the sources, then run npm run build.
// Lazy chunk: fetched by lib/client.js the first time a archive file is opened.
window.__ModuleLoader__.load({
  id: "dsh-preview-all",
  chunk: "client.archive.js",
  factory: (require) => {
    // Source: lib/formats/archive/client.js
    const createPanel = function createPanel(services) {
      const { React, previewUrl, messageForStatus, statusPanel, formatSize } = services;
      const { createElement: h, useEffect, useMemo, useRef, useState } = React;
      /** Rows rendered before asking for a narrower filter. */
      const MAX_ROWS = 2000;

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

      return ArchiveBody;
    };

    return {
      kind: "archive",
      createPanel,
    };
  },
});
