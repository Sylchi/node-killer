/* ------------------------------------------------------------------ */
/* crypto (hashes in JS, randomness from the OS)                      */
/* ------------------------------------------------------------------ */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++)
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

function padMessage(bytes, bigEndian) {
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const hi = Math.floor(bits / 4294967296) >>> 0;
  const lo = bits >>> 0;
  if (bigEndian) {
    m[total - 8] = hi >>> 24; m[total - 7] = (hi >>> 16) & 255;
    m[total - 6] = (hi >>> 8) & 255; m[total - 5] = hi & 255;
    m[total - 4] = lo >>> 24; m[total - 3] = (lo >>> 16) & 255;
    m[total - 2] = (lo >>> 8) & 255; m[total - 1] = lo & 255;
  } else {
    m[total - 8] = lo & 255; m[total - 7] = (lo >>> 8) & 255;
    m[total - 6] = (lo >>> 16) & 255; m[total - 5] = lo >>> 24;
    m[total - 4] = hi & 255; m[total - 3] = (hi >>> 8) & 255;
    m[total - 2] = (hi >>> 16) & 255; m[total - 1] = hi >>> 24;
  }
  return m;
}

function md5(bytes) {
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const m = padMessage(bytes, false);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = m[j] | (m[j + 1] << 8) | (m[j + 2] << 16) | (m[j + 3] << 24);
    }
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + MD5_K[i] + M[g]) | 0;
      B = (B + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) | 0;
      A = tmp;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const out = new Uint8Array(16);
  const words = [a, b, c, d];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      out[i * 4 + j] = (words[i] >>> (j * 8)) & 255;
  return out;
}

function sha1(bytes) {
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const m = padMessage(bytes, true);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe,
      h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const words = [h0, h1, h2, h3, h4];
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 4; j++)
      out[i * 4 + j] = (words[i] >>> (24 - j * 8)) & 255;
  return out;
}

const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const m = padMessage(bytes, true);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Int32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
                 ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
                 (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
                 ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
                 (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^
                 ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^
                 ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 4; j++)
      out[i * 4 + j] = (words[i] >>> (24 - j * 8)) & 255;
  return out;
}

