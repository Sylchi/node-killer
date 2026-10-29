# WebSocket

Status: implemented in the JS bootstrap. `node:websocket` exports a WHATWG
`WebSocket` client and a Node-style `WebSocketServer` implementing RFC 6455.
A global `WebSocket` is also installed for browser-style code.

The implementation is built on `node:http`, `node:net` and `node:tls`; it does
not add a native dependency. Client and server work over kernel sockets and
over the owned TCP stack (`netstack: true` / managed IPv6 addresses), see
`docs/netstack.md`.

## Client

```js
const { WebSocket } = require("node:websocket");

const ws = new WebSocket("ws://127.0.0.1:8080/chat", ["chat", "v2"]);

ws.addEventListener("open", () => {
  ws.send("hello");
  ws.send(new Uint8Array([1, 2, 3]));
});

ws.addEventListener("message", (event) => {
  if (typeof event.data === "string")
    console.log("text:", event.data);
  else
    console.log("binary:", event.data);
});

ws.addEventListener("close", (event) => {
  console.log(event.code, event.reason, event.wasClean);
});
```

`ws://` uses `net.connect()`; `wss://` uses `tls.connect()` with the hostname
as SNI. The URL, host header, query string and default ports are handled the
same way as in browsers.

Node-style listeners are also supported (`on`, `once`, `off`,
`removeListener`). The `message` listener receives `(data, isBinary)`:

```js
ws.on("message", (data, isBinary) => {
  console.log(isBinary, data);
});
```

Client API:

| Member | Behaviour |
| --- | --- |
| `new WebSocket(url, protocols)` | `protocols` may be a string or an array; the server's selection is copied to `ws.protocol`. |
| `readyState` | `CONNECTING`, `OPEN`, `CLOSING`, `CLOSED` (also available as static properties). |
| `send(data)` | Text for strings, binary for `Buffer`, `ArrayBuffer`, typed-array views and `Blob`; returns immediately and queues the frame. |
| `close(code, reason)` | Sends a close frame, waits briefly for the peer, then closes. Invalid codes or a reason over 123 bytes throw `RangeError`. |
| `terminate()` | Drops the connection without a close handshake. |
| `ping(data)` / `pong(data)` | Control frames, payload at most 125 bytes. |
| `binaryType` | `"blob"` (default), `"arraybuffer"` or `"nodebuffer"`. |
| `bufferedAmount` | Bytes handed to the socket but not yet written. |
| `extensions` | Reflects the server header; no extension is negotiated by this implementation. |

## Server

Attach to an existing HTTP/HTTPS server:

```js
const http = require("node:http");
const { WebSocketServer } = require("node:websocket");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("HTTP still works\n");
});

const wss = new WebSocketServer({
  server,
  protocols: ["chat", "v2"],
  handleProtocols(offered, req) {
    return offered.has("v2") ? "v2" : "";
  },
});

wss.on("connection", (ws, req) => {
  ws.on("message", (data, isBinary) => {
    ws.send(isBinary ? data : "echo: " + data);
  });
});

server.listen(8080);
```

Or let it create a listener:

```js
const wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });

wss.on("connection", (ws) => ws.send("welcome"));
wss.on("listening", () => console.log("ws ready"));
```

Options:

| Option | Meaning |
| --- | --- |
| `server` | Attach to an existing `http.Server`/`https.Server` (uses its `'upgrade'` event) or to a `net.Server` (parses the handshake itself). |
| `port`, `host` | Create an internal `net.Server` instead of attaching. |
| `noServer` | Do not attach; the application calls `handleUpgrade()`. |
| `protocols` | String or array of accepted subprotocols. The first client-offered protocol that is in this list is selected. |
| `handleProtocols(offered, req)` | Custom selection; return a protocol string or a falsy value for none. |

Server API:

- `wss.handleUpgrade(req, socket, head, cb)` performs the HTTP upgrade
  manually when using `noServer`.
- `wss.clients` is a `Set` of live server-side sockets.
- `wss.address()` mirrors the underlying server.
- `wss.close([cb])` terminates clients, detaches listeners and closes an
  internally created server.
- Events: `connection(ws, req)`, `listening`, `close`, `error`.

The server sends `400 Bad Request` for malformed upgrades and
`426 Upgrade Required` with `Sec-WebSocket-Version: 13` for the wrong version.
HTTP `GET` upgrades with `Upgrade: websocket` and
`Connection: Upgrade` are accepted; other methods are rejected.

## Events and framing

Both `EventTarget` events and Node listeners are emitted:

- `open` (`Event`)
- `message` (`MessageEvent`; Node listener gets `(data, isBinary)`)
- `error` (`Event` with `.error`/`.message`; Node listener gets the `Error`)
- `close` (`WebSocketCloseEvent` with `code`, `reason`, `wasClean`)
- `ping` / `pong` (`Event` with a `Buffer` in `.data`)

The implementation validates client masking (required), server masking
(forbidden), RSV bits, control-frame length, close codes and UTF-8 close
reasons. Fragmented messages are reassembled; control frames may appear
between fragments. Pings are answered automatically.

## Limits

- No `permessage-deflate` or other extension negotiation. `Sec-WebSocket-
  Extensions` is not offered by the client, and `ws.extensions` will be empty.
- No HTTP/2 WebSocket bootstrapping.
- Server-side TLS works through `https.Server`/`tls.Server`; the client uses
  the runtime's normal certificate validation and does not expose a custom
  `ca` option on `WebSocket` yet.
- The close handshake has a 2 second unref'd timeout. If the peer never
  answers, the socket is closed as `1006`.
- The server buffers the HTTP handshake until `\r\n\r\n` arrives; there is no
  configurable header-size limit beyond normal buffer growth.

## Testing

```sh
make qnode-test
```

`tests/qnode/websocket.js` covers client/server echoing over an HTTP upgrade,
a standalone server, raw `net.Server` attachment, manual `noServer`
`handleUpgrade()`, text, `Buffer`, typed-array and `Blob` payloads,
subprotocol selection, fragmented messages, ping/pong, close codes and a
failed handshake. It runs with `qnode`, not `qjs`.
