export default function createPanel(services) {
  const { React, ImageBody } = services;
  const { createElement: h } = React;

  function PictureBody(props) {
    return h(ImageBody, { ...props, route: "picture", failureKey: "pictureFailed", detailsKey: "raster" });
  }

  return PictureBody;
}
