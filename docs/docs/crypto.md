# Crypto

Status: KDFs, signatures and asymmetric key handling are implemented on top
of the vendored mbedTLS library. Ed25519 uses the vendored libsodium
library. SHA-256 and below use the in-tree JS implementations; SHA-384 and
SHA-512 are provided by mbedTLS.

## Hashes and HMACs

```js
const digest = crypto.createHash("sha512").update("data").digest("hex");
const mac = crypto.createHmac("sha256", "key").update("data").digest();
```

- `createHash(algorithm)` and `createHmac(algorithm, key)` support `md5`,
  `sha1`, `sha256`, `sha384`, `sha512` and their hyphenated aliases.
- Both return streaming objects with `update()` and `digest()`. Unknown
  algorithms throw `Error`.

## Key derivation

```js
const crypto = require("crypto");

const key = crypto.pbkdf2Sync("password", "salt", 210000, 32, "sha256");
const scryptKey = crypto.scryptSync("password", "salt", 32, {
  N: 16384,
  r: 8,
  p: 1,
});
const hkdfKey = crypto.hkdfSync("sha256", ikm, salt, info, 32);
```

- `pbkdf2Sync(password, salt, iterations, keylen, digest)` and the callback
  form `pbkdf2(...)`.
- `scryptSync(password, salt, keylen, options)` and `scrypt(...)`. `options`
  supports `N`/`cost`, `r`/`blockSize`, `p`/`parallelization` and `maxmem`.
- `hkdfSync(digest, ikm, salt, info, keylen)` and `hkdf(...)`.

Passwords, salts and other inputs accept strings, `Buffer`s, typed arrays
and `ArrayBuffer`s. String inputs are encoded as UTF-8.

## Signatures

```js
const { publicKey, privateKey } =
  crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const signature = crypto.sign("sha256", data, privateKey);
const ok = crypto.verify("sha256", data, publicKey, signature);
```

- `sign(algorithm, data, key)` and `verify(algorithm, data, key, signature)`.
  The algorithm can be `sha256`, `sha384`, `sha512`, `RSA-SHA256`,
  `ecdsa-with-SHA256` and similar spellings.
- `createSign(algorithm)` / `createVerify(algorithm)` support incremental
  `update()` calls and `sign()` / `verify()`.
- RSA keys use PKCS#1 v1.5 by default. Set
  `padding: crypto.constants.RSA_PKCS1_PSS_PADDING` for RSA-PSS.
- ECDSA signatures are DER encoded. Pass `dsaEncoding: "ieee-p1363"` for
  raw `r || s` signatures.
- RSA and EC keys are supported. Ed25519 uses a `null` algorithm:

```js
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const signature = crypto.sign(null, data, privateKey);
const ok = crypto.verify(null, data, publicKey, signature);
```

- Ed448 is not supported.

## Key objects

```js
const privateKey = crypto.createPrivateKey(pem);
const publicKey = crypto.createPublicKey(privateKey);
const pemAgain = privateKey.export({ type: "pkcs8", format: "pem" });
const der = publicKey.export({ type: "spki", format: "der" });
```

- `createPrivateKey(key)` and `createPublicKey(key)` accept PEM/DER data,
  `KeyObject`s, or `{ key, format, type, passphrase }` option objects.
  Traditional encrypted PEM (`Proc-Type: 4,ENCRYPTED`) is decrypted with
  the supplied `passphrase`.
- `createSecretKey(key)` and `KeyObject.from(value)` create secret keys.
- `KeyObject` exposes `type`, `asymmetricKeyType`, `asymmetricKeyDetails`,
  `symmetricKeySize`, `export()` and `equals()`.
- Private keys export as PKCS#8 by default; public keys export as SPKI.
  `pkcs1` (RSA) and `sec1` (EC) are also supported.
- `generateKeyPairSync(type, options)` and `generateKeyPair(...)` support
  `rsa` (with `modulusLength` and `publicExponent`), `ec` (with
  `namedCurve`) and `ed25519`. Supported curves are `prime256v1`/`secp256r1`,
  `secp384r1`, `secp521r1` and `secp256k1`.

## Limits

- Ed448, X25519 and X448 keys are not supported.
- JWK import/export and WebCrypto `subtle` are not implemented.
- Cipher, Diffie-Hellman and certificate APIs are not implemented.
- Async KDF and key-generation functions run the work synchronously and
  deliver the result on the next microtask.
