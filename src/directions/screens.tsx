// Step 2's dialogs, in direction A, as approved 2026-11-16: Add box, the first-connection check, and the stop when
// a box's identity changed. (The password screens are the real app's now: src/ui/gate.tsx.) Built from the same components as the
// main window; invented data only (documentation addresses, made-up names).
import { Glyph } from '../ui/glyphs';

// ---------------------------------------------------------------- dialogs over the main window

// A field, the way every field in Berth is drawn: a label with its glyph, the input sized to the value it will
// hold, an example in it while empty, and under it either a hint or the live check of what was typed.
type Check = { state: 'ok' | 'fix' | 'hint'; text: string };
function Field(props: { glyph: string; label: string; value?: string; example?: string; ch: number; mono?: boolean; focus?: boolean; check?: Check }) {
  const c = props.check;
  return (
    <label class="field" style={{ '--w': `${props.ch}ch` }}>
      <span class="field-label"><Glyph name={props.glyph} />{props.label}</span>
      <span class={`input sized ${props.mono ? 'mono' : ''} ${props.focus ? 'focus' : ''} ${c?.state === 'fix' ? 'wrong' : ''}`}>
        {props.value ? <span class="val">{props.value}</span> : <span class="example">{props.example}</span>}
        {props.focus && <span class="caret-bar" />}
      </span>
      {c && <span class={`check check-${c.state}`}>{c.state !== 'hint' && <Glyph name={c.state === 'ok' ? 'ok' : 'fix'} />}{c.text}</span>}
    </label>
  );
}

function SectionHead(props: { glyph: string; title: string; aside?: string }) {
  return <div class="sect-head"><Glyph name={props.glyph} />{props.title}{props.aside && <span class="sect-aside">{props.aside}</span>}</div>;
}

// Add box: one dialog, in sections. Berth makes the box's key; an existing key file can be brought in once instead.
export function AddBoxDialog() {
  return (
    <div class="scrim">
      <div class="dialog wide two dlg-main" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <h1 id="add-title"><Glyph name="box" />Add box</h1>
        <div class="cols">
        <div class="col">
        <div class="sect first">
          <SectionHead glyph="box" title="Box" />
          <div class="row">
            <Field glyph="name" label="Name" value="ledger-db" ch={18} focus check={{ state: 'ok', text: 'free: no other box has it' }} />
            <div class="field">
              <span class="field-label"><Glyph name="palette" />Colour</span>
              <span class="swatches">
                {[1, 2, 3, 4, 5].map((n) => <span key={n} class={`swatch ${n === 4 ? 'on' : ''}`} style={{ '--hue': `var(--box-${n})` }} />)}
              </span>
              <span class="check check-hint">on its tabs, its terminal frame and its prompt</span>
            </div>
          </div>
        </div>

        <div class="sect">
          <SectionHead glyph="network" title="Address" />
          <div class="row">
            <Field glyph="host" label="Host" value="203.0.113.58" ch={20} mono check={{ state: 'ok', text: 'an IP address' }} />
            <Field glyph="port" label="Port" example="22" ch={6} mono check={{ state: 'hint', text: 'empty = 22' }} />
            <Field glyph="user" label="User" value="deploy" ch={14} mono check={{ state: 'ok', text: 'a valid account name' }} />
          </div>
        </div>

        <div class="sect">
          <SectionHead glyph="start" title="Starting folder" />
          <div class="row">
            <Field glyph="start" label="Opens in" value="/srv/ledger" ch={30} mono check={{ state: 'hint', text: 'when no place is chosen; a full path' }} />
          </div>
        </div>
        </div>
        <div class="col">
        <div class="sect first">
          <SectionHead glyph="place" title="Places" aside="each opens its own tab" />
          <div class="places tight">
            <div class="places-head"><span><Glyph name="place" />Place</span><span><Glyph name="folder" />Folder</span></div>
            <div class="place-edit">
              <span class="input sized" style={{ '--w': '14ch' }}><span class="val">db</span></span>
              <span class="input sized mono" style={{ '--w': '25ch' }}><span class="val">/srv/ledger/db</span></span>
              <Glyph name="close" class="pl-x" label="Remove place" />
            </div>
            <div class="place-edit">
              <span class="input sized" style={{ '--w': '14ch' }}><span class="val">backups</span></span>
              <span class="input sized mono wrong" style={{ '--w': '25ch' }}><span class="val">var/backups/ledger</span></span>
              <Glyph name="close" class="pl-x" label="Remove place" />
              <span class="check check-fix row-check"><Glyph name="fix" />a full path starts with /</span>
            </div>
            <div class="place-edit">
              <span class="input sized" style={{ '--w': '14ch' }}><span class="example">logs</span></span>
              <span class="input sized mono" style={{ '--w': '25ch' }}><span class="example">/var/log/ledger</span></span>
            </div>
          </div>
        </div>

        <div class="sect key-sect first-gap">
          <Glyph name="key" class="key-glyph" />
          <div class="key-main">
            <div class="key-line">Berth makes a new key for this box</div>
            <div class="key-sub">ed25519, kept only inside your locked list</div>
          </div>
          <button class="btn quiet"><Glyph name="fileKey" />Use a key file</button>
        </div>
        </div>
        </div>

        <div class="dlg-actions">
          <span class="to-fix"><Glyph name="fix" />1 field to fix</span>
          <button class="btn keep-plain"><Glyph name="close" />Cancel</button>
          <button class="btn primary"><Glyph name="plus" />Add box</button>
        </div>
      </div>
    </div>
  );
}

