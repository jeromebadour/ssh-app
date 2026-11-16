// The password: the one screen that exists before unlock (plan B2.4), as approved in pictures on 2026-11-16.
// First start: make the password and choose the backup folder. Every start: the mark and one field.
// The password leaves as bytes and the fields are emptied. Said plainly, because it matters: a page cannot
// wipe what it has held. The text typed into a field, and every string made from it, stay in the page's
// memory until the browser engine collects them, and nothing here can reach them. Main's side and the key
// process do wipe: this page is the one place in that chain that cannot, and the window's own sandbox is
// what stands in its place.
import { useEffect, useRef, useState } from 'preact/hooks';
import { PASSWORD_MAX_BYTES, PASSWORD_MIN, type GateState } from '../common/ipc';
import { Glyph } from './glyphs';
import { Mark } from './marks';

export interface GateActions {
  create(password: Uint8Array): void;
  unlock(password: Uint8Array): void;
  pickBackup(): void;
  pickRestore(): void;
  usePrevious(): void;
  forgetRestore(): void;
  restore(password: Uint8Array): void;
}

const chars = (s: string) => [...s].length;
const bytes = (s: string) => new TextEncoder().encode(s.normalize('NFC'));

// What is being typed with, said under the field: Caps Lock, and the kind of letters of the last character. A
// password typed in the wrong keyboard layout is the commonest way to be "wrong" with the right password.
function useTyping() {
  const [caps, setCaps] = useState(false);
  const [letters, setLetters] = useState('');
  const onKey = (e: KeyboardEvent) => setCaps(e.getModifierState('CapsLock'));
  const onInput = (e: InputEvent) => {
    const ch = e.data ? [...e.data].pop() : undefined;
    if (!ch) return;
    setLetters(/\p{Script=Latin}/u.test(ch) ? 'Latin letters' : /\p{Script=Arabic}/u.test(ch) ? 'Arabic letters' : /\p{L}/u.test(ch) ? 'other letters' : letters);
  };
  return { caps, letters, onKey, onInput };
}

function TypingLine(props: { caps: boolean; letters: string }) {
  return (
    <span class={`check ${props.caps ? 'check-fix' : 'check-hint'} kb`} id="gate-typing">
      <Glyph name={props.caps ? 'fix' : 'name'} />
      {props.letters && <>typing {props.letters}<span class="kb-sep" /></>}
      Caps Lock {props.caps ? 'on' : 'off'}
    </span>
  );
}

// The same status line the window has, on the screens shown before the lock opens. Those screens had none, so
// the app's one place for saying where things stand simply vanished on three of its screens (Kami, 2026-11-17:
// "no real thin footer everywhere"). It says only what is true here: the app's name, and where the lock stands.
export function GateFoot(props: { gate: GateState }) {
  const g = props.gate;
  const where =
    g.phase === 'starting' ? 'Starting'
    : g.phase === 'working' ? 'Working'
    : g.phase === 'create' ? 'First start'
    : g.phase === 'locked' ? 'Locked'
    : g.phase === 'damaged' ? 'The list could not be read'
    : '';
  return (
    <footer class="status gate-status" id="gate-status">
      <span class="s-tab"><Glyph name="lock" />Berth</span>
      <span />
      <span class="s-last" id="gate-status-where">{g.detail !== '' ? g.detail : where}</span>
    </footer>
  );
}

