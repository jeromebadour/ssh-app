// A listener that must never hear from the app. The smoke runs point the app's whole network stack at it (as
// its proxy), so that any connection Chromium or the app tries to make by itself lands here and is written
// down, instead of going out. The app's promise is that there is none: no update check, no dictionary download,
// no telemetry, nothing but the SSH connections its user opens (plan B5, B10).
//
//   node scripts/lib/net-canary.mjs <log file>     prints its port, then runs until it is ended
import { appendFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

const log = process.argv[2];
if (!log) {
  console.error('usage: net-canary.mjs <log file>');
  process.exit(2);
}
await writeFile(log, '');
const server = createServer((socket) => {
  socket.setTimeout(3000, () => socket.destroy());
  socket.once('data', (first) => {
    const line = first.toString('latin1').split('\r\n')[0].slice(0, 200);
    void appendFile(log, `${new Date().toISOString()} ${line}\n`);
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  socket.on('error', () => undefined);
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
