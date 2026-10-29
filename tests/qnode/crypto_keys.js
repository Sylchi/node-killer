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

function testEd25519() {
  /* RFC 8032 test vector 1: empty message. */
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex");
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der",
                                               type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  assert.strictEqual(privateKey.asymmetricKeyType, "ed25519");
  assert.strictEqual(publicKey.asymmetricKeyType, "ed25519");
  assert.deepStrictEqual(privateKey.asymmetricKeyDetails, {});
  assert.deepStrictEqual(publicKey.asymmetricKeyDetails, {});
  assert.strictEqual(publicKey.export({ format: "der", type: "spki" })
                       .toString("hex"),
    "302a300506032b6570032100" +
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  assert.strictEqual(crypto.sign(null, Buffer.alloc(0), privateKey)
                       .toString("hex"),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");

  const pair = crypto.generateKeyPairSync("ed25519");
  assert.strictEqual(pair.privateKey.type, "private");
  assert.strictEqual(pair.publicKey.type, "public");
  assert.strictEqual(pair.privateKey.asymmetricKeyType, "ed25519");
  assert.strictEqual(pair.publicKey.asymmetricKeyType, "ed25519");

  const data = Buffer.from("ed25519 message");
  const sig = crypto.sign(null, data, pair.privateKey);
  assert.strictEqual(sig.length, 64);
  assert.strictEqual(crypto.verify(null, data, pair.publicKey, sig), true);
  assert.strictEqual(crypto.verify(null, data, pair.privateKey, sig), true);
  assert.strictEqual(
    crypto.verify(null, Buffer.from("ed25519 messagf"), pair.publicKey, sig),
    false);
  assert.strictEqual(crypto.verify(null, data, pair.publicKey,
                                   Buffer.alloc(64, 1)), false);
  assert.throws(() => crypto.sign("sha256", data, pair.privateKey),
                TypeError);

  const pkcs8Der = pair.privateKey.export({ type: "pkcs8", format: "der" });
  const spkiDer = pair.publicKey.export({ type: "spki", format: "der" });
  assert.strictEqual(pkcs8Der.length, 48);
  assert.strictEqual(spkiDer.length, 44);
  const pkcs8Pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const spkiPem = pair.publicKey.export({ type: "spki", format: "pem" });
  assert.ok(pkcs8Pem.startsWith("-----BEGIN PRIVATE KEY-----"));
  assert.ok(spkiPem.startsWith("-----BEGIN PUBLIC KEY-----"));

  const privPem = crypto.createPrivateKey(pkcs8Pem);
  const pubPem = crypto.createPublicKey(spkiPem);
  assert.ok(privPem.equals(pair.privateKey));
  assert.ok(pubPem.equals(pair.publicKey));
  assert.strictEqual(crypto.verify(null, data, pubPem, sig), true);
  assert.strictEqual(crypto.verify(null, data, pair.publicKey,
                                   crypto.sign(null, data, privPem)), true);

  /* A public key can be derived from the private key. */
  assert.ok(crypto.createPublicKey(pair.privateKey).equals(pair.publicKey));

  const privDer = crypto.createPrivateKey({ key: pkcs8Der, format: "der",
                                            type: "pkcs8" });
  const pubDer = crypto.createPublicKey({ key: spkiDer, format: "der",
                                          type: "spki" });
  assert.ok(privDer.equals(pair.privateKey));
  assert.ok(pubDer.equals(pair.publicKey));

  /* Streaming APIs accept a null digest for Ed25519. */
  const signer = crypto.createSign(null);
  signer.update("part one").update(" and part two");
  const streamSig = signer.sign(pair.privateKey);
  const verifier = crypto.createVerify(null);
  verifier.update("part one and part two");
  assert.strictEqual(verifier.verify(pair.publicKey, streamSig), true);
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

function testHmac() {
  const key = Buffer.alloc(20, 0x0b);
  const data = "Hi There";
  /* RFC 4231 test case 1. */
  assert.strictEqual(
    hex(crypto.createHmac("sha256", key).update(data).digest()),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  assert.strictEqual(
    hex(crypto.createHmac("sha384", key).update(data).digest()),
    "afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59c" +
    "faea9ea9076ede7f4af152e8b2fa9cb6");
  assert.strictEqual(
    hex(crypto.createHmac("sha512", key).update(data).digest()),
    "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde" +
    "daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854");

  /* RFC 4231 test case 6: key longer than the hash block size. */
  const longKey = Buffer.alloc(131, 0xaa);
  const longData = "Test Using Larger Than Block-Size Key - Hash Key First";
  assert.strictEqual(
    hex(crypto.createHmac("sha256", longKey).update(longData).digest()),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  assert.strictEqual(
    hex(crypto.createHmac("sha384", longKey).update(longData).digest()),
    "4ece084485813e9088d2c63a041bc5b44f9ef1012a2b588f3cd11f05033ac4c6" +
    "0c2ef6ab4030fe8296248df163f44952");
  assert.strictEqual(
    hex(crypto.createHmac("sha512", longKey).update(longData).digest()),
    "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f352" +
    "6b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598");

  /* Streaming updates match a single update, and aliases are accepted. */
  const streamed = crypto.createHmac("SHA-512", key);
  streamed.update("Hi ");
  streamed.update(Buffer.from("There"));
  assert.strictEqual(hex(streamed.digest()),
                     hex(crypto.createHmac("sha512", key).update(data).digest()));
  assert.strictEqual(
    crypto.createHmac("sha256", key).update(data).digest("hex").length, 64);

  assert.throws(() => crypto.createHmac("nope", key), /not supported/i);
  const used = crypto.createHmac("sha256", key).update(data);
  used.digest();
  assert.throws(() => used.update(data), /Digest already called/);
}

function testEncryptedPem() {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "Proc-Type: 4,ENCRYPTED",
    "DEK-Info: AES-256-CBC,CF6DEC38913887AC0FDF286DA4305722",
    "",
    "8TlKpy7ikt7ewTaotnhjO6HoqYWVwACb1wz/j/inPTFbt0uy/Zq96s6z6xS6Hsgs",
    "8i7bO5xmRVCHtgG8v4GBrV691KzBZbE1tSiPGAbchL+dVc/k5poJqkjLmfoJQJne",
    "NHfWxTVI7Lzafrq6B2qn/KRtfgutGLeUF2yflMgn+sw8L6bqvzDg6QaIOx9Zih48",
    "9kVFSyxXLgaGKEYU13VmLz8JhQ1bYa/FpMARWV/Vs6UojaBqN3b+/Y/q5LWjasNs",
    "t5VVQX16NXDIXP3v1UO2mRCUtHFD9r7ZrfPwK/CaanF6uIgsbgjPsEYoETdrm1Ep",
    "Z0t7kuV/jQTPpsrc+fmDEqJI5MHXEaHqzc+3pa2T5i4WBqHOPfgcZA2+xfmVzMIe",
    "cK9u0C1rpRuv7FyJN6sR9CsDORimjQmSMap+yX9Q4LfFlMkzENlFuqbHbM9LECGr",
    "yeBkpkAud2P61pbHEQxHlFRdySXnO9JXxSimD3xgVlBI/bm6nlO8zdVHq3Bry9mg",
    "VbcmTE/J+IxmaOTWJAifD8DDJiMXCq9qEAXSHB3ZwInYBMGmzvUca2TXwlj0gL84",
    "O38emfElOfUQkh0E8k20IJo4SFhMLxsUgK+6i6xaoQsnFzLR8xQEoa77HpDsEWqZ",
    "9MjYphWjmBCsMdoa2NJKRjdZGhBjlO0PBM8rAopSg2cz3gcI79PhW64/PdBjWwnK",
    "vtBvgCrlvocJTXu5dfnuYIaIKo/9NNr4BL1Bly9QDAW+ZQ3msbN4WuFfuNGgvHjm",
    "XANtOeajVJnzGY+DseMr68CuvjrXxJH6AAAtnLNHWGECRedm+r6C9JtidIid1cA5",
    "hNYtvrNOeqf3uJWHGJo+OkzVbbF9DPdZXFx+pPdrcojHapA82k1UgwZwrvoIlYc6",
    "VYtmFwHkCmjldjUHbnMEXCMEByad6C0xnm5TR33VCU33N+fqSfrp3oOxQECMfGue",
    "J+TckTW0bQFLhUjhb1nYuJuxTFf0LVVi5NX2vivJoEPgaOfm3tuoSyDynkkNgnvl",
    "oEbnhTzKUd1oDOFL8wPCX+gG9rxBGs2NnJitvun+x5eP47DORPStrTyqdAiiIl80",
    "nc7JODKz5JQVJX9kRertLb5AA0Mn6znH4ChmXf+WwnVDr/YlAVygqNfU0rYt7ZP/",
    "vExh5MS7t1dKUOueXBOI4JRXRYbMiAfqV/m9YLh2LDwjdxORhDwH/k7USgnGIie8",
    "JSO0nXJANdEKGfhEmTd0R0ts+wG9SvqtEYaU7e/HKCUWy4k2YRbU+ocF/a5W8CJl",
    "6l6emqq2aF1+1wUU7LRGxN84h3QC4tdN+/go0AaZ/Ul5B9+TZvyl2PiMELAS4DUM",
    "SU6iEft/DcExo9EMP6H+MyqTR4+O5U5TNaaFUWnTQCTHoWVAD1DDXyie3a8IYsU3",
    "+pQ7bSwfXYravE7FU996NWzuHJ8ZkcF5JAcjUKhpGRqGruNR39Nqox7D0vKn3P4b",
    "fGbVdH650/hjx6R5miR6Arqsl84wS0YEgykIKvSD8nyZvqi5MauDGMPQQLmVsPUB",
    "fakto++4W5/hyop563LONdnmx0JFCXjF3loQg9udw/dFXr2RhFO0reX7NSi07S97",
    "-----END RSA PRIVATE KEY-----",
    "",
  ].join("\n");
  const passphrase = "qnode-test";
  const privateKey = crypto.createPrivateKey({ key: pem, passphrase });
  assert.strictEqual(privateKey.type, "private");
  assert.strictEqual(privateKey.asymmetricKeyType, "rsa");
  assert.strictEqual(privateKey.asymmetricKeyDetails.modulusLength, 2048);

  const publicKey = crypto.createPublicKey(privateKey);
  assertRoundTrip(privateKey, publicKey, "sha256");

  assert.throws(() => crypto.createPrivateKey({ key: pem,
                                                passphrase: "wrong" }));
}

const tests = [
  testPbkdf2,
  testHkdf,
  testScrypt,
  testHmac,
  testRsa,
  testEncryptedPem,
  testEc,
  testEd25519,
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
