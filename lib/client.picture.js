// GENERATED FILE — edit the sources, then run npm run build.
// Lazy chunk: fetched by lib/client.js the first time a picture file is opened.
window.__ModuleLoader__.load({
  id: "dsh-preview-all-in-one",
  chunk: "client.picture.js",
  factory: (require) => {
    // Source: lib/formats/picture/client.js
    const createPanel = function createPanel(services) {
      const { React, ImageBody } = services;
      const { createElement: h } = React;

      function PictureBody(props) {
        return h(ImageBody, { ...props, route: "picture", failureKey: "pictureFailed", detailsKey: "raster" });
      }

      return PictureBody;
    };

    return {
      kind: "picture",
      createPanel,
    };
  },
});
