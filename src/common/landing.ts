// What a file from a box may be called once it is on the PC.
//
// A name on a box is bytes that box chose. Windows is far stricter than a box about what a name may be, and a
// few of its rules are not about tidiness at all: a colon makes a hidden second stream inside a file, a handful
// of names are devices whatever folder they are in, and Explorer acts on some file types merely by showing the
// folder they are in. So a name never lands as it was written: it is turned into one safe name here, and the
// window says when that happened (plan B4.2).
//
// Nothing here touches the disk. It is all decided from the name alone, so it can be tested exhaustively.

// Everything Windows refuses in a name, plus the colon, which it accepts and uses for something else entirely.
const REFUSED = /[<>:"/\\|?*\u0000-\u001f]/g;

// Names that are devices on Windows whatever folder they are in, and whatever is put after a dot.
const DEVICES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

// File types Explorer acts on merely by showing the folder: it reads them to decide what to draw, and two of
// them can point anywhere. A file of one of these kinds lands with a harmless ending added, and the row says so.
const ACTED_ON = new Set(['lnk', 'url', 'scf', 'library-ms', 'ini', 'desktoptheme', 'theme', 'cpl', 'search-ms', 'settingcontent-ms']);

// The longest a name may be on the file systems Windows uses.
const LONGEST = 255;

export interface Landed {
  name: string; // what it will be called on the PC
  changed: boolean; // the name is not the one the box used
  why: string; // why, in words for the row; empty when nothing changed
}

// safeName turns one name from a box into one name for the PC.
export function safeName(from: string): Landed {
  const reasons: string[] = [];

  // A name is a name, never a path: anything that looks like a folder in it is part of the name on the box,
  // and must not become one here. This is the rule that keeps a download inside the folder it was sent to.
  let name = from;
  if (REFUSED.test(name)) {
    REFUSED.lastIndex = 0;
    name = name.replace(REFUSED, '_');
    reasons.push('characters Windows cannot use');
  }
  REFUSED.lastIndex = 0;

  // "." and ".." are not names at all.
  if (name === '.' || name === '..') {
    name = name.replace(/\./g, '_');
    reasons.push('a name Windows cannot use');
  }

  // Windows quietly drops a trailing dot or space, so two different names on a box would become one here.
  const trimmed = name.replace(/[ .]+$/, '');
  if (trimmed !== name) {
    name = trimmed;
    reasons.push('a trailing dot or space');
  }

  // A device name is a device whatever is after the dot, so the stem is what matters.
  const stem = name.split('.')[0] ?? '';
  if (DEVICES.has(stem.toLowerCase())) {
    name = `_${name}`;
    reasons.push('a name Windows keeps for a device');
  }

  // A kind Explorer acts on by itself. The ending is added rather than the old one taken away, so the name
  // still says what the file was on the box.
  const dot = name.lastIndexOf('.');
  const ending = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ACTED_ON.has(ending) || name.toLowerCase() === 'desktop.ini') {
    name = `${name}.txt`;
    reasons.push('a kind Windows acts on by itself');
  }

  // Nothing left, or nothing but dots: it still needs a name.
  if (name === '' || /^\.+$/.test(name)) {
    name = name === '' ? 'file' : `_${name}`;
    reasons.push('a name Windows cannot use');
  }

  // Too long. The ending is kept, because it is what says what the file is.
  if (name.length > LONGEST) {
    const [, end] = split(name);
    name = name.slice(0, LONGEST - end.length) + end;
    reasons.push('longer than Windows allows');
  }

  return { name, changed: name !== from, why: reasons.join(', ') };
}

// freeName gives a name nothing already there is using. Windows pays no attention to case, so two names that
// differ only by case would be the same file: `taken` is compared without case for that reason.
//
// The number goes before the ending, as Windows does it: "kit (2).tar.gz", not "kit.tar.gz (2)".
export function freeName(wanted: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(wanted.toLowerCase())) return wanted;

  const [stem, end] = split(wanted);
  for (let n = 2; n < 10_000; n++) {
    const tryThis = `${stem} (${n})${end}`;
    if (!used.has(tryThis.toLowerCase())) return tryThis;
  }
  // Nothing free in ten thousand: the name carries the moment instead, which cannot already be taken.
  return `${stem} (${Date.now()})${end}`;
}


// A name's stem and its ending, decided once and used wherever an ending has to be kept. A name of several
// dots keeps the longest ending that is still plausible, so "kit.tar.gz" keeps ".tar.gz" and not only ".gz";
// a name that is all ending, like ".bashrc", has no ending to keep at all.
function split(name: string): [stem: string, end: string] {
  const parts = name.split('.');
  if (parts.length < 2 || parts[0] === '') return [name, ''];
  const endings = parts.slice(1);
  const keep = endings.length >= 2 && endings[endings.length - 2]!.length <= 4 && endings[endings.length - 2] !== '' ? 2 : 1;
  const stem = parts.slice(0, parts.length - keep).join('.');
  if (stem === '') return [name, ''];
  return [stem, `.${parts.slice(parts.length - keep).join('.')}`];
}
