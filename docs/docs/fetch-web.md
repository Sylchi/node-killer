# Fetch and web bodies

Status: `fetch`, `Request`, `Response`, `Headers`, `Blob`, `File`,
`FormData` and `DOMException` are implemented in the JS bootstrap on top of
`node:http` / `node:https`. Response bodies are streamed from the socket;
the whole response is never buffered before `fetch()` resolves.

## Streaming responses

```js
const res = await fetch("https://example.com/big.bin");
const reader = res.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(value);
}
```

- `fetch()` resolves as soon as the response headers arrive.
- `res.body` is a `ReadableStream` backed by the socket. Data is pulled on
  demand, so an unread body does not accumulate in memory.
- `gzip` and `deflate` content encodings are inflated incrementally as
  chunks arrive. Other encodings are passed through untouched.
- `text()`, `json()`, `arrayBuffer()`, `bytes()`, `blob()` and `formData()`
  consume the stream and set `bodyUsed`. `clone()` tees the body.
- A `HEAD` request, `204` and `304` responses have `body === null`.

## Streaming requests

```js
const res = await fetch("https://example.com/upload", {
  method: "POST",
  body: new ReadableStream({
    pull(controller) {
      controller.enqueue(Buffer.from("chunk"));
      controller.close();
    },
  }),
  duplex: "half",
});
```

Streaming bodies require `duplex: "half"` and are sent with chunked transfer
encoding. `Blob`, `File`, `FormData`, `URLSearchParams`, strings, typed
arrays and `ArrayBuffer` bodies are buffered and sent with `content-length`.
`FormData` is serialized as `multipart/form-data` and `Response.formData()`
parses both multipart and `application/x-www-form-urlencoded` bodies.

## Supported API

- `fetch(input, init)` with `method`, `headers`, `body`, `signal`,
  `redirect` (`follow` / `manual`), `duplex`, `ca`, `rejectUnauthorized`.
- `Request` / `Response` body mixins, `clone()`, `Response.error()`,
  `Response.redirect()` and `Response.json()`.
- `Headers` (`append`, `set`, `get`, `has`, `delete`, iteration).
- `Blob` (`slice`, `text`, `arrayBuffer`, `bytes`, `stream`), `File` and
  `FormData` (including `File`/`Blob` values and optional filenames).
- `DOMException` and `AbortController` / `AbortSignal`, including
  `AbortSignal.timeout()` and `AbortSignal.any()`.
- `require("stream/consumers")`: `text`, `json`, `buffer`, `arrayBuffer`
  and `blob`.
- `require("buffer").Blob` and `require("buffer").File`.

`accept-encoding` defaults to `gzip, deflate`.

## Limits

- Redirects are followed up to 20 times. A redirect cannot replay a
  streaming request body; such requests fail with a `TypeError`.
- `brotli` (`br`) responses are not decoded; they are exposed as raw bytes.
- Request bodies are streamed in the order the consumer reads them; there is
  no HTTP/1.1 pipelining or HTTP/2 support.
- `cache`, `credentials`, `mode`, `referrer` and `keepalive` are accepted
  but ignored.
- `ReadableStream.from()` is used for async/sync iterable request bodies.