function toBytes(data, encoding) {
  if (typeof data === "string")
    return Buffer.isBuffer(data) ? data : Buffer.from(data, encoding || "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer)
    return new Uint8Array(data);
  throw new TypeError("The data must be a string, Buffer or TypedArray");
}

/* One-shot digest for a canonical algorithm name. md5/sha1/sha256 have
   in-tree JS implementations; everything else (sha384/sha512) is delegated
   to mbedTLS through the native binding. */
function hashBytes(alg, data) {
  if (alg === "md5")
    return Buffer.from(md5(data));
  if (alg === "sha1")
    return Buffer.from(sha1(data));
  if (alg === "sha256")
    return Buffer.from(sha256(data));
  if (typeof native.digest === "function")
    return Buffer.from(native.digest(alg, data));
  throw new Error("Digest method not supported: " + alg);
}

/* HMAC block size is the digest's internal block size, not its output size.
   SHA-384/SHA-512 use 128-byte blocks; the rest use 64. */
const HMAC_BLOCK_SIZE = {
  md5: 64,
  sha1: 64,
  sha256: 64,
  sha384: 128,
  sha512: 128,
};

function hmacBytes(alg, key, data) {
  const blockSize = HMAC_BLOCK_SIZE[alg];
  if (!blockSize)
    throw new Error("Digest method not supported: " + alg);
  let k = Buffer.from(key);
  if (k.length > blockSize)
    k = hashBytes(alg, k);
  const pad = Buffer.alloc(blockSize);
  k.copy(pad);
  const ipad = Buffer.alloc(blockSize), opad = Buffer.alloc(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = pad[i] ^ 0x36;
    opad[i] = pad[i] ^ 0x5c;
  }
  const innerDigest = hashBytes(alg,
    Buffer.concat([ipad, Buffer.from(toBytes(data))]));
  return hashBytes(alg, Buffer.concat([opad, innerDigest]));
}

/* Streaming hash when no key is supplied, streaming HMAC otherwise. */
class Hash {
  constructor(algorithm, key) {
    this._alg = algorithm;
    this._key = key === undefined ? null : Buffer.from(key);
    this._parts = [];
    this._finished = false;
  }
  update(data, encoding) {
    if (this._finished)
      throw new Error("Digest already called");
    this._parts.push(Buffer.from(toBytes(data, encoding)));
    return this;
  }
  digest(encoding) {
    this._finished = true;
    const input = Buffer.concat(this._parts);
    const out = this._key === null ? hashBytes(this._alg, input)
                                   : hmacBytes(this._alg, this._key, input);
    return encoding ? out.toString(encoding) : out;
  }
  copy() {
    const h = new Hash(this._alg, this._key === null
                                 ? undefined : Buffer.from(this._key));
    h._parts = this._parts.slice();
    return h;
  }
}

const HASH_ALIASES = {
  md5: "md5", sha1: "sha1", "sha-1": "sha1", sha256: "sha256",
  "sha-256": "sha256", sha384: "sha384", "sha-384": "sha384",
  sha512: "sha512", "sha-512": "sha512",
};

function normalizeHashAlgorithm(algorithm) {
  const alg = HASH_ALIASES[String(algorithm).toLowerCase()];
  if (!alg)
    throw new Error("Digest method not supported: " + algorithm);
  return alg;
}

function createHash(algorithm) {
  return new Hash(normalizeHashAlgorithm(algorithm));
}

function createHmac(algorithm, key) {
  const alg = normalizeHashAlgorithm(algorithm);
  if (key === undefined || key === null)
    throw new TypeError("The \"key\" argument must be a string, Buffer, " +
                        "TypedArray, or DataView");
  return new Hash(alg, key);
}

/* ------------------------------------------------------------------ */
/* crypto: key objects, signatures and KDFs                           */
/* ------------------------------------------------------------------ */

const CRYPTO_CONSTANTS = {
  RSA_PKCS1_PADDING: 1,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_AUTO: -2,
  RSA_PSS_SALTLEN_MAX_SIGN: -3,
  RSA_PSS_SALTLEN_MAX: -3,
};

function normalizeCryptoAlgorithm(algorithm) {
  let a = String(algorithm).toLowerCase();
  let pss = false;
  if (a.endsWith("-pss")) {
    pss = true;
    a = a.slice(0, -4);
  }
  if (a === "rsa-pss") {
    pss = true;
    a = "sha1";
  }
  if (a.startsWith("rsa-"))
    a = a.slice(4);
  if (a.startsWith("ecdsa-with-"))
    a = a.slice(11);
  else if (a.startsWith("ecdsa-"))
    a = a.slice(6);
  a = HASH_ALIASES[a] || a;
  return { digest: a, pss };
}

function cryptoKeyBytes(key) {
  if (typeof key === "string")
    return Buffer.from(key, "utf8");
  if (Buffer.isBuffer(key))
    return key;
  return Buffer.from(toBytes(key));
}

function cryptoKeyOptions(key) {
  if (key instanceof KeyObject)
    return { keyObject: key };
  if (key && typeof key === "object" && !ArrayBuffer.isView(key) &&
      !(key instanceof ArrayBuffer) && "key" in key) {
    if (key.key instanceof KeyObject)
      return { keyObject: key.key, options: key };
    return { data: cryptoKeyBytes(key.key), passphrase: key.passphrase,
             format: key.format, options: key };
  }
  return { data: cryptoKeyBytes(key) };
}

class KeyObject {
  constructor(type, data, info) {
    this._type = type;
    this._data = Buffer.from(data);
    this._info = info || {};
  }
  get type() { return this._type; }
  get asymmetricKeyType() { return this._info.asymmetricKeyType; }
  get asymmetricKeyDetails() { return this._info.details; }
  get symmetricKeySize() {
    return this._type === "secret" ? this._data.length : undefined;
  }
  export(options) {
    options = options || {};
    if (this._type === "secret") {
      const format = options.format || "buffer";
      if (format === "buffer")
        return Buffer.from(this._data);
      throw new TypeError("Invalid format for secret key: " + format);
    }
    const format = options.format || "pem";
    if (format !== "pem" && format !== "der")
      throw new TypeError("Invalid key format: " + format);
    const type = options.type ||
      (this._type === "private" ? "pkcs8" : "spki");
    let kind;
    if (this._type === "private") {
      if (type === "pkcs8") kind = "pkcs8-" + format;
      else if (type === "pkcs1") kind = "pkcs1-" + format;
      else if (type === "sec1") kind = "sec1-" + format;
      else throw new TypeError("Invalid key type: " + type);
    } else {
      if (type === "spki") kind = "spki-" + format;
      else if (type === "pkcs1") kind = "pkcs1-public-" + format;
      else throw new TypeError("Invalid key type: " + type);
    }
    const out = Buffer.from(native.cryptoExportKey(this._data, "", kind));
    return format === "pem" ? out.toString("utf8") : out;
  }
  equals(other) {
    return other instanceof KeyObject && other._type === this._type &&
      other._data.equals(this._data);
  }
  toCryptoKey() {
    throw new Error("KeyObject.toCryptoKey is not supported");
  }
}
KeyObject.from = function(key) {
  if (key instanceof KeyObject)
    return key;
  return createSecretKey(key);
};

function createPrivateKey(key) {
  const ex = cryptoKeyOptions(key);
  if (ex.keyObject) {
    if (ex.keyObject.type !== "private")
      throw new TypeError("Key is not a private key");
    return ex.keyObject;
  }
  const info = native.cryptoKeyInfo(ex.data, ex.passphrase);
  if (info.type !== "private")
    throw new TypeError("Key is not a private key");
  const der = native.cryptoExportKey(ex.data, ex.passphrase, "pkcs8-der");
  return new KeyObject("private", der, info);
}

function createPublicKey(key) {
  const ex = cryptoKeyOptions(key);
  if (ex.keyObject && ex.keyObject.type === "public")
    return ex.keyObject;
  let data, passphrase;
  if (ex.keyObject) {
    data = ex.keyObject._data;
    passphrase = undefined;
  } else {
    data = ex.data;
    passphrase = ex.passphrase;
  }
  const der = native.cryptoExportKey(data, passphrase, "spki-der");
  const info = native.cryptoKeyInfo(der);
  return new KeyObject("public", der, info);
}

function createSecretKey(key, encoding) {
  let data;
  if (typeof key === "string")
    data = Buffer.from(key, encoding || "utf8");
  else
    data = Buffer.from(toBytes(key));
  return new KeyObject("secret", data, {});
}

function cryptoSignOptions(key) {
  if (key && typeof key === "object" && !(key instanceof KeyObject) &&
      !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer))
    return key;
  return {};
}

