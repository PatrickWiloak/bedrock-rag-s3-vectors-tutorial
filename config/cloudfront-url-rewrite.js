// CloudFront viewer-request function (cloudfront-js-2.0 runtime).
// Maps clean URLs onto the objects a Next.js static export actually writes,
// and leaves /api/* alone so the streaming Lambda origin is reached.
// Shared by lib/web-hosting-construct.ts (CDK) and terraform/cloudfront.tf.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Never rewrite the API path - that origin is the streaming Lambda.
  if (uri.indexOf('/api/') === 0) return request;

  // "/foo/" -> "/foo/index.html"
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  // No file extension means an HTML route: "/foo" -> "/foo/index.html"
  if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) {
    request.uri = uri + '/index.html';
  }

  return request;
}
