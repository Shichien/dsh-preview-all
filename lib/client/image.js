export default function createImageBody({ React, previewUrl, detailList }) {
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
}
