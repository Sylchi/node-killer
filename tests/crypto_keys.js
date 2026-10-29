/* Crypto KDFs, signatures and KeyObject support. Run with qnode. */
"use strict";

const assert = require("assert");
const crypto = require("crypto");

const hex = (b) => Buffer.from(b).toString("hex");

function cryptoCurveBytesForTest(name) {
  if (name === "secp384r1") return 48;
  if (name === "secp521r1") return 66;
  return 32;
}

function testPbkdf2() {
  assert.strictEqual(
    hex(crypto.pbkdf2Sync("password", "salt", 1, 32, "sha256")),
    "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
  assert.strictEqual(
    hex(crypto.pbkdf2Sync("password", "salt", 2, 20, "sha1")),
    "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");
  /* Buffers and typed arrays are accepted too. */
  assert.strictEqual(
    hex(crypto.pbkdf2Sync(Buffer.from("password"), Buffer.from("salt"), 1,
                          32, "sha256")),
    "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
}

function testHkdf() {
  /* RFC 5869 test case 1. */
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = Buffer.from("000102030405060708090a0b0c", "hex");
  const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
  assert.strictEqual(
    hex(crypto.hkdfSync("sha256", ikm, salt, info, 42)),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
    "34007208d5b887185865");

  /* Missing salt and info are allowed. */
  const a = crypto.hkdfSync("sha256", "ikm", undefined, undefined, 16);
  const b = crypto.hkdfSync("sha256", "ikm", Buffer.alloc(0), Buffer.alloc(0), 16);
  assert.strictEqual(hex(a), hex(b));
}

function testScrypt() {
  /* RFC 7914 test vector. */
  assert.strictEqual(
    hex(crypto.scryptSync("", "", 64, { N: 16, r: 1, p: 1 })),
    "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" +
    "fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906");
  assert.strictEqual(
    hex(crypto.scryptSync("password", "NaCl", 64,
                          { N: 1024, r: 8, p: 16 })),
    "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162" +
    "2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640");
  assert.throws(() => crypto.scryptSync("p", "s", 16, { N: 1 << 20, r: 8 }),
                RangeError);
}

function assertRoundTrip(privateKey, publicKey, algorithm) {
  const data = Buffer.from("the quick brown fox");
  const sig = crypto.sign(algorithm, data, privateKey);
  assert.strictEqual(crypto.verify(algorithm, data, publicKey, sig), true);
  assert.strictEqual(
    crypto.verify(algorithm, Buffer.from("the quick brown fix"), publicKey, sig),
    false);
  return sig;
}

function testRsa() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  assert.strictEqual(privateKey.type, "private");
  assert.strictEqual(publicKey.type, "public");
  assert.strictEqual(privateKey.asymmetricKeyType, "rsa");
  assert.strictEqual(privateKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.strictEqual(privateKey.asymmetricKeyDetails.publicExponent, 65537);

  assertRoundTrip(privateKey, publicKey, "sha256");
  assertRoundTrip(privateKey, publicKey, "RSA-SHA384");

  const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.ok(pkcs8.startsWith("-----BEGIN PRIVATE KEY-----"));
  const spki = publicKey.export({ type: "spki", format: "pem" });
  assert.ok(spki.startsWith("-----BEGIN PUBLIC KEY-----"));

  const imported = crypto.createPrivateKey(pkcs8);
  assert.ok(imported.equals(privateKey));
  const importedPub = crypto.createPublicKey(spki);
  assert.ok(importedPub.equals(publicKey));
  assertRoundTrip(imported, importedPub, "sha256");

  /* createPublicKey derives the public half of a private key. */
  assert.ok(crypto.createPublicKey(privateKey).equals(publicKey));

  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" });
  assert.ok(pkcs1.startsWith("-----BEGIN RSA PRIVATE KEY-----"));
  const pkcs1der = privateKey.export({ type: "pkcs1", format: "der" });
  assert.ok(Buffer.isBuffer(pkcs1der));
  assert.ok(crypto.createPrivateKey({ key: pkcs1der, format: "der",
                                      type: "pkcs1" }));

  const rsaPub = publicKey.export({ type: "pkcs1", format: "pem" });
  assert.ok(rsaPub.startsWith("-----BEGIN RSA PUBLIC KEY-----"));
  assertRoundTrip(privateKey, crypto.createPublicKey(rsaPub), "sha256");

  /* RSA-PSS with an explicit padding mode. */
  const pss = crypto.sign("sha256", "pss message", {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  });
  assert.strictEqual(crypto.verify("sha256", "pss message", {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  }, pss), true);
}

function testEc() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  assert.strictEqual(privateKey.asymmetricKeyType, "ec");
  assert.strictEqual(privateKey.asymmetricKeyDetails.namedCurve,
                     "prime256v1");

  assertRoundTrip(privateKey, publicKey, "sha256");
  assertRoundTrip(privateKey, publicKey, "ecdsa-with-SHA256");

  const sec1 = privateKey.export({ type: "sec1", format: "pem" });
  assert.ok(sec1.startsWith("-----BEGIN EC PRIVATE KEY-----"));
  assertRoundTrip(crypto.createPrivateKey(sec1), publicKey, "sha256");

  const sec1der = privateKey.export({ type: "sec1", format: "der" });
  assert.ok(crypto.createPrivateKey({ key: sec1der, format: "der",
                                      type: "sec1" }));

  /* IEEE P1363 (raw r || s) signatures. */
  for (const namedCurve of ["prime256v1", "secp384r1", "secp521r1"]) {
    const pair = crypto.generateKeyPairSync("ec", { namedCurve });
    const raw = crypto.sign("sha256", "p1363", {
      key: pair.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    assert.strictEqual(raw.length,
                       cryptoCurveBytesForTest(namedCurve) * 2);
    assert.strictEqual(crypto.verify("sha256", "p1363", {
      key: pair.publicKey,
      dsaEncoding: "ieee-p1363",
    }, raw), true);
  }

  /* Other supported curves. */
  for (const namedCurve of ["secp384r1", "secp521r1", "secp256k1"]) {
    const pair = crypto.generateKeyPairSync("ec", { namedCurve });
    assert.strictEqual(pair.privateKey.asymmetricKeyDetails.namedCurve,
                       namedCurve);
    assertRoundTrip(pair.privateKey, pair.publicKey, "sha384");
  }
}

function testSignStreams() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec",
    { namedCurve: "prime256v1" });

  const signer = crypto.createSign("sha256");
  signer.update("part one");
  signer.update(Buffer.from(" and part two"));
  const sig = signer.sign(privateKey);
  assert.ok(Buffer.isBuffer(sig));

  const verifier = crypto.createVerify("sha256");
  verifier.update("part one");
  verifier.update(" and part two");
  assert.strictEqual(verifier.verify(publicKey, sig), true);

  const verifier2 = crypto.createVerify("sha256");
  verifier2.update("part one and part two");
  assert.strictEqual(verifier2.verify(publicKey, sig.toString("hex"), "hex"),
                     true);
}

function testKeyObject() {
  const secret = crypto.createSecretKey(Buffer.from("secret bytes"));
  assert.strictEqual(secret.type, "secret");
  assert.strictEqual(secret.symmetricKeySize, 12);
  assert.strictEqual(secret.export().toString(), "secret bytes");
  assert.ok(secret.equals(crypto.KeyObject.from("secret bytes")));

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  assert.ok(!privateKey.equals(publicKey));
  assert.strictEqual(publicKey.export({ format: "der", type: "spki" })
                       .constructor.name, "Buffer");
}

function testAsync() {
  const promise = (fn) => new Promise((resolve, reject) => {
    fn((err, value) => err ? reject(err) : resolve(value));
  });

  return Promise.resolve()
    .then(() => promise((cb) => crypto.pbkdf2("password", "salt", 1, 32,
                                              "sha256", cb)))
    .then((key) => {
      assert.strictEqual(
        key.toString("hex"),
        "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
    })
    .then(() => promise((cb) => crypto.scrypt("", "", 16,
      { N: 16, r: 1, p: 1 }, cb)))
    .then((key) => {
      assert.strictEqual(key.toString("hex"),
                         "77d6576238657b203b19ca42c18a0497");
    })
    .then(() => promise((cb) => crypto.hkdf("sha256", "ikm", "salt", "info",
                                            16, cb)))
    .then((key) => assert.strictEqual(key.length, 16))
    .then(() => new Promise((resolve, reject) => {
      crypto.generateKeyPair("ec", { namedCurve: "prime256v1" },
                             (err, publicKey, privateKey) => {
        if (err)
          return reject(err);
        try {
          const sig = crypto.sign("sha256", "async", privateKey);
          assert.strictEqual(
            crypto.verify("sha256", "async", publicKey, sig), true);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }));
}

const tests = [
  testPbkdf2,
  testHkdf,
  testScrypt,
  testRsa,
  testEc,
  testSignStreams,
  testKeyObject,
  testAsync,
];

(async () => {
  for (const test of tests) {
    if (process.env.QNODE_TEST_VERBOSE)
      console.error("crypto test:", test.name);
    await test();
  }
  console.log("crypto_keys: all tests passed");
})().then(() => process.exit(0), (err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
