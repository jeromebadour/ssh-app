// Step 2's screens, in direction A, for Kami's yes or no: the password (first start and every start), Add box,
// the first-connection check, and the stop when a box's identity changed. Built from the same components as the
// main window; invented data only (documentation addresses, made-up names).
import { Glyph } from './glyphs';
import { Mark } from './marks';

// ---------------------------------------------------------------- the password: the only screen before unlock

// First start: make the password. Typed twice; the rule shows as it is met; the backup folder is chosen here so
// that backups exist from the first save. One fact is said, because it costs more than it seems: no recovery.
export function CreateScreen() {
  return (
    <div class="gate">
      <div class="gate-card">
        <div class="gate-brand"><Mark /><span class="wordmark">Berth</span></div>
        <h1 class="gate-title">Make your password</h1>
        <p class="gate-lead">It locks your boxes and their keys. Berth asks for it at every start, and nowhere else.</p>
        <label class="field">
          <span class="field-label"><Glyph name="lock" />Password</span>
          <span class="input filled"><span class="dots">{'\u2022'.repeat(18)}</span></span>
          <span class="check check-ok"><Glyph name="ok" />18 characters: 12 or more</span>
        </label>
        <label class="field">
          <span class="field-label"><Glyph name="lock" />Again</span>
          <span class="input filled focus"><span class="dots">{'\u2022'.repeat(18)}</span><span class="caret-bar" /></span>
          <span class="check check-ok"><Glyph name="ok" />the same as above</span>
        </label>
        <label class="field">
          <span class="field-label"><Glyph name="folderPick" />Backup folder</span>
          <span class="input picker"><span class="path">D:\Backups\Berth</span><button class="pick"><Glyph name="folder" />Choose</button></span>
          <span class="check check-ok"><Glyph name="ok" />writable; a copy is written there at every change</span>
        </label>
        <p class="gate-fact">A forgotten password cannot be recovered. A backup opens only with the password it was saved under.</p>
        <button class="btn primary wide"><Glyph name="lock" />Lock with this password</button>
      </div>
    </div>
  );
}

// Every start: the mark and one field. No box name, no tab, no count.
export function UnlockScreen(props: { wrong?: boolean }) {
  return (
    <div class="gate">
      <div class="gate-card narrow">
        <div class="gate-brand big"><Mark /><span class="wordmark">Berth</span></div>
        <label class="field">
          <span class="field-label"><Glyph name="lock" />Password</span>
          <span class={`input filled ${props.wrong ? 'wrong focus-wrong' : 'focus'}`}>{props.wrong ? <><span class="caret-bar first" /><span class="example">Password</span></> : <><span class="dots">{'\u2022'.repeat(16)}</span><span class="caret-bar" /></>}</span>
          <span class="check check-hint kb"><Glyph name="name" />typing in English (US)<span class="kb-sep" />Caps Lock off</span>
        </label>
        {props.wrong ? (
          <>
            <span class="check check-fix gate-check"><Glyph name="fix" />Wrong password.</span>
            <button class="btn primary wide waiting"><span class="wait-ring" />Wait 2 s</button>
          </>
        ) : (
          <button class="btn primary wide"><Glyph name="lock" />Unlock</button>
        )}
        <p class="gate-saved">{props.wrong ? 'Second wrong try. Each one doubles the wait, up to 30 s.' : ''}</p>
      </div>
    </div>
  );
}

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
export function TrustDialog() {
  return (
    <div class="scrim">
      <div class="dialog wide dlg-checked" role="dialog" aria-modal="true" aria-labelledby="trust-title">
        <h1 id="trust-title"><Glyph name="identity" />Check ledger-db before the first sign-in</h1>

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
