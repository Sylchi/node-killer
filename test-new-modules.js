// Test new modules
console.log("=== Testing New Modules ===\n");

// Test PerformanceObserver
console.log("1. PerformanceObserver:");
const obs = new PerformanceObserver((list, observer) => {
  console.log("  Callback invoked");
});
console.log("  ✓ Instance created");
obs.observe({ entryTypes: ['measure'] });
console.log("  ✓ observe() called");
obs.disconnect();
console.log("  ✓ disconnect() called");
console.log("  Supported types:", PerformanceObserver.supportedEntryTypes);

// Test cluster
console.log("\n2. cluster:");
const cluster = require('cluster');
console.log("  isPrimary:", cluster.isPrimary);
console.log("  isWorker:", cluster.isWorker);
console.log("  ✓ Module loaded");

// Test http2
console.log("\n3. http2:");
const http2 = require('http2');
console.log("  HTTP2_HEADER_STATUS:", http2.constants.HTTP2_HEADER_STATUS);
console.log("  HTTP2_HEADER_METHOD:", http2.constants.HTTP2_HEADER_METHOD);
console.log("  ✓ Module loaded with constants");

// Test inspector
console.log("\n4. inspector:");
const inspector = require('inspector');
console.log("  url():", inspector.url());
console.log("  ✓ Module loaded");

// Test repl
console.log("\n5. repl:");
const repl = require('repl');
console.log("  REPLServer:", typeof repl.REPLServer);
console.log("  Recoverable:", typeof repl.Recoverable);
console.log("  ✓ Module loaded");

// Test wasi
console.log("\n6. wasi:");
const wasi = require('wasi');
console.log("  WASI:", typeof wasi.WASI);
console.log("  ✓ Module loaded");

console.log("\n✅ All new modules working!");
