'use strict';
// HTTP throughput: one process runs both server and client, C keep-alive
// connections, N requests total. Usage: N=10000 C=16 <runtime> httpconc.js
const http = require('http');
const N = Number(process.env.N || 10000);
const C = Number(process.env.C || 16);

const now = () => {
  if (process.hrtime) {
    const t = process.hrtime();
    return t[0] * 1000 + t[1] / 1e6;
  }
  return performance.now();
};

let done = 0;
let errors = 0;
let started = 0;
let finished = false;
const agents = [];

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Length': 2 });
  res.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const t0 = now();

  function check() {
    if (done >= N && !finished) {
      finished = true;
      const ms = now() - t0;
      for (const a of agents) a.destroy();
      server.close();
      console.log('HTTPC ' + N + ' ' + C + ' ' + ms.toFixed(3) + ' ' + errors);
    }
  }

  function worker(agent) {
    if (started >= N) return;
    started++;
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.resume();
      res.on('end', () => {
        done++;
        check();
        if (started < N) worker(agent);
      });
    });
    req.on('error', () => {
      errors++;
      done++;
      check();
      if (started < N) worker(agent);
    });
  }

  for (let i = 0; i < C; i++) {
    const a = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(a);
    worker(a);
  }
});