function cryptoCurveBytes(name) {
  switch (name) {
  case "prime256v1":
  case "secp256r1":
  case "secp256k1":
    return 32;
  case "secp384r1":
    return 48;
  case "secp521r1":
    return 66;
  default:
    return 0;
  }
}

function readDerLength(buf, pos) {
  let len = buf[pos++];
  if (len & 0x80) {
    let n = len & 0x7f;
    if (n === 0 || n > 4)
      throw new Error("Invalid DER length");
    len = 0;
    while (n--)
      len = (len << 8) | buf[pos++];
  }
  return { len, pos };
}

function ecdsaDerToP1363(der, size) {
  if (der[0] !== 0x30)
    throw new Error("Invalid ECDSA signature");
  let pos = readDerLength(der, 1).pos;
  const out = Buffer.alloc(size * 2);
  for (let i = 0; i < 2; i++) {
    if (der[pos] !== 0x02)
      throw new Error("Invalid ECDSA signature");
    const r = readDerLength(der, pos + 1);
    let value = der.subarray(r.pos, r.pos + r.len);
    while (value.length > size && value[0] === 0)
      value = value.subarray(1);
    if (value.length > size)
      throw new Error("Invalid ECDSA signature");
    out.set(value, i * size + size - value.length);
    pos = r.pos + r.len;
  }
  return out;
}

