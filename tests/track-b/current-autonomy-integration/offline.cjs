// Verification must not open an outbound socket, even with inherited local credentials.
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === 'object' ? first.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) throw Error('Offline verification blocked socket to ' + host);
  return connect.apply(this, args);
};
// Fetch is guarded as well: mocked fixtures never need remote HTTP.
const fetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Offline verification blocked fetch to ' + url.hostname);
  return fetch(input, options);
};
