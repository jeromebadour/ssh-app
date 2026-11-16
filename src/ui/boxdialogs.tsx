// The box dialogs, as approved in pictures on 2026-11-16: Add box, the first-connection check (its match, its
// mismatch, a box that cannot be reached) and the stop when a box's identity changed. These are the real
// components: the app draws them, and the lab's picture pages draw them with invented data.
//
// Nothing here decides anything: every check of what is typed is the one in common/boxes.ts, which main applies
// again before anything is saved; what the box showed is in the check only once main has compared a paste.
import { useEffect, useRef, useState } from 'preact/hooks';
import { BOX_COLOURS, checkFolder, checkHost, checkName, checkPlace, checkPort, checkUser, draftFaults, type BoxDraft, type Check, type Place } from '../common/boxes';
import type { BoxView, CheckShown } from '../common/ipc';
import { Glyph } from './glyphs';

// A field, the way every field in Berth is drawn: a label with its glyph, the input as wide as the value it will
// hold, an example in it while empty, and under it a hint or the live check of what was typed.
function Field(props: { id: string; glyph: string; label: string; value: string; example: string; ch: number; mono?: boolean; check: Check; shown: boolean; focus?: boolean; hue?: number; adorn?: preact.ComponentChildren; onInput(v: string): void; onEnter(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.focus) ref.current?.focus();
  }, []);
  const c = props.check;
  const wrong = c.state === 'fix' && props.shown;
  return (
    <label class="field" style={{ '--w': `${props.ch}ch`, ...(props.hue ? { '--hue': `var(--box-${props.hue})` } : {}) }}>
      <span class="field-label"><Glyph name={props.glyph} />{props.label}</span>
      <span class={`input sized ${props.mono ? 'mono' : ''} ${wrong ? 'wrong' : ''} ${props.hue ? 'hued' : ''}`}>
        <input id={props.id} ref={ref} type="text" autocomplete="off" spellcheck={false} placeholder={props.example} value={props.value} onInput={(e) => props.onInput((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && props.onEnter()} />
        {props.adorn}
      </span>
      <CheckLine id={`${props.id}-check`} c={c} shown={props.shown} />
    </label>
  );
}

// A check shows as soon as something was typed; an empty required field shows its fault only after Add was tried.
function CheckLine(props: { id: string; c: Check; shown: boolean; cls?: string }) {
  const c = props.c.state === 'fix' && !props.shown ? { state: 'hint' as const, text: props.c.text } : props.c;
  return <span class={`check check-${c.state} ${props.cls ?? ''}`} id={props.id}>{c.state !== 'hint' && <Glyph name={c.state === 'ok' ? 'ok' : 'fix'} />}{c.text}</span>;
}

// The box's colour, as an option inside the name field: one small swatch (the name is shown in that colour, as
// on its tabs); pressed, the colours open under it.
function HuePick(props: { colour: number; open: boolean; toggle(): void; pick(n: number): void }) {
  return (
    <span class="hue-pick-wrap">
      <button type="button" class={`hue-pick ${props.open ? 'open' : ''}`} id="hue-pick" aria-haspopup="menu" aria-expanded={props.open} aria-label="Colour" title="Colour: on its tabs, its terminal frame and its prompt" onClick={(e) => { e.preventDefault(); props.toggle(); }}>
        <span class="swatch small" style={{ '--hue': `var(--box-${props.colour})` }} />
        <Glyph name="chevron" class="caret" />
      </button>
      {props.open && (
        <span class="hue-menu" role="menu" aria-label="Colour">
          {Array.from({ length: BOX_COLOURS }, (_, i) => i + 1).map((n) => (
            <button type="button" key={n} class={`swatch ${n === props.colour ? 'on' : ''}`} data-hue={n} style={{ '--hue': `var(--box-${n})` }} role="menuitemradio" aria-checked={n === props.colour} aria-label={`Colour ${n}`} onClick={(e) => { e.preventDefault(); props.pick(n); }} />
          ))}
        </span>
      )}
    </span>
  );
}

function SectionHead(props: { glyph: string; title: string; aside?: string }) {
  return <div class="sect-head"><Glyph name={props.glyph} />{props.title}{props.aside && <span class="sect-aside">{props.aside}</span>}</div>;
}

const EMPTY: BoxDraft = { name: '', colour: 1, host: '', port: '', user: '', folder: '', places: [] };
const required = (c: Check, tried: boolean): Check => (tried && c.state === 'hint' ? { state: 'fix', text: 'needed' } : c);

export interface AddBoxProps {
  taken: string[]; // the names of the other boxes there are
  working: boolean; // the box is being added or saved (its key made, the list written)
  refused: Record<string, string>; // what main refused, by field, after Add or Save
  error: string; // a refusal that is no field's
  demo?: { draft: BoxDraft; tried?: boolean };
  // Editing: the box as it stands, so the same dialog shows it and saves what changed. Its identity, when it
  // has one, is shown with the way to forget it; its key is this box's, not a new one.
  editing?: { draft: BoxDraft; pinType: string; pinFingerprint: string; pinnedAt: string; onForget(): void };
  onAdd(draft: BoxDraft): void;
  onCancel(): void;
}

export function AddBoxDialog(props: AddBoxProps) {
  const editing = props.editing;
  const [d, setD] = useState<BoxDraft>(props.demo?.draft ?? editing?.draft ?? { ...EMPTY, colour: (props.taken.length % BOX_COLOURS) + 1 });
  const [tried, setTried] = useState(props.demo?.tried ?? false);
  const [hueOpen, setHueOpen] = useState(false);
  const set = (change: Partial<BoxDraft>) => setD({ ...d, ...change });
  // There is always one empty place row at the end, showing an example.
  const rows: Place[] = [...d.places.filter((p) => p.name !== '' || p.folder !== ''), { name: '', folder: '' }];
  const setPlace = (i: number, p: Place) => set({ places: rows.map((r, j) => (j === i ? p : r)).filter((r) => r.name !== '' || r.folder !== '') });
  const faults = { ...draftFaults(d, props.taken), ...props.refused };
  const toFix = Object.keys(faults).filter((k) => tried || !['name', 'host', 'user'].includes(k) || faults[k] !== 'needed').length;
  const add = () => {
    setTried(true);
    if (Object.keys(draftFaults(d, props.taken)).length === 0 && !props.working) props.onAdd(d);
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.onCancel();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  const shown = (v: string) => tried || v !== '';
  return (
    <div class="scrim">
      <div class="dialog wide two dlg-main" id="add-box" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <h1 id="add-title"><Glyph name={editing ? 'edit' : 'box'} />{editing ? `Edit ${editing.draft.name}` : 'Add box'}</h1>
        <div class="cols">
          <div class="col">
            <div class="sect first">
              <SectionHead glyph="box" title="Box" />
              <div class="row">
                <Field id="box-name" glyph="name" label="Name" value={d.name} example="ledger-db" ch={22} focus check={required(checkName(d.name, props.taken), tried)} shown={shown(d.name)} onInput={(v) => set({ name: v })} onEnter={add} hue={d.colour} adorn={<HuePick colour={d.colour} open={hueOpen} toggle={() => setHueOpen(!hueOpen)} pick={(n) => { set({ colour: n }); setHueOpen(false); }} />} />
              </div>
            </div>

            <div class="sect">
              <SectionHead glyph="network" title="Address" />
              <div class="row">
                <Field id="box-host" glyph="host" label="Host" value={d.host} example="203.0.113.58" ch={20} mono check={required(checkHost(d.host), tried)} shown={shown(d.host)} onInput={(v) => set({ host: v.trim() })} onEnter={add} />
                <Field id="box-port" glyph="port" label="Port" value={d.port} example="22" ch={6} mono check={checkPort(d.port)} shown={shown(d.port)} onInput={(v) => set({ port: v.trim() })} onEnter={add} />
                <Field id="box-user" glyph="user" label="User" value={d.user} example="deploy" ch={14} mono check={required(checkUser(d.user), tried)} shown={shown(d.user)} onInput={(v) => set({ user: v.trim() })} onEnter={add} />
              </div>
            </div>

            <div class="sect">
              <SectionHead glyph="start" title="Starting folder" />
              <div class="row">
                <Field id="box-folder" glyph="start" label="Opens in" value={d.folder} example="/srv/ledger" ch={30} mono check={checkFolder(d.folder)} shown={shown(d.folder)} onInput={(v) => set({ folder: v })} onEnter={add} />
              </div>
            </div>
          </div>
          <div class="col">
            <div class="sect first">
              <SectionHead glyph="place" title="Places" aside="each opens its own tab" />
              <div class="places tight">
                <div class="places-head"><span><Glyph name="place" />Place</span><span><Glyph name="folder" />Folder</span></div>
                {rows.map((p, i) => {
                  const last = i === rows.length - 1;
                  const c = last ? null : checkPlace(p, rows.filter((o, j) => j !== i && !(o.name === '' && o.folder === '')));
                  return (
                    <div class="place-edit" key={i}>
                      <span class={`input sized ${c?.state === 'fix' && p.name === '' ? 'wrong' : ''}`} style={{ '--w': '14ch' }}>
                        <input id={`place-${i}-name`} type="text" autocomplete="off" spellcheck={false} placeholder={last ? 'logs' : ''} value={p.name} onInput={(e) => setPlace(i, { ...p, name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
                      </span>
                      <span class={`input sized mono ${c?.state === 'fix' && p.name !== '' ? 'wrong' : ''}`} style={{ '--w': '25ch' }}>
                        <input id={`place-${i}-folder`} type="text" autocomplete="off" spellcheck={false} placeholder={last ? '/var/log/ledger' : ''} value={p.folder} onInput={(e) => setPlace(i, { ...p, folder: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
                      </span>
                      {!last && <button type="button" class="pl-x-btn" aria-label={`Remove place ${p.name}`} onClick={() => set({ places: rows.filter((_, j) => j !== i && j !== rows.length - 1) })}><Glyph name="close" class="pl-x" /></button>}
                      {c?.state === 'fix' && <span class="check check-fix row-check"><Glyph name="fix" />{c.text}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div class="sect key-sect first-gap">
              <Glyph name="key" class="key-glyph" />
              <div class="key-main">
                <div class="key-line">{editing ? 'This box keeps the key Berth made for it' : 'Berth makes a new key for this box'}</div>
                <div class="key-sub">ed25519, kept only inside your locked list</div>
              </div>
            </div>
            {editing && (
              <div class="sect">
                <SectionHead glyph="identity" title="Its identity" />
                {editing.pinFingerprint === '' ? (
                  <div class="key-row" id="edit-unpinned">
                    <Glyph name="identityBroken" class="key-glyph" />
                    <div class="key-main">
                      <div class="key-line">Not checked yet</div>
                      <div class="key-sub">it is checked when you open it</div>
                    </div>
                  </div>
                ) : (
                  <div class="key-row" id="edit-pinned">
                    <Glyph name="identity" class="key-glyph" />
                    <div class="key-main">
                      <div class="key-line">{editing.pinType}, pinned {editing.pinnedAt.slice(0, 10)}</div>
                      <div class="key-sub mono">{editing.pinFingerprint}</div>
                    </div>
                    <button type="button" class="btn keep-plain" id="edit-forget" onClick={editing.onForget}>
                      <Glyph name="identityBroken" />Forget it
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div class="dlg-actions">
          {props.error !== '' && <span class="to-fix" id="add-error"><Glyph name="fix" />{props.error}</span>}
          {props.error === '' && toFix > 0 && <span class="to-fix" id="add-to-fix"><Glyph name="fix" />{toFix} {toFix === 1 ? 'field' : 'fields'} to fix</span>}
          <button type="button" class="btn keep-plain" id="add-cancel" onClick={props.onCancel}><Glyph name="close" />Cancel</button>
          <button type="button" class={`btn primary ${props.working ? 'waiting' : ''}`} id="add-submit" onClick={add}>
            {props.working ? <><span class="wait-ring" />{editing ? 'Saving' : 'Making its key'}</> : <>{editing ? <><Glyph name="check" />Save</> : <><Glyph name="plus" />Add box</>}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the first-connection check

export interface CheckActions {
  copy(): void;
  paste(text: string): void;
  again(): void;
  trust(): void;
  close(): void;
}

const clock = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toTimeString().slice(0, 8);
};

// What a box that cannot be reached is said as: one cause, in words, and what may be behind it.
function unreachableWords(c: CheckShown): { title: string; sub: string } {
  const asked = c.askedAt.map(clock).filter(Boolean);
  const when = asked.length === 0 ? '' : asked.length === 1 ? `Asked at ${asked[0]}.` : `Asked at ${asked.slice(0, -1).join(', ')} and ${asked[asked.length - 1]}.`;
  switch (c.cause) {
    case 'timed-out':
      return c.phase === 'connecting' ? { title: `No answer from ${c.addr} within 10 s`, sub: `${when} The box may be off, the port closed, or a firewall in between.` } : { title: `${c.addr} took too long to agree keys`, sub: `${when} It answered, then stopped within the key exchange.` };
    case 'refused':
      return { title: `${c.addr} refused the connection`, sub: `${when} Nothing listens on that port, or something in between refuses it.` };
    case 'unreachable':
      return { title: `${c.addr} cannot be reached`, sub: `${when} No route to it, no network here, or its name did not resolve.` };
    case 'weak-offer':
      return { title: `${c.name} offers only weaker ${c.what === 'identity algorithm' ? 'identities' : c.what === 'key exchange' ? 'key exchanges' : 'ciphers'}`, sub: `Berth offers ${c.ours.join(', ')}. The box offers ${c.theirs.join(', ')}.` };
    case 'reset':
      return { title: `The connection to ${c.addr} was reset`, sub: when };
    case 'closed-by-box':
      return { title: `${c.addr} closed the connection`, sub: when };
    default:
      return { title: `${c.addr} could not be asked who it is`, sub: `${when} ${c.detail}` };
  }
}

function RunStep(props: { c: CheckShown; act: CheckActions }) {
  return (
    <div class="step">
      <span class="step-n">1</span>
      <div class="step-main">
        <div class="step-title"><Glyph name="term" />Run this on {props.c.name}, from a place you already trust</div>
        <div class="step-sub">The provider's web console, or the MobaXterm session you use for it today. It adds Berth's key and prints the box's identity.</div>
        <div class="codeblock">
          <code id="check-block">{props.c.block}</code>
          <button type="button" class="btn quiet copy" id="check-copy" onClick={props.act.copy}><Glyph name="copy" />Copy</button>
        </div>
      </div>
    </div>
  );
}

// The type a pasted line names for a fingerprint, as ssh-keygen prints it: "256 SHA256:... comment (ED25519)".
function typeIn(pasted: string, fingerprint: string): string {
  const line = pasted.split('\n').find((l) => l.includes(fingerprint)) ?? '';
  return /\(([A-Z0-9-]{2,12})\)\s*$/.exec(line.trim())?.[1] ?? '';
}

export function CheckDialog(props: { c: CheckShown; act: CheckActions; demoPaste?: string }) {
  const c = props.c;
  const [pasted, setPasted] = useState(props.demoPaste ?? '');
  const sent = useRef('');
  // A paste made while the box was still being asked is compared as soon as the box has answered.
  useEffect(() => {
    if (c.step === 'reached' && pasted.trim() !== '' && sent.current !== pasted) {
      sent.current = pasted;
      props.act.paste(pasted);
    }
  }, [c.step, pasted]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.act.close();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  const onPaste = (text: string) => {
    setPasted(text);
    if (c.step === 'reached' || c.step === 'match' || c.step === 'mismatch') {
      sent.current = text;
      props.act.paste(text);
    }
  };
  const mismatch = c.step === 'mismatch';
  const kindOf = (t: string) => (t === 'ssh-ed25519' ? 'ED25519' : t === 'ssh-rsa' ? 'RSA' : t);
  return (
    <div class="scrim">
      <div class={`dialog wide ${mismatch ? 'dlg-problem' : 'dlg-checked'}`} id="check" data-step={c.step} role="dialog" aria-modal="true" aria-labelledby="check-title">
        {mismatch ? (
          <h1 id="check-title"><Glyph name="identityBroken" />The box Berth reached is not the box you ran it on</h1>
        ) : (
          <h1 id="check-title"><Glyph name="identity" />Check {c.name} before the first sign-in</h1>
        )}
        <RunStep c={c} act={props.act} />

        {c.step === 'unreachable' ? (
          <>
            <div class="step">
              <span class="step-n">2</span>
              <div class="step-main">
                <div class="step-title"><Glyph name="network" />Reach {c.name}</div>
                <div class="reach-bar" id="check-unreachable">
                  <Glyph name="silent" />
                  <div>
                    <div class="reach-title">{unreachableWords(c).title}</div>
                    <div class="reach-sub">{unreachableWords(c).sub}</div>
                  </div>
                  <button type="button" class="btn quiet" id="check-again" onClick={props.act.again}><Glyph name="reconnect" />Try again</button>
                </div>
              </div>
            </div>
            <div class="dlg-actions gap-top">
              <button type="button" class="btn keep-plain" id="check-close" onClick={props.act.close}><Glyph name="close" />Close</button>
            </div>
          </>
        ) : (
          <>
            <div class="step">
              <span class="step-n">2</span>
              <div class="step-main">
                <div class="step-title"><Glyph name="paste" />Paste what it printed</div>
                <textarea class="pastebox" id="check-paste" spellcheck={false} rows={3} placeholder={`256 SHA256:… root@${c.name} (ED25519)`} value={pasted} onInput={(e) => onPaste((e.target as HTMLTextAreaElement).value)} />
                {c.step === 'reaching' && <span class="check check-hint" id="check-reaching"><span class="wait-ring small" />Asking {c.addr} who it is{c.phase === 'key-exchange' ? ': it answered, agreeing keys' : ''}</span>}
                {c.step === 'reached' && c.detail !== '' && <span class="check check-fix" id="check-detail"><Glyph name="fix" />{c.detail}</span>}
              </div>
            </div>

            {c.step === 'match' && (
              <div class="verdict ok" id="check-verdict">
                <Glyph name="check" />
                <div>
                  <div class="verdict-title">The box Berth reached is the box you ran it on</div>
                  <div class="verdict-sub mono">{kindOf(c.shownType)} {c.shownFingerprint}</div>
                </div>
              </div>
            )}

            {mismatch && (
              <>
                <div class="fp-pair indent" id="check-mismatch">
                  <div class="fp">
                    <div class="fp-label"><Glyph name="paste" />Printed on {c.name}</div>
                    <div class="fp-val mono">{c.pasted.map((f) => <div key={f}>{typeIn(pasted, f) || '?'}<br />{f}</div>)}</div>
                  </div>
                  <div class="fp now">
                    <div class="fp-label"><Glyph name="identityBroken" />Answered at {c.addr}</div>
                    <div class="fp-val mono">{kindOf(c.shownType)}<br />{c.shownFingerprint}</div>
                  </div>
                </div>
                <p class="dlg-fact indent">Nothing was trusted or saved, and no key was used. Check the address, or paste again from {c.name} itself.</p>
              </>
            )}

            <div class={`dlg-actions ${mismatch || c.step === 'match' ? '' : 'gap-top'}`}>
              {mismatch && <button type="button" class="btn quiet" id="check-again" onClick={props.act.again}><Glyph name="reconnect" />Check again</button>}
              <button type="button" class={`btn ${mismatch ? 'keep' : 'keep-plain'}`} id="check-close" onClick={props.act.close}><Glyph name="close" />{mismatch ? 'Close' : 'Cancel'}</button>
              {c.step === 'match' && <button type="button" class="btn primary" id="check-trust" onClick={props.act.trust}><Glyph name="identity" />Trust and connect</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// A box that showed another identity than the pinned one: a hard stop. Nothing here connects.
export function ChangedDialog(props: { name: string; addr: string; pinType: string; pinFingerprint: string; pinnedAt: string; shownFingerprint: string; onClose(): void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  return (
    <div class="scrim">
      <div class="dialog wide dlg-problem" id="changed" role="dialog" aria-modal="true" aria-labelledby="chg-title">
        <h1 id="chg-title"><Glyph name="identityBroken" />{props.name} is not the box Berth knows</h1>
        <p class="dlg-lead">The box at {props.addr} answered with another identity than the one pinned for {props.name}. Berth stopped before signing in: no key was used and nothing was sent.</p>
        <div class="fp-pair">
          <div class="fp">
            <div class="fp-label"><Glyph name="identity" />Pinned, {props.pinnedAt.slice(0, 10)}</div>
            <div class="fp-val mono">{props.pinType}<br />{props.pinFingerprint}</div>
          </div>
          <div class="fp now">
            <div class="fp-label"><Glyph name="identityBroken" />Shown now</div>
            <div class="fp-val mono">{props.pinType}<br />{props.shownFingerprint}</div>
          </div>
        </div>
        <p class="dlg-fact">If {props.name} was rebuilt, its new identity is checked again the same way as the first time.</p>
        <div class="dlg-actions">
          <button type="button" class="btn keep" id="changed-close" autofocus onClick={props.onClose}><Glyph name="close" />Close</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ delete a box

// Deleting a box takes its key with it, and a key that is gone cannot be made again: what it opened, it
// opened. So the question says what goes, and what stays on the box itself (plan A5: the line in its
// authorized_keys is the box's, not Berth's, and only the box can take it out).
export function RemoveBoxDialog(props: { box: BoxView; tabs: number; onRemove(): void; onCancel(): void }) {
  const b = props.box;
  // The way out is where the hands are: Keep it has the focus, so Enter keeps the box (BUILD-RULES 2.20).
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onCancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div class="scrim">
      <div class="dialog dlg-remove" id="remove-box" role="dialog" aria-modal="true" aria-labelledby="remove-title">
        <h1 id="remove-title"><Glyph name="stop" />Delete {b.name}?</h1>
        <ul class="goes" id="remove-goes">
          <li><Glyph name="box" /><span>{b.name}, {b.user}@{b.host}:{b.port}{b.places.length > 0 ? `, and its ${b.places.length} ${b.places.length === 1 ? 'place' : 'places'}` : ''}</span></li>
          <li><Glyph name="key" /><span>its key, which Berth made and holds nowhere else</span></li>
          {b.pinned ? <li><Glyph name="identity" /><span>the identity pinned for it on {b.pinnedAt.slice(0, 10)}</span></li> : null}
          {props.tabs > 0 ? <li><Glyph name="close" /><span>{props.tabs} open {props.tabs === 1 ? 'tab' : 'tabs'} on it, closed with it</span></li> : null}
        </ul>
        <p class="said quiet" id="remove-stays">
          The key line Berth asked you to add stays on the box itself: only the box can take it out.
        </p>
        <div class="dlg-actions">
          <button type="button" class="btn keep-plain" id="remove-cancel" ref={keep} onClick={props.onCancel}><Glyph name="close" />Keep it<kbd>Esc</kbd></button>
          <button type="button" class="btn primary" id="remove-do" onClick={props.onRemove}><Glyph name="stop" />Delete {b.name}</button>
        </div>
      </div>
    </div>
  );
}