function ecdsaP1363ToDer(raw) {
  if (raw.length % 2 !== 0)
    throw new Error("Invalid ECDSA signature");
  const size = raw.length / 2;
  const encodeInt = (value) => {
    let i = 0;
    while (i < value.length - 1 && value[i] === 0)
      i++;
    value = value.subarray(i);
    if (value[0] & 0x80)
      value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([
    encodeInt(raw.subarray(0, size)),
    encodeInt(raw.subarray(size)),
  ]);
  let header;
  if (body.length < 128)
    header = Buffer.from([0x30, body.length]);
  else if (body.length <= 255)
    header = Buffer.from([0x30, 0x81, body.length]);
  else
    header = Buffer.from([0x30, 0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

function sign(algorithm, data, key) {
  const options = cryptoSignOptions(key);
  const ko = key instanceof KeyObject ? key : createPrivateKey(key);
  if (ko.type !== "private")
    throw new TypeError("Private key required");
  if (ko.asymmetricKeyType === "ed25519") {
    if (algorithm !== null && algorithm !== undefined)
      throw new TypeError("Invalid digest");
    return Buffer.from(native.cryptoSign("", toBytes(data), ko._data, false));
  }
  const algo = normalizeCryptoAlgorithm(algorithm);
  const pss = algo.pss ||
    options.padding === CRYPTO_CONSTANTS.RSA_PKCS1_PSS_PADDING;
  let sig = Buffer.from(native.cryptoSign(algo.digest, toBytes(data), ko._data,
                                          pss));
  if (options.dsaEncoding === "ieee-p1363" &&
      ko.asymmetricKeyType === "ec") {
    const size = cryptoCurveBytes(ko.asymmetricKeyDetails.namedCurve);
    if (!size)
      throw new Error("Unsupported curve");
    sig = ecdsaDerToP1363(sig, size);
  }
  return sig;
}

function verify(algorithm, data, key, signature) {
  const options = cryptoSignOptions(key);
  const ko = key instanceof KeyObject ? key : createPublicKey(key);
  if (ko.asymmetricKeyType === "ed25519") {
    if (algorithm !== null && algorithm !== undefined)
      throw new TypeError("Invalid digest");
    return native.cryptoVerify("", toBytes(data), ko._data,
                               toBytes(signature), false);
  }
  const algo = normalizeCryptoAlgorithm(algorithm);
  const pss = algo.pss ||
    options.padding === CRYPTO_CONSTANTS.RSA_PKCS1_PSS_PADDING;
  let sig = toBytes(signature);
  if (options.dsaEncoding === "ieee-p1363" &&
      ko.asymmetricKeyType === "ec")
    sig = ecdsaP1363ToDer(sig);
  return native.cryptoVerify(algo.digest, toBytes(data), ko._data, sig, pss);
}

class Sign {
  constructor(algorithm) {
    this._algorithm = algorithm;
    this._parts = [];
  }
  update(data, encoding) {
    this._parts.push(Buffer.from(toBytes(data, encoding)));
    return this;
  }
  sign(key, outputEncoding) {
    const sig = sign(this._algorithm, Buffer.concat(this._parts), key);
    if (typeof outputEncoding === "string")
      return sig.toString(outputEncoding);
    return sig;
  }
}

class Verify {
  constructor(algorithm) {
    this._algorithm = algorithm;
    this._parts = [];
  }
  update(data, encoding) {
    this._parts.push(Buffer.from(toBytes(data, encoding)));
    return this;
  }
  verify(key, signature, signatureEncoding) {
    let sig = signature;
    if (typeof sig === "string")
      sig = Buffer.from(sig, signatureEncoding || "hex");
    return verify(this._algorithm, Buffer.concat(this._parts), key,
                  toBytes(sig));
  }
}

function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  digest = digest || "sha1";
  return Buffer.from(native.cryptoPbkdf2(toBytes(password), toBytes(salt),
                                         iterations, keylen, digest));
}

function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  if (typeof digest === "function") {
    callback = digest;
    digest = "sha1";
  }
  if (typeof callback !== "function")
    throw new TypeError("Callback must be a function");
  queueMicrotask(() => {
    try {
      callback(null, pbkdf2Sync(password, salt, iterations, keylen, digest));
    } catch (e) {
      callback(e);
    }
  });
}

function scryptSync(password, salt, keylen, options) {
  options = options || {};
  const N = options.N !== undefined ? options.N
    : (options.cost !== undefined ? options.cost : 16384);
  const r = options.r !== undefined ? options.r
    : (options.blockSize !== undefined ? options.blockSize : 8);
  const p = options.p !== undefined ? options.p
    : (options.parallelization !== undefined ? options.parallelization : 1);
  const maxmem = options.maxmem !== undefined
    ? options.maxmem : 32 * 1024 * 1024;
  return Buffer.from(native.cryptoScrypt(toBytes(password), toBytes(salt),
                                         keylen, N, r, p, maxmem));
}

function scrypt(password, salt, keylen, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof callback !== "function")
    throw new TypeError("Callback must be a function");
  queueMicrotask(() => {
    try {
      callback(null, scryptSync(password, salt, keylen, options));
    } catch (e) {
      callback(e);
    }
  });
}

function hkdfSync(digest, ikm, salt, info, keylen) {
  return Buffer.from(native.cryptoHkdf(digest, toBytes(ikm),
    salt === undefined || salt === null ? undefined : toBytes(salt),
    info === undefined || info === null ? undefined : toBytes(info),
    keylen));
}

function hkdf(digest, ikm, salt, info, keylen, callback) {
  if (typeof callback !== "function")
    throw new TypeError("Callback must be a function");
  queueMicrotask(() => {
    try {
      callback(null, hkdfSync(digest, ikm, salt, info, keylen));
    } catch (e) {
      callback(e);
    }
  });
}

function generateKeyPairSync(type, options) {
  options = options || {};
  const t = String(type).toLowerCase();
  let bits, exponent, curve;
  if (t === "rsa" || t === "rsa-pss") {
    bits = options.modulusLength || 2048;
    exponent = options.publicExponent === undefined
      ? 65537 : Number(options.publicExponent);
  } else if (t === "ec") {
    curve = options.namedCurve || "prime256v1";
  } else if (t === "ed25519") {
  } else {
    throw new TypeError("Unsupported key type: " + type);
  }
  const r = native.cryptoGenerateKeyPair(t === "rsa-pss" ? "rsa" : t,
                                         bits, exponent, curve);
  const privBytes = Buffer.from(r.privateKey);
  const pubBytes = Buffer.from(r.publicKey);
  const pubInfo = native.cryptoKeyInfo(pubBytes);
  const privInfo = { type: "private",
                     asymmetricKeyType: pubInfo.asymmetricKeyType,
                     details: pubInfo.details };
  return {
    publicKey: new KeyObject("public", pubBytes, pubInfo),
    privateKey: new KeyObject("private", privBytes, privInfo),
  };
}

function generateKeyPair(type, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof callback !== "function")
    throw new TypeError("Callback must be a function");
  queueMicrotask(() => {
    try {
      const pair = generateKeyPairSync(type, options);
      callback(null, pair.publicKey, pair.privateKey);
    } catch (e) {
      callback(e);
    }
  });
}

