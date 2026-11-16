// The listener that must never hear from Berth is only worth something if it can hear at all: a broken
// listener and a quiet app look exactly the same from outside. So this is a program of its own, not part of
// the app, which does the one thing the app must never do: it reaches out, through the same Electron network
// stack and the same proxy settings the smoke run puts the app behind. The run requires this to land in the
// listener's log, and then requires silence from the app itself.
//
// Berth's own code has no such call anywhere, and a check in scripts/check.sh fails the build if the app ever
// sets a proxy of its own, which is the one way it could step around the listener.
const { app, net } = require('electron');

const where = 'http://berth-net-control.invalid/the-canary-must-hear-this';

app.whenReady().then(async () => {
  try {
    const answer = await net.fetch(where, { signal: AbortSignal.timeout(20000) });
    console.log(`NET-CONTROL answered ${answer.status}`);
    app.exit(0);
  } catch (e) {
    console.log(`NET-CONTROL refused ${e && e.message ? e.message : String(e)}`);
    app.exit(1);
  }
});
