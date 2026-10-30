// API Comparison: qnode vs Node.js 22 vs Bun
// Testing what globals are available

console.log("=== Web Platform API Comparison ===\n");

const results = {
  have: [],
  missing: [],
  partial: []
};

function check(name, test) {
  try {
    const exists = test();
    if (exists === true) {
      results.have.push(name);
    } else if (exists === 'partial') {
      results.partial.push(name);
    } else {
      results.missing.push(name);
    }
  } catch (e) {
    results.missing.push(name);
  }
}

// Event APIs
check('Event', () => typeof Event === 'function');
check('EventTarget', () => typeof EventTarget === 'function');
check('MessageEvent', () => typeof MessageEvent === 'function');
check('CustomEvent', () => typeof CustomEvent === 'function');
check('ProgressEvent', () => typeof ProgressEvent === 'function');
check('CloseEvent', () => typeof CloseEvent === 'function');

// Stream APIs
check('ReadableStream', () => typeof ReadableStream === 'function');
check('WritableStream', () => typeof WritableStream === 'function');
check('TransformStream', () => typeof TransformStream === 'function');
check('CompressionStream', () => typeof CompressionStream === 'function');
check('DecompressionStream', () => typeof DecompressionStream === 'function');
check('ReadableByteStreamController', () => typeof ReadableByteStreamController === 'function');
check('ReadableStreamBYOBRequest', () => typeof ReadableStreamBYOBRequest === 'function');
check('CountQueuingStrategy', () => typeof CountQueuingStrategy === 'function');
check('ByteLengthQueuingStrategy', () => typeof ByteLengthQueuingStrategy === 'function');

// Encoding APIs
check('TextEncoder', () => typeof TextEncoder === 'function');
check('TextDecoder', () => typeof TextDecoder === 'function');
check('TextEncoderStream', () => typeof TextEncoderStream === 'function');
check('TextDecoderStream', () => typeof TextDecoderStream === 'function');

// URL APIs
check('URL', () => typeof URL === 'function');
check('URLSearchParams', () => typeof URLSearchParams === 'function');

// Abort APIs
check('AbortController', () => typeof AbortController === 'function');
check('AbortSignal', () => typeof AbortSignal === 'function');
check('AbortSignal.timeout', () => typeof AbortSignal.timeout === 'function');
check('AbortSignal.any', () => typeof AbortSignal.any === 'function');

// Messaging APIs
check('WebSocket', () => typeof WebSocket === 'function');
check('MessageChannel', () => typeof MessageChannel === 'function');
check('MessagePort', () => typeof MessagePort === 'function');
check('BroadcastChannel', () => typeof BroadcastChannel === 'function');

// Fetch APIs
check('fetch', () => typeof fetch === 'function');
check('Headers', () => typeof Headers === 'function');
check('Request', () => typeof Request === 'function');
check('Response', () => typeof Response === 'function');

// Data APIs
check('Blob', () => typeof Blob === 'function');
check('File', () => typeof File === 'function');
check('FormData', () => typeof FormData === 'function');

// Crypto APIs
check('crypto', () => typeof crypto === 'object');
check('crypto.subtle', () => crypto && typeof crypto.subtle === 'object');
check('CryptoKey', () => typeof CryptoKey === 'function');
check('SubtleCrypto', () => typeof SubtleCrypto === 'function');
check('crypto.getRandomValues', () => crypto && typeof crypto.getRandomValues === 'function');
check('crypto.randomUUID', () => crypto && typeof crypto.randomUUID === 'function');

// Timer APIs
check('setTimeout', () => typeof setTimeout === 'function');
check('clearTimeout', () => typeof clearTimeout === 'function');
check('setInterval', () => typeof setInterval === 'function');
check('clearInterval', () => typeof clearInterval === 'function');
check('setImmediate', () => typeof setImmediate === 'function');
check('clearImmediate', () => typeof clearImmediate === 'function');
check('queueMicrotask', () => typeof queueMicrotask === 'function');

// Utility APIs
check('structuredClone', () => typeof structuredClone === 'function');
check('atob', () => typeof atob === 'function');
check('btoa', () => typeof btoa === 'function');
check('performance', () => typeof performance === 'object');
check('navigator', () => typeof navigator === 'object');
check('DOMException', () => typeof DOMException === 'function');
check('Buffer', () => typeof Buffer === 'function');
check('process', () => typeof process === 'object');
check('console', () => typeof console === 'object');
check('globalThis', () => typeof globalThis === 'object');

// Performance Observer (Node.js 22+)
check('PerformanceObserver', () => typeof PerformanceObserver === 'function');

// Node.js specific globals
check('__dirname', () => typeof __dirname !== 'undefined' ? 'partial' : false);
check('__filename', () => typeof __filename !== 'undefined' ? 'partial' : false);

console.log("✅ HAVE (" + results.have.length + "):");
results.have.forEach(name => console.log("  ✓ " + name));

console.log("\n⚠️  PARTIAL (" + results.partial.length + "):");
results.partial.forEach(name => console.log("  ~ " + name));

console.log("\n❌ MISSING (" + results.missing.length + "):");
results.missing.forEach(name => console.log("  ✗ " + name));

console.log("\n=== Summary ===");
const total = results.have.length + results.partial.length + results.missing.length;
const coverage = ((results.have.length + results.partial.length * 0.5) / total * 100).toFixed(1);
console.log("Coverage: " + coverage + "%");
console.log("Have: " + results.have.length + "/" + total);
console.log("Partial: " + results.partial.length + "/" + total);
console.log("Missing: " + results.missing.length + "/" + total);
