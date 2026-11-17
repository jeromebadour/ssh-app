import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Blocks, isPrompt, learn, promptLike } from '../src/tab/blocks';

test('a prompt is a short line ending in what a shell ends a prompt with', () => {
  for (const good of ['demo@lab-box:/srv/ledger$ ', 'root@box:~# ', 'me@pc:/tmp% ', 'PS /home> ']) assert.ok(promptLike(good), good);
  for (const bad of ['', '   ', 'just some output', 'a line that ends in a dollar $amount', 'the cost is 40$', 'x'.repeat(300) + '$ ']) {
    assert.equal(promptLike(bad), false, bad.slice(0, 40));
  }
});

test('a line holding a control character is never a prompt, however it ends', () => {
  // The text comes from the terminal's own buffer, so a control character in it means the line is not the
  // simple thing it looks like, and a box chooses every byte it prints.
  assert.equal(promptLike('demo@lab-box:/srv\u0007$ '), false);
  assert.equal(promptLike('demo@lab-box:/srv\u001b[31m$ '), false);
});

test('the folder is left out of what is learned, because the folder is what changes', () => {
  const shape = learn('demo@lab-box:/srv/ledger$ ');
  assert.deepEqual(shape, { who: 'demo@lab-box', ends: '$' });
  // The same box in another folder is the same prompt.
  assert.ok(isPrompt('demo@lab-box:/var/log$ ', shape));
  assert.ok(isPrompt('demo@lab-box:~$ ', shape));
  // Another box, another user, or another symbol is not.
  assert.equal(isPrompt('demo@other-box:/srv/ledger$ ', shape), false);
  assert.equal(isPrompt('root@lab-box:/srv/ledger# ', shape), false);
});

test('a prompt with nothing stable before the folder is not learned at all, and nothing is guessed', () => {
  for (const line of ['$ ', '# ', '/srv/ledger$ ', ':/srv$ ']) assert.equal(learn(line), null, line);
});

test('output that happens to look like half a prompt is not this box’s prompt', () => {
  const shape = learn('demo@lab-box:/srv/ledger$ ')!;
  // A box can print anything, including these. Both ends have to match, which is what stops them.
  assert.equal(isPrompt('demo@lab-box is the box you are on', shape), false);
  assert.equal(isPrompt('total 48$ ', shape), false);
  assert.equal(isPrompt('demo@lab-box:/srv/ledger# ', shape), false);
});

test('what a tab is doing: waiting, running, and the moment a command finished', () => {
  let clock = 1000;
  const b = new Blocks(() => clock);
  assert.equal(b.doing, 'unknown');
  // A shell's banner first: lines that are not prompts teach nothing.
  b.sawLine('Welcome to the box', false, 0);
  b.sawLine('2 updates can be applied', false, 1);
  assert.equal(b.doing, 'unknown');
  // Then its prompt, on the line the cursor is on: now the shape is known and it is waiting.
  b.sawLine('demo@lab-box:/srv/ledger$ ', true, 2);
  assert.deepEqual([b.doing, b.prompts, b.shape?.who], ['idle', 1, 'demo@lab-box']);
  // Enter: the cursor moves below the prompt, and from there it is running until the prompt comes back.
  b.sawLine('', true, 3);
  assert.equal(b.doing, 'running');
  b.sawLine('a line of output', false, 3);
  assert.equal(b.doing, 'running');
  clock = 4500;
  b.sawLine('demo@lab-box:/var/log$ ', true, 4);
  assert.equal(b.doing, 'idle');
  assert.equal(b.takeFinished()?.ms, 3500);
  // And it is said once, not on every redraw.
  assert.equal(b.takeFinished(), null);
});

test('typing at the prompt is not a command running', () => {
  // The cursor stays on the prompt's own row however much he types there, so nothing is called running
  // until Enter has moved it below. A clock on a tab because he started typing would be a lie.
  const b = new Blocks();
  b.sawLine('demo@lab-box:/srv$ ', true, 7);
  b.sawLine('demo@lab-box:/srv$ doc', true, 7);
  b.sawLine('demo@lab-box:/srv$ docker ps -a', true, 7);
  assert.equal(b.doing, 'idle');
  assert.equal(b.takeFinished(), null);
  // Enter, and now it is running.
  b.sawLine('', true, 8);
  assert.equal(b.doing, 'running');
});

test('a command that prints nothing at all is still timed from when it started', () => {
  // sleep 60 prints nothing: what says it is running is the cursor having moved below the prompt, which
  // happens the moment Enter is pressed, so the length is the whole of it.
  let clock = 0;
  const b = new Blocks(() => clock);
  b.sawLine('demo@lab-box:/srv$ ', true, 1);
  b.sawLine('', true, 2);
  clock = 60_000;
  b.sawLine('demo@lab-box:/srv$ ', true, 3);
  assert.equal(b.takeFinished()?.ms, 60_000);
});

test('a prompt that cannot be learned turns blocks off for that tab and says so', () => {
  const b = new Blocks();
  for (let i = 0; i < Blocks.PATIENCE + 1; i++) b.sawLine(`line ${i} of something that is not a prompt`, i % 2 === 0, i);
  assert.equal(b.gaveUp, true);
  assert.equal(b.shape, null);
  assert.equal(b.doing, 'unknown');
  // And it stays off: a prompt arriving after it gave up does not quietly turn blocks on half way through.
  b.sawLine('demo@lab-box:/srv$ ', true, 999);
  assert.equal(b.shape, null);
  assert.equal(b.doing, 'unknown');
});

test('nothing is learned from a line the box printed and moved past', () => {
  // A prompt is a line the box stopped on. A box that prints a prompt-shaped line in the middle of its
  // output is printing output, and learning from it would mark real output as commands from then on.
  const b = new Blocks();
  b.sawLine('demo@lab-box:/srv/ledger$ ', false, 0);
  assert.equal(b.shape, null);
  assert.equal(b.doing, 'unknown');
});

test('nothing of what he typed is kept anywhere', () => {
  // The only things this holds are the shape of a prompt, which row it was on, and a clock. A tab's reading
  // of its own terminal is not a place to keep a person's commands.
  const b = new Blocks();
  b.sawLine('demo@lab-box:/srv$ ', true, 1);
  b.sawLine('demo@lab-box:/srv$ my-secret-command --token abcdef', true, 1);
  b.sawLine('', true, 2);
  b.sawLine('demo@lab-box:/srv$ ', true, 3);
  const held = JSON.stringify(b);
  assert.ok(!held.includes('my-secret-command'), held);
  assert.ok(!held.includes('abcdef'), held);
});