const crypto = {
  createHash,
  createHmac,
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  sign,
  verify,
  createSign(algorithm) { return new Sign(algorithm); },
  createVerify(algorithm) { return new Verify(algorithm); },
  generateKeyPair,
  generateKeyPairSync,
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
  hkdf,
  hkdfSync,
  constants: CRYPTO_CONSTANTS,
  randomBytes(size, cb) {
    const b = Buffer.from(native.randomBytes(size));
    if (cb) { queueMicrotask(() => cb(null, b)); return undefined; }
    return b;
  },
  randomFillSync(buf, offset, size) {
    offset = offset || 0;
    size = size === undefined ? buf.length - offset : size;
    const b = Buffer.from(native.randomBytes(size));
    b.copy(buf, offset);
    return buf;
  },
  randomFill(buf, offset, size, cb) {
    if (typeof offset === "function") { cb = offset; offset = 0; size = buf.length; }
    queueMicrotask(() => {
      try { crypto.randomFillSync(buf, offset, size); cb(null, buf); }
      catch (e) { cb(e); }
    });
  },
  randomUUID() {
    const b = Buffer.from(native.randomBytes(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = hexEncode(b, 0, 16);
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) +
      "-" + h.slice(16, 20) + "-" + h.slice(20);
  },
  randomInt(min, max, cb) {
    if (max === undefined) { max = min; min = 0; }
    const range = max - min;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) ||
        range <= 0 || range > 2 ** 48)
      throw new RangeError("The value of \"max - min\" is out of range");
    /* Rejection sampling: 48 random bits, discarding the biased tail so
       every value in [min, max) is equally likely. */
    const limit = Math.floor(2 ** 48 / range) * range;
    let v;
    do {
      v = 0;
      for (const x of native.randomBytes(6))
        v = v * 256 + x;
    } while (v >= limit);
    const n = min + (v % range);
    if (cb) { queueMicrotask(() => cb(null, n)); return undefined; }
    return n;
  },
  timingSafeEqual(a, b) {
    a = Buffer.from(a); b = Buffer.from(b);
    if (a.length !== b.length)
      throw new RangeError("Input buffers must have the same byte length");
    let r = 0;
    for (let i = 0; i < a.length; i++)
      r |= a[i] ^ b[i];
    return r === 0;
  },
  getRandomValues(arr) {
    const bytes = native.randomBytes(arr.byteLength);
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
      .set(Buffer.from(bytes));
    return arr;
  },
};

