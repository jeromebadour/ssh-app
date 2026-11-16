// A box, as the app keeps it inside the locked list, and the one set of rules for what each of its fields may
// hold. The Add box dialog checks with these as you type; main checks with the same ones before anything is
// saved or used. No key is in here: a box names its key, and only the key process holds it.

export const BOX_COLOURS = 5;
export const BOXES_MAX = 200;
export const PLACES_MAX = 24;
export const NAME_MAX = 32;
export const HOST_MAX = 253;
export const USER_MAX = 32;
export const FOLDER_MAX = 1024;
export const PASTE_MAX = 16 * 1024; // the most text taken from a paste into the first-connection check

export interface Place {
  name: string;
  folder: string;
}

export interface Box {
  id: string; // made by the app; also the name the key process knows this box's key by
  name: string;
  colour: number; // 1 to BOX_COLOURS
  host: string;
  port: number;
  user: string;
  folder: string; // where a tab opens when no place is chosen; empty for the account's own home
  places: Place[];
  publicKey: string; // the public half of this box's key, one authorized-keys line
  pin: string; // the box's identity, one authorized-keys line; empty until the first-connection check passed
  pinFingerprint: string; // SHA256:..., as OpenSSH prints it
  pinnedAt: string; // when it was pinned (UTC); empty until then
  created: string;
}

// What Add box is given. Port is text here because an empty field means 22.
export interface BoxDraft {
  name: string;
  colour: number;
  host: string;
  port: string;
  user: string;
  folder: string;
  places: Place[];
}

// A check's answer: fine (with what was understood), to fix (with what), or only a hint for an empty field.
export interface Check {
  state: 'ok' | 'fix' | 'hint';
  text: string;
}

const ok = (text: string): Check => ({ state: 'ok', text });
const fix = (text: string): Check => ({ state: 'fix', text });
const hint = (text: string): Check => ({ state: 'hint', text });

// Any character that could be read as something else on a trusted surface or in a command: controls, and the
// marks that change the direction or the joining of text.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/;

export function checkName(name: string, taken: readonly string[]): Check {
  if (name === '') return hint('how its tabs are named');
  if (name !== name.trim()) return fix('no space at either end');
  if (name.length > NAME_MAX) return fix(`${NAME_MAX} characters at most`);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) || UNSAFE.test(name)) return fix('letters, digits, spaces, dots, dashes');
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return fix('another box has this name');
  return ok('free: no other box has it');
}

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isV6(host: string): boolean {
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(host) || !host.includes(':')) return false;
  const halves = host.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string): number => {
    if (part === '') return 0;
    let n = 0;
    const words = part.split(':');
    for (const [i, w] of words.entries()) {
      if (i === words.length - 1 && w.includes('.')) {
        if (!V4.test(w)) return -1;
        n += 2;
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(w)) n += 1;
      else return -1;
    }
    return n;
  };
  const left = groups(halves[0] ?? '');
  const right = halves.length === 2 ? groups(halves[1] ?? '') : 0;
  if (left < 0 || right < 0) return false;
  return halves.length === 2 ? left + right <= 7 : left === 8;
}

export function checkHost(host: string): Check {
  if (host === '') return hint('an IP address or a name');
  if (host.length > HOST_MAX || UNSAFE.test(host) || /\s/.test(host)) return fix('an IP address or a name, nothing else');
  if (V4.test(host)) return ok('an IP address');
  if (isV6(host)) return ok('an IPv6 address');
  if (/^[\d.]+$/.test(host)) return fix('not a complete IP address');
  if (HOSTNAME.test(host)) return ok('a name: looked up when connecting');
  return fix('an IP address or a name, nothing else');
}

export function portOf(port: string): number {
  if (port === '') return 22;
  if (!/^[1-9]\d{0,4}$/.test(port)) return 0;
  const n = Number(port);
  return n <= 65535 ? n : 0;
}

export function checkPort(port: string): Check {
  if (port === '') return hint('empty = 22');
  return portOf(port) ? ok('valid') : fix('1 to 65535');
}

