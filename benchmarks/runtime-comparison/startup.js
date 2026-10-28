'use strict';
// Startup cost with a realistic-ish CommonJS prelude: load the modules most
// CLI tools touch and do one small write. Measured externally by hyperfine.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const payload = JSON.stringify({ ok: true, pid: process.pid });
fs.writeFileSync(path.join(os.tmpdir(), 'runtime-compare-startup.json'), payload);
console.log('STARTUP');