/* Web Crypto API classes */
class CryptoKey {
  constructor(type, extractable, algorithm, usages, keyData) {
    this.type = type;
    this.extractable = extractable;
    this.algorithm = algorithm;
    this.usages = usages;
    this._keyData = keyData;
  }
}

class SubtleCrypto {
  async digest(algorithm, data) {
    if (typeof algorithm === "string") {
      algorithm = { name: algorithm };
    }
    const algo = algorithm.name.toLowerCase().replace("-", "");
    const hashFn = {
      "sha1": sha1,
      "sha256": (bytes) => {
        const h = createHash("sha256");
        h.update(Buffer.from(bytes));
        return h.digest();
      },
      "sha384": (bytes) => {
        const h = createHash("sha384");
        h.update(Buffer.from(bytes));
        return h.digest();
      },
      "sha512": (bytes) => {
        const h = createHash("sha512");
        h.update(Buffer.from(bytes));
        return h.digest();
      },
    }[algo];
    
    if (!hashFn) {
      throw new Error("Unsupported algorithm: " + algorithm.name);
    }
    
    const input = data instanceof ArrayBuffer 
      ? new Uint8Array(data)
      : data;
    const result = hashFn(input);
    const buffer = new ArrayBuffer(result.length);
    new Uint8Array(buffer).set(result);
    return buffer;
  }

  async encrypt(algorithm, key, data) {
    throw new Error("encrypt() not yet implemented");
  }

  async decrypt(algorithm, key, data) {
    throw new Error("decrypt() not yet implemented");
  }

  async sign(algorithm, key, data) {
    throw new Error("sign() not yet implemented");
  }

  async verify(algorithm, key, signature, data) {
    throw new Error("verify() not yet implemented");
  }

  async generateKey(algorithm, extractable, keyUsages) {
    throw new Error("generateKey() not yet implemented");
  }

  async deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages) {
    throw new Error("deriveKey() not yet implemented");
  }

  async deriveBits(algorithm, baseKey, length) {
    throw new Error("deriveBits() not yet implemented");
  }

  async importKey(format, keyData, algorithm, extractable, keyUsages) {
    if (format !== "raw") {
      throw new Error("importKey() only supports 'raw' format currently");
    }
    return new CryptoKey("secret", extractable, algorithm, keyUsages, keyData);
  }

  async exportKey(format, key) {
    if (format !== "raw") {
      throw new Error("exportKey() only supports 'raw' format currently");
    }
    if (!key.extractable) {
      throw new Error("Key is not extractable");
    }
    return key._keyData;
  }

  async wrapKey(format, key, wrappingKey, wrapAlgorithm) {
    throw new Error("wrapKey() not yet implemented");
  }

  async unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, keyUsages) {
    throw new Error("unwrapKey() not yet implemented");
  }
}

crypto.webcrypto = {};
crypto.webcrypto.getRandomValues = crypto.getRandomValues;
crypto.webcrypto.randomUUID = crypto.randomUUID;
crypto.webcrypto.subtle = new SubtleCrypto();
crypto.webcrypto.CryptoKey = CryptoKey;
crypto.webcrypto.SubtleCrypto = SubtleCrypto;

