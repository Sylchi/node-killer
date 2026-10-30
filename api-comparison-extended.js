// Extended API comparison for Node.js-specific and Bun-specific APIs

console.log("=== Extended API Comparison ===\n");

const results = {
  have: [],
  missing: [],
  notes: []
};

function check(name, test, note) {
  try {
    const exists = test();
    if (exists) {
      results.have.push(name);
    } else {
      results.missing.push(name);
      if (note) results.notes.push({ name, note });
    }
  } catch (e) {
    results.missing.push(name);
    if (note) results.notes.push({ name, note });
  }
}

// Node.js process APIs
console.log("Checking Node.js process APIs...");
check('process.env', () => typeof process.env === 'object');
check('process.cwd', () => typeof process.cwd === 'function');
check('process.chdir', () => typeof process.chdir === 'function');
check('process.exit', () => typeof process.exit === 'function');
check('process.kill', () => typeof process.kill === 'function');
check('process.pid', () => typeof process.pid === 'number');
check('process.ppid', () => typeof process.ppid === 'number');
check('process.version', () => typeof process.version === 'string');
check('process.versions', () => typeof process.versions === 'object');
check('process.arch', () => typeof process.arch === 'string');
check('process.platform', () => typeof process.platform === 'string');
check('process.memoryUsage', () => typeof process.memoryUsage === 'function');
check('process.cpuUsage', () => typeof process.cpuUsage === 'function');
check('process.hrtime', () => typeof process.hrtime === 'function');
check('process.uptime', () => typeof process.uptime === 'function');

// Console APIs
console.log("Checking console APIs...");
check('console.log', () => typeof console.log === 'function');
check('console.error', () => typeof console.error === 'function');
check('console.warn', () => typeof console.warn === 'function');
check('console.info', () => typeof console.info === 'function');
check('console.debug', () => typeof console.debug === 'function');
check('console.trace', () => typeof console.trace === 'function');
check('console.time', () => typeof console.time === 'function');
check('console.timeEnd', () => typeof console.timeEnd === 'function');
check('console.timeLog', () => typeof console.timeLog === 'function');
check('console.assert', () => typeof console.assert === 'function');
check('console.clear', () => typeof console.clear === 'function');
check('console.count', () => typeof console.count === 'function');
check('console.countReset', () => typeof console.countReset === 'function');
check('console.dir', () => typeof console.dir === 'function');
check('console.table', () => typeof console.table === 'function');

// Performance APIs
console.log("Checking Performance APIs...");
check('performance.now', () => typeof performance.now === 'function');
check('performance.mark', () => typeof performance.mark === 'function');
check('performance.measure', () => typeof performance.measure === 'function');
check('performance.getEntries', () => typeof performance.getEntries === 'function');
check('performance.getEntriesByName', () => typeof performance.getEntriesByName === 'function');
check('performance.getEntriesByType', () => typeof performance.getEntriesByType === 'function');
check('performance.clearMarks', () => typeof performance.clearMarks === 'function');
check('performance.clearMeasures', () => typeof performance.clearMeasures === 'function');
check('PerformanceObserver', () => typeof PerformanceObserver === 'function', 'Node.js 22+ feature');

// Error handling
console.log("Checking Error handling APIs...");
check('Error.captureStackTrace', () => typeof Error.captureStackTrace === 'function');
check('Error.stackTraceLimit', () => typeof Error.stackTraceLimit === 'number');

// Global utilities
console.log("Checking global utilities...");
check('global', () => typeof global === 'object');
check('globalThis', () => typeof globalThis === 'object');
check('queueMicrotask', () => typeof queueMicrotask === 'function');

// Promise APIs
console.log("Checking Promise APIs...");
check('Promise.resolve', () => typeof Promise.resolve === 'function');
check('Promise.reject', () => typeof Promise.reject === 'function');
check('Promise.all', () => typeof Promise.all === 'function');
check('Promise.allSettled', () => typeof Promise.allSettled === 'function');
check('Promise.race', () => typeof Promise.race === 'function');
check('Promise.any', () => typeof Promise.any === 'function');

// TypedArray constructors
console.log("Checking TypedArray constructors...");
check('Uint8Array', () => typeof Uint8Array === 'function');
check('Int8Array', () => typeof Int8Array === 'function');
check('Uint16Array', () => typeof Uint16Array === 'function');
check('Int16Array', () => typeof Int16Array === 'function');
check('Uint32Array', () => typeof Uint32Array === 'function');
check('Int32Array', () => typeof Int32Array === 'function');
check('Float32Array', () => typeof Float32Array === 'function');
check('Float64Array', () => typeof Float64Array === 'function');
check('BigInt64Array', () => typeof BigInt64Array === 'function');
check('BigUint64Array', () => typeof BigUint64Array === 'function');
check('DataView', () => typeof DataView === 'function');
check('ArrayBuffer', () => typeof ArrayBuffer === 'function');
check('SharedArrayBuffer', () => typeof SharedArrayBuffer === 'function');

// Map/Set/WeakRef
console.log("Checking collection types...");
check('Map', () => typeof Map === 'function');
check('Set', () => typeof Set === 'function');
check('WeakMap', () => typeof WeakMap === 'function');
check('WeakSet', () => typeof WeakSet === 'function');
check('WeakRef', () => typeof WeakRef === 'function');
check('FinalizationRegistry', () => typeof FinalizationRegistry === 'function');

console.log("\n=== Summary ===");
console.log("✅ Have: " + results.have.length);
console.log("❌ Missing: " + results.missing.length);

if (results.missing.length > 0) {
  console.log("\nMissing APIs:");
  results.missing.forEach(api => {
    const note = results.notes.find(n => n.name === api);
    console.log("  ✗ " + api + (note ? " (" + note.note + ")" : ""));
  });
}
