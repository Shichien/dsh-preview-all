export default function createPanel(services) {
  const { React, ImageBody } = services;
  const { createElement: h } = React;

  function RasterBody(props) {
    return h(ImageBody, { ...props, route: "raster", failureKey: "rasterFailed", detailsKey: "raster" });
  }

  return RasterBody;
}
