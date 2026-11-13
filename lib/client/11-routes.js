/** Reserved routes plus format routes from the serialized catalog. */
const ROUTES = Object.fromEntries(
  ['info', 'download', ...FORMAT_DEFINITIONS.flatMap(({ routes }) => Object.keys(routes))]
    .map(route => [route, 'preview/' + route]),
);