const ADD_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2vQ8n4Lm0pR7tYw3sZc6dF1hJ9kX5bN2gU8eA4iV0q berth:ledger-db';
const RUN = `umask 077; mkdir -p ~/.ssh && echo '${ADD_KEY}' >> ~/.ssh/authorized_keys && for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done`;

// The first connection: one block to run on the box in a trusted place; its output pasted back; only then is the
// box's identity compared and pinned. The fingerprint Berth received is not shown until the paste was compared.
function RunStep() {
  return (
        <div class="step">
          <span class="step-n">1</span>
          <div class="step-main">
            <div class="step-title"><Glyph name="term" />Run this on ledger-db, from a place you already trust</div>
            <div class="step-sub">The provider's web console, or the MobaXterm session you use for it today. It adds Berth's key and prints the box's identity.</div>
            <div class="codeblock">
              <code>{RUN}</code>
              <button class="btn quiet copy"><Glyph name="copy" />Copy</button>
            </div>
          </div>
        </div>
  );
}

export function TrustDialog() {
  return (
    <div class="scrim">
      <div class="dialog wide dlg-checked" role="dialog" aria-modal="true" aria-labelledby="trust-title">
        <h1 id="trust-title"><Glyph name="identity" />Check ledger-db before the first sign-in</h1>
        <RunStep />

        <div class="step">
          <span class="step-n">2</span>
          <div class="step-main">
            <div class="step-title"><Glyph name="paste" />Paste what it printed</div>
            <div class="pastebox">
              <div>256 SHA256:Xk3v9Qm0bT2rP8sLw1YhN7cJ4dF6gA5eZ0uI9oK2pQs root@ledger-db (ED25519)</div>
              <div>3072 SHA256:p1Rt7Cz5Hm2Ve8Yq4Lb0Wn6Ks3Df9Gj1Ax7Ue5Io2Tc root@ledger-db (RSA)</div>
              <div>256 SHA256:nB4yE8wQ2oL6cT0vR9mK3jH7gF5dS1aZ8xU4iP6eW2k root@ledger-db (ECDSA)</div>
            </div>
          </div>
        </div>

        <div class="verdict ok">
          <Glyph name="check" />
          <div>
            <div class="verdict-title">The box Berth reached is the box you ran it on</div>
            <div class="verdict-sub mono">ED25519 SHA256:Xk3v9Qm0bT2rP8sLw1YhN7cJ4dF6gA5eZ0uI9oK2pQs</div>
          </div>
        </div>

        <div class="dlg-actions">
          <button class="btn keep-plain"><Glyph name="close" />Cancel</button>
          <button class="btn primary"><Glyph name="identity" />Trust and connect</button>
        </div>
      </div>
    </div>
  );
}

