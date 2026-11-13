// GENERATED FILE — edit the sources, then run npm run build.
// Lazy chunk: fetched by lib/client.js the first time a raster file is opened.
window.__ModuleLoader__.load({
  id: "dsh-preview-all",
  chunk: "client.raster.js",
  factory: (require) => {
    // Source: lib/formats/raster/client.js
    const createPanel = function createPanel(services) {
      const { React, ImageBody } = services;
      const { createElement: h } = React;

      function RasterBody(props) {
        return h(ImageBody, { ...props, route: "raster", failureKey: "rasterFailed", detailsKey: "raster" });
      }

      return RasterBody;
    };

    return {
      kind: "raster",
      createPanel,
    };
  },
});
