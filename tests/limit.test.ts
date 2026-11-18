import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// A limit that is put down while a person answers a box's questions must really come back afterwards. The
// first visit used clearTimeout and then refresh() on the same timer, which does not re-arm it: after the
// first question the visit had no limit at all, so a visit that never ended would have waited for ever with
// nothing said. This is Node's own behaviour, held here so nothing in this app leans on it again.
test('a timeout that has been cleared does not come back from refresh()', async () => {
  let fired = false;
  const t = setTimeout(() => {
    fired = true;
  }, 20);
  clearTimeout(t);
  t.refresh();
  await new Promise((go) => setTimeout(go, 120));
  assert.equal(fired, false, 'refresh() re-armed a cleared timeout, so the way the first visit does it could have been kept');
});

// And the way the first visit does it now: a fresh timer each time, so it is really there again.
test('a limit made afresh is really there again', async () => {
  let fired = 0;
  let limit: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (limit) clearTimeout(limit);
    limit = null;
  };
  const arm = (): void => {
    stop();
    limit = setTimeout(() => {
      fired++;
    }, 20);
  };
  arm();
  stop(); // he is answering the box's questions: nothing is counting
  await new Promise((go) => setTimeout(go, 60));
  assert.equal(fired, 0, 'the limit fired while it was meant to be put down');
  arm(); // he has answered
  await new Promise((go) => setTimeout(go, 120));
  assert.equal(fired, 1, 'the limit did not come back');
  stop();
});