export function CreateScreen(props: { gate: GateState; act: GateActions; demo?: string }) {
  const [one, setOne] = useState(props.demo ?? '');
  const [two, setTwo] = useState(props.demo ?? '');
  const first = useRef<HTMLInputElement>(null);
  const typing = useTyping();
  useEffect(() => first.current?.focus(), []);
  const n = chars(one);
  const long = n >= PASSWORD_MIN && bytes(one).byteLength <= PASSWORD_MAX_BYTES;
  const same = two.length > 0 && one === two;
  const working = props.gate.phase === 'working';
  const toFix = [!long, !same, !props.gate.backupOk].filter(Boolean).length;
  const [tried, setTried] = useState(false);
  // What is in the way, named: a count alone leaves the person to work out which of the three it is.
  const inTheWay = !long ? (n === 0 ? 'A password is needed' : `${n} of ${PASSWORD_MIN} characters`) : !same ? 'The two passwords are not the same' : 'The backup folder cannot be written to';
  const submit = () => {
    if (working) return;
    if (toFix) {
      // A press that is refused must move something, or there is no telling it landed. This is the first screen
      // anyone sees, and pressing with nothing typed did nothing at all: no line, no movement (BUILD-RULES 2.18).
      setTried(true);
      const go = (id: string) => {
        const el = document.getElementById(id);
        el?.scrollIntoView({ block: 'nearest' });
        (el as HTMLInputElement | null)?.focus();
      };
      if (!long) go('pw-one');
      else if (!same) go('pw-two');
      else go('backup-pick');
      return;
    }
    props.act.create(bytes(one));
    setOne('');
    setTwo('');
  };
  const onEnter = (e: KeyboardEvent) => {
    typing.onKey(e);
    if (e.key === 'Enter') submit();
  };
  return (
    <div class="gate" id="gate-create">
      <div class="gate-card">
        <div class="gate-brand"><Mark /><span class="wordmark">Berth</span></div>
        <h1 class="gate-title">Make your password</h1>
        <p class="gate-lead">It locks your boxes and their keys. Berth asks for it at every start, and nowhere else.</p>
        <label class="field">
          <span class="field-label"><Glyph name="lock" />Password</span>
          <span class="input filled"><input id="pw-one" ref={first} type="password" autocomplete="off" spellcheck={false} value={one} onInput={(e) => { typing.onInput(e as InputEvent); setOne((e.target as HTMLInputElement).value); }} onKeyDown={onEnter} onKeyUp={typing.onKey} /></span>
          {n === 0 ? <span class="check check-hint" id="pw-one-check">{PASSWORD_MIN} characters or more</span> : long ? <span class="check check-ok" id="pw-one-check"><Glyph name="ok" />{n} characters: {PASSWORD_MIN} or more</span> : <span class="check check-fix" id="pw-one-check"><Glyph name="fix" />{n} of {PASSWORD_MIN} characters</span>}
        </label>
        <label class="field">
          <span class="field-label"><Glyph name="lock" />Again</span>
          <span class="input filled"><input id="pw-two" type="password" autocomplete="off" spellcheck={false} value={two} onInput={(e) => { typing.onInput(e as InputEvent); setTwo((e.target as HTMLInputElement).value); }} onKeyDown={onEnter} onKeyUp={typing.onKey} /></span>
          {two.length === 0 ? <TypingLine caps={typing.caps} letters={typing.letters} /> : same ? <span class="check check-ok" id="pw-two-check"><Glyph name="ok" />the same as above</span> : <span class="check check-fix" id="pw-two-check"><Glyph name="fix" />not the same as above</span>}
        </label>
        <div class="field">
          <span class="field-label"><Glyph name="folderPick" />Backup folder</span>
          <span class="input picker"><span class="path" id="backup-dir">{props.gate.backupDir}</span><button class="pick" type="button" id="backup-pick" onClick={props.act.pickBackup}><Glyph name="folder" />Choose</button></span>
          {props.gate.backupOk ? <span class="check check-ok" id="backup-check"><Glyph name="ok" />writable; a copy is written there at every change</span> : <span class="check check-fix" id="backup-check"><Glyph name="fix" />this folder cannot be written to</span>}
        </div>
        <p class="gate-fact">A forgotten password cannot be recovered. A backup opens only with the password it was saved under.</p>
        {props.gate.detail && <span class="check check-fix" id="gate-detail"><Glyph name="fix" />{props.gate.detail}</span>}
        <div class="gate-go">
          {toFix > 0 && (n > 0 || tried) && <span class="to-fix" id="gate-to-fix"><Glyph name="fix" />{inTheWay}</span>}
          <button class={`btn primary wide ${working ? 'waiting' : ''}`} id="gate-submit" type="button" onClick={submit}>
            {working ? <><span class="wait-ring" />Locking</> : <><Glyph name="lock" />Lock with this password</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function UnlockScreen(props: { gate: GateState; act: GateActions; demo?: string }) {
  const [pw, setPw] = useState(props.demo ?? '');
  const [left, setLeft] = useState(0); // seconds until the next try is looked at
  const field = useRef<HTMLInputElement>(null);
  const typing = useTyping();
  const g = props.gate;
  useEffect(() => field.current?.focus(), [g.phase, left === 0]);
  // The wait counts down once a second while there is one; nothing moves otherwise.
  useEffect(() => {
    const until = Date.now() + g.waitMs;
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    if (g.waitMs <= 0) return;
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [g]);
  const working = g.phase === 'working';
  const submit = () => {
    if (working || left > 0 || pw.length === 0) return;
    props.act.unlock(bytes(pw));
    setPw('');
  };
  const onKey = (e: KeyboardEvent) => {
    typing.onKey(e);
    if (e.key === 'Enter') submit();
  };
  return (
    <div class="gate" id="gate-unlock">
      <div class="gate-card narrow">
        <div class="gate-brand big"><Mark /><span class="wordmark">Berth</span></div>
        <label class="field">
          <span class="field-label"><Glyph name="lock" />Password</span>
          <span class={`input filled ${g.wrong ? 'wrong' : ''}`}><input id="pw" ref={field} type="password" autocomplete="off" spellcheck={false} placeholder="Password" value={pw} onInput={(e) => { typing.onInput(e as InputEvent); setPw((e.target as HTMLInputElement).value); }} onKeyDown={onKey} onKeyUp={typing.onKey} /></span>
          {g.wrong && pw.length === 0 ? <span class="check check-fix" id="gate-wrong"><Glyph name="fix" />Wrong password.</span> : <TypingLine caps={typing.caps} letters={typing.letters} />}
        </label>
        {g.detail && <span class="check check-fix" id="gate-detail"><Glyph name="fix" />{g.detail}</span>}
        <button class={`btn primary wide ${working || left > 0 ? 'waiting' : ''}`} id="gate-submit" type="button" onClick={submit}>
          {working ? <><span class="wait-ring" />Unlocking</> : left > 0 ? <><span class="wait-ring" />Wait {left} s</> : <><Glyph name="lock" />Unlock</>}
        </button>
        <p class="gate-saved">{g.wrong ? 'Each wrong try doubles the wait, up to 30 s.' : ''}</p>
      </div>
    </div>
  );
}

// A list that cannot be read, and the ways back from it: the copy saved beside it, or any backup. Berth never
// opens one by itself and never overwrites the damaged file: a backup is opened with its own password, and
// only once it opens does it become the list. The file is chosen through the system's own chooser, in main;
// this screen never names a file.
export function RestoreScreen(props: { gate: GateState; act: GateActions; demo?: string }) {
  const [pw, setPw] = useState(props.demo ?? '');
  const [left, setLeft] = useState(0); // seconds until the next try is looked at
  const field = useRef<HTMLInputElement>(null);
  const typing = useTyping();
  const g = props.gate;
  const chosen = g.restoreFrom !== '';
  useEffect(() => {
    if (chosen) field.current?.focus();
  }, [chosen]);
  // A wrong password makes the next try wait, here as on the unlock screen: the button says how long, so a
  // press inside the wait is never a press that quietly did nothing.
  useEffect(() => {
    const until = Date.now() + g.waitMs;
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    if (g.waitMs <= 0) return;
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [g]);
  const words: Record<string, string> = {
    damaged: 'The list on this PC is damaged or was altered.',
    'not-a-list': 'The file where the list should be is not a Berth list.',
    'newer-version': 'The list was made by a newer version of Berth.',
    'cost-out-of-range': 'The list asks for a cost outside what Berth accepts.',
  };
  const submit = () => {
    if (!chosen || pw.length === 0 || left > 0 || g.phase === 'working') return;
    props.act.restore(bytes(pw));
    setPw('');
  };
  const name = g.restoreFrom.split(/[\\/]/).pop() ?? g.restoreFrom;
  const beside = /\.previous$/.test(g.restoreFrom);
  return (
    <div class="gate" id="gate-damaged">
      <div class="gate-card narrow">
        <div class="gate-brand big"><Mark /><span class="wordmark">Berth</span></div>
        <span class="check check-fix gate-wrap" id="gate-damaged-said"><Glyph name="fix" />{words[g.detail] ?? words['damaged']} It was not changed.</span>
        {!chosen ? (
          <>
            <span class="check check-hint gate-wrap">A backup opens with its own password and becomes the list. Berth keeps a copy beside the list at every save, and a backup in the folder chosen when the list was made.</span>
            {g.hasPrevious && (
              <button class="btn primary wide" id="gate-previous" type="button" onClick={props.act.usePrevious}>
                <Glyph name="reconnect" />The copy saved before this one
              </button>
            )}
            <button class={`btn ${g.hasPrevious ? 'quiet' : 'primary'} wide`} id="gate-pick-restore" type="button" onClick={props.act.pickRestore}>
              <Glyph name="folder" />A backup file
            </button>
          </>
        ) : (
          <>
            <span class="check check-hint gate-wrap" id="gate-restore-from"><Glyph name="keyfile" />{beside ? 'The copy saved before this one' : name}</span>
            <label class="field">
              <span class="field-label"><Glyph name="lock" />Its password</span>
              <span class={`input filled ${g.wrong ? 'wrong' : ''}`}><input id="pw-restore" ref={field} type="password" autocomplete="off" spellcheck={false} placeholder="The password that list was saved under" value={pw} onInput={(e) => { typing.onInput(e as InputEvent); setPw((e.target as HTMLInputElement).value); }} onKeyDown={(e) => { typing.onKey(e); if (e.key === 'Enter') submit(); }} onKeyUp={typing.onKey} /></span>
              {g.wrong && pw.length === 0 ? <span class="check check-fix" id="gate-restore-wrong"><Glyph name="fix" />Wrong password.</span> : <TypingLine caps={typing.caps} letters={typing.letters} />}
            </label>
            <button class={`btn primary wide ${g.phase === 'working' || left > 0 ? 'waiting' : ''}`} id="gate-restore" type="button" onClick={submit}>
              {g.phase === 'working' ? <><span class="wait-ring" />Opening</> : left > 0 ? <><span class="wait-ring" />Wait {left} s</> : <><Glyph name="lock" />Open it and make it the list</>}
            </button>
            {g.wrong && <p class="gate-saved">Each wrong try doubles the wait, up to 30 s.</p>}
            <button class="btn quiet wide" id="gate-restore-other" type="button" onClick={props.act.forgetRestore}>
              <Glyph name="folder" />Another backup
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// The states that are not a password field: the key process starting, gone, or a list that cannot be read.
export function GateNotice(props: { gate: GateState }) {
  const g = props.gate;
  const words: Record<string, string> = {
    damaged: 'The list on this PC is damaged or was altered. It was not changed.',
    'not-a-list': 'The file where the list should be is not a Berth list. It was not changed.',
    'newer-version': 'The list was made by a newer version of Berth.',
    'cost-out-of-range': 'The list asks for a cost outside what Berth accepts. It was not changed.',
  };
  return (
    <div class="gate" id="gate-notice" data-phase={g.phase}>
      <div class="gate-card narrow">
        <div class="gate-brand big"><Mark /><span class="wordmark">Berth</span></div>
        {g.phase === 'starting' ? (
          <span class="check check-hint gate-center"><span class="wait-ring" />Starting</span>
        ) : (
          <>
            <span class="check check-fix gate-wrap"><Glyph name="fix" />{g.phase === 'damaged' ? (words[g.detail] ?? words['damaged']) : g.detail}</span>
            {g.phase === 'damaged' && g.hasPrevious && <span class="check check-hint gate-wrap">The copy saved before this one is still beside it.</span>}
          </>
        )}
      </div>
    </div>
  );
}
