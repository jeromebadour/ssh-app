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
          <span class="field-label">Password</span>
          <span class="input filled"><Glyph name="lock" /><span class="dots">{'\u2022'.repeat(18)}</span></span>
        </label>
        <label class="field">
          <span class="field-label">Again</span>
          <span class="input filled focus"><Glyph name="lock" /><span class="dots">{'\u2022'.repeat(18)}</span><span class="caret-bar" /></span>
        </label>
        <ul class="rules">
          <li class="met"><Glyph name="check" />12 characters or more</li>
          <li class="met"><Glyph name="check" />Both the same</li>
        </ul>
        <label class="field">
          <span class="field-label">Backup folder</span>
          <span class="input picker"><Glyph name="folderPick" /><span class="path">D:\Backups\Berth</span><button class="pick">Change</button></span>
          <span class="field-note">A copy is written there at every change, locked with the same password.</span>
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
          <span class="sr-only">Password</span>
          <span class={`input filled ${props.wrong ? 'wrong' : 'focus'}`}><Glyph name="lock" /><span class="dots">{props.wrong ? '' : '\u2022'.repeat(16)}</span>{!props.wrong && <span class="caret-bar" />}</span>
        </label>
        {props.wrong ? (
          <>
            <p class="gate-wrong"><Glyph name="identityBroken" /><span>Wrong password.</span></p>
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

// Add box: one dialog. Berth makes the box's key; an existing key file can be brought in once instead.
export function AddBoxDialog() {
  return (
    <div class="scrim">
      <div class="dialog wide dlg-main" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <h1 id="add-title"><Glyph name="box" />Add box</h1>
        <div class="form-grid">
          <label class="field span-2">
            <span class="field-label">Name</span>
            <span class="input filled focus"><span class="val">ledger-db</span><span class="caret-bar" /></span>
          </label>
          <label class="field">
            <span class="field-label">Colour</span>
            <span class="swatches">
              {[1, 2, 3, 4, 5].map((n) => <span key={n} class={`swatch ${n === 4 ? 'on' : ''}`} style={{ '--hue': `var(--box-${n})` }} />)}
            </span>
          </label>
          <label class="field span-2">
            <span class="field-label">Host</span>
            <span class="input filled mono"><span class="val">203.0.113.58</span></span>
          </label>
          <label class="field">
            <span class="field-label">Port</span>
            <span class="input filled mono"><span class="val">22</span></span>
          </label>
          <label class="field span-2">
            <span class="field-label">User</span>
            <span class="input filled mono"><span class="val">deploy</span></span>
          </label>
          <label class="field">
            <span class="field-label">Starting folder</span>
            <span class="input filled mono"><span class="val">/srv/ledger</span></span>
          </label>
        </div>

        <div class="sect">
          <div class="sect-head"><Glyph name="place" />Places<span class="sect-aside">each opens its own tab in its folder</span></div>
          <div class="place-row"><span class="pl-name">db</span><span class="pl-path">/srv/ledger/db</span><Glyph name="close" class="pl-x" label="Remove place" /></div>
          <div class="place-row"><span class="pl-name">backups</span><span class="pl-path">/var/backups/ledger</span><Glyph name="close" class="pl-x" label="Remove place" /></div>
          <button class="link-btn"><Glyph name="plus" />Add place</button>
        </div>

        <div class="sect key-sect">
          <Glyph name="key" class="key-glyph" />
          <div class="key-main">
            <div class="key-line">Berth makes a new key for this box</div>
            <div class="key-sub">ed25519, kept only inside your locked list</div>
          </div>
          <button class="btn quiet"><Glyph name="fileKey" />Use a key file instead</button>
        </div>

        <div class="dlg-actions">
          <button class="btn keep-plain">Cancel</button>
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
            <div class="step-title">Run this on ledger-db, from a place you already trust</div>
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
            <div class="step-title">Paste what it printed</div>
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
          <button class="btn keep-plain">Cancel</button>
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
            <div class="fp-label">Pinned, 2026-11-02</div>
            <div class="fp-val mono">ED25519<br />SHA256:Lq8eN3vB6kR1tY9wM4cZ7hP2sD5gJ0fX3aU8oI6eT1n</div>
          </div>
          <div class="fp now">
            <div class="fp-label">Shown now</div>
            <div class="fp-val mono">ED25519<br />SHA256:9fWb2Kx7Qe4Tn1Vc8Rm5Ly3Hs6Ju0Gd2Pa9Zo4Ei7Fk</div>
          </div>
        </div>
        <p class="dlg-fact">If vault-ams was rebuilt, its new identity is checked again the same way as the first time, from Edit box.</p>
        <div class="dlg-actions">
          <button class="btn quiet"><Glyph name="edit" />Edit vault-ams</button>
          <button class="btn keep" autofocus>Close</button>
        </div>
      </div>
    </div>
  );
}