export function checkUser(user: string): Check {
  if (user === '') return hint('the account to sign in as');
  if (user.length > USER_MAX) return fix(`${USER_MAX} characters at most`);
  return /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(user) ? ok('a valid account name') : fix('letters, digits, _ . - only');
}

// A folder on a box: a full path, and nothing in it that could not be shown or quoted safely.
export function folderFault(folder: string): string {
  if (!folder.startsWith('/')) return 'a full path starts with /';
  if (folder.length > FOLDER_MAX) return `${FOLDER_MAX} characters at most`;
  if (UNSAFE.test(folder)) return 'no control characters';
  return '';
}

export function checkFolder(folder: string): Check {
  if (folder === '') return hint('when no place is chosen; a full path');
  const fault = folderFault(folder);
  return fault ? fix(fault) : ok('a full path');
}

// A place's row. A row left wholly empty is no place and is dropped; a row half filled is to fix.
export function checkPlace(place: Place, others: readonly Place[]): Check | null {
  if (place.name === '' && place.folder === '') return null;
  if (place.name === '') return fix('a place needs a name');
  if (place.name !== place.name.trim() || place.name.length > NAME_MAX || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(place.name) || UNSAFE.test(place.name)) return fix('a short name: letters, digits, dashes');
  if (others.some((o) => o.name.toLowerCase() === place.name.toLowerCase())) return fix('two places with one name');
  const fault = folderFault(place.folder);
  return fault ? fix(fault) : ok('');
}

export function placesOf(draft: BoxDraft): Place[] {
  return draft.places.filter((p) => p.name !== '' || p.folder !== '');
}

// Everything still to fix in a draft, by field; empty when it can be added. An empty required field counts.
export function draftFaults(draft: BoxDraft, taken: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const need = (key: string, c: Check, required: boolean): void => {
    if (c.state === 'fix') out[key] = c.text;
    else if (c.state === 'hint' && required) out[key] = 'needed';
  };
  need('name', checkName(draft.name, taken), true);
  need('host', checkHost(draft.host), true);
  need('port', checkPort(draft.port), false);
  need('user', checkUser(draft.user), true);
  need('folder', checkFolder(draft.folder), false);
  if (!Number.isInteger(draft.colour) || draft.colour < 1 || draft.colour > BOX_COLOURS) out['colour'] = 'one of the colours';
  const places = placesOf(draft);
  if (places.length > PLACES_MAX) out['places'] = `${PLACES_MAX} places at most`;
  for (const [i, p] of draft.places.entries()) {
    const c = checkPlace(p, draft.places.filter((o, j) => j !== i && (o.name !== '' || o.folder !== '')));
    if (c?.state === 'fix') out[`place-${i}`] = c.text;
  }
  return out;
}

// host:port, as a connection wants it.
export function addrOf(box: Pick<Box, 'host' | 'port'>): string {
  return box.host.includes(':') ? `[${box.host}]:${box.port}` : `${box.host}:${box.port}`;
}

// The shapes of what the engine and the key process hand to main about keys. Main treats both as text it
// never reads into: it only checks that each has the shape of what it claims to be.
export const KEY_LINE = /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]{40,1100}={0,2}$/;
export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

// Every fingerprint in a pasted text, as OpenSSH prints them. Nothing else in the paste is read.
export function fingerprintsIn(pasted: string): string[] {
  return [...pasted.slice(0, PASTE_MAX).matchAll(/(?<![A-Za-z0-9+/:])SHA256:[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=])/g)].map((m) => m[0]);
}

// The one block to run on the box (plan B2.3): the approved text, with the box's own key line in it.
export function firstConnectionBlock(template: string, publicKey: string, boxName: string): string {
  if (!KEY_LINE.test(publicKey)) throw new Error('not a key line');
  const label = boxName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, NAME_MAX);
  return template.replace('{KEY}', `${publicKey} berth:${label}`);
}