// The paste does not match: another box answered at that address, or the lines came from another box. Both are
// shown side by side; nothing is stored, and there is no way to trust from here.
export function MismatchDialog() {
  return (
    <div class="scrim">
      <div class="dialog wide dlg-problem" role="dialog" aria-modal="true" aria-labelledby="mis-title">
        <h1 id="mis-title"><Glyph name="identityBroken" />The box Berth reached is not the box you ran it on</h1>
        <RunStep />

        <div class="step">
          <span class="step-n">2</span>
          <div class="step-main">
            <div class="step-title"><Glyph name="paste" />Paste what it printed</div>
            <div class="pastebox">
              <div>256 SHA256:Xk3v9Qm0bT2rP8sLw1YhN7cJ4dF6gA5eZ0uI9oK2pQs root@ledger-db (ED25519)</div>
              <div>3072 SHA256:p1Rt7Cz5Hm2Ve8Yq4Lb0Wn6Ks3Df9Gj1Ax7Ue5Io2Tc root@ledger-db (RSA)</div>
            </div>
          </div>
        </div>

        <div class="fp-pair indent">
          <div class="fp">
            <div class="fp-label"><Glyph name="paste" />Printed on ledger-db</div>
            <div class="fp-val mono">ED25519<br />SHA256:Xk3v9Qm0bT2rP8sLw1YhN7cJ4dF6gA5eZ0uI9oK2pQs</div>
          </div>
          <div class="fp now">
            <div class="fp-label"><Glyph name="identityBroken" />Answered at 203.0.113.58:22</div>
            <div class="fp-val mono">ED25519<br />SHA256:9fWb2Kx7Qe4Tn1Vc8Rm5Ly3Hs6Ju0Gd2Pa9Zo4Ei7Fk</div>
          </div>
        </div>
        <p class="dlg-fact indent">Nothing was trusted or saved, and no key was used. Check the address in Edit box, or paste again from ledger-db itself.</p>

        <div class="dlg-actions">
          <button class="btn quiet"><Glyph name="edit" />Edit ledger-db</button>
          <button class="btn quiet"><Glyph name="reconnect" />Check again</button>
          <button class="btn keep" autofocus><Glyph name="close" />Close</button>
        </div>
      </div>
    </div>
  );
}

// The box cannot be reached: said with the exact cause and when, in place of the paste step (there is nothing to
// compare a paste with yet). Step 1 stays: the block can be run meanwhile.
export function UnreachableDialog() {
  return (
    <div class="scrim">
      <div class="dialog wide dlg-checked" role="dialog" aria-modal="true" aria-labelledby="unr-title">
        <h1 id="unr-title"><Glyph name="identity" />Check ledger-db before the first sign-in</h1>
        <RunStep />

        <div class="step">
          <span class="step-n">2</span>
          <div class="step-main">
            <div class="step-title"><Glyph name="network" />Reach ledger-db</div>
            <div class="reach-bar">
              <Glyph name="silent" />
              <div>
                <div class="reach-title">No answer from 203.0.113.58:22 within 10 s</div>
                <div class="reach-sub">Asked at 06:41:12 and 06:41:31. The box may be off, the port closed, or a firewall in between.</div>
              </div>
              <button class="btn quiet"><Glyph name="reconnect" />Try again</button>
            </div>
          </div>
        </div>

        <div class="dlg-actions gap-top">
          <button class="btn quiet"><Glyph name="edit" />Edit ledger-db</button>
          <button class="btn keep-plain"><Glyph name="close" />Close</button>
        </div>
      </div>
    </div>
  );
}

// A box that shows another identity than the pinned one: a hard stop. Nothing here connects.
export function ChangedDialog() {
  return (
    <div class="scrim">
      <div class="dialog wide dlg-problem" role="dialog" aria-modal="true" aria-labelledby="chg-title">
        <h1 id="chg-title"><Glyph name="identityBroken" />vault-ams is not the box Berth knows</h1>
        <p class="dlg-lead">The box at 198.51.100.9 answered with another identity than the one pinned for vault-ams. Berth stopped before signing in: no key was used and nothing was sent.</p>
        <div class="fp-pair">
          <div class="fp">
            <div class="fp-label"><Glyph name="identity" />Pinned, 2026-11-02</div>
            <div class="fp-val mono">ED25519<br />SHA256:Lq8eN3vB6kR1tY9wM4cZ7hP2sD5gJ0fX3aU8oI6eT1n</div>
          </div>
          <div class="fp now">
            <div class="fp-label"><Glyph name="identityBroken" />Shown now</div>
            <div class="fp-val mono">ED25519<br />SHA256:9fWb2Kx7Qe4Tn1Vc8Rm5Ly3Hs6Ju0Gd2Pa9Zo4Ei7Fk</div>
          </div>
        </div>
        <p class="dlg-fact">If vault-ams was rebuilt, its new identity is checked again the same way as the first time, from Edit box.</p>
        <div class="dlg-actions">
          <button class="btn quiet"><Glyph name="edit" />Edit vault-ams</button>
          <button class="btn keep" autofocus><Glyph name="close" />Close</button>
        </div>
      </div>
    </div>
  );
}
