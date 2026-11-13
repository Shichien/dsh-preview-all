// GENERATED FILE — edit the sources, then run npm run build.
// Lazy chunk: fetched by lib/client.js the first time a font file is opened.
window.__ModuleLoader__.load({
  id: "dsh-preview-all-in-one",
  chunk: "client.font.js",
  factory: (require) => {
    // Source: lib/formats/font/client.js
    const createPanel = function createPanel(services) {
      const { React, previewUrl, detailList } = services;
      const { createElement: h, useEffect, useMemo, useState } = React;

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

      return FontBody;
    };

    return {
      kind: "font",
      createPanel,
    };
  },
});
