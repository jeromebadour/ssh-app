// The name Berth offers for a file it is about to write from what a box printed (SSH-APP-DETAILS 7, "Save
// output"). It is a rule about names and nothing else, so it lives here on its own and is tested as what it
// is, as the rule for a new session does.
//
// A box's own name reaches this, because the file is named after the box the text came from. So what leaves
// here is a name and never a path: every character outside a short safe set becomes an underscore, so
// nothing a box or a list is called can name a folder, climb out of one with dots, or be one of the device
// names Windows answers to whatever folder it is in.
export const saveName = (box: string, place: string, at: Date, kind: string): string => {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}`;
  const plain = [box, place, kind === 'block' ? 'command' : '', stamp].filter((part) => part !== '').join(' ');
  let out = '';
  for (const ch of plain) out += /[A-Za-z0-9 ._-]/.test(ch) ? ch : '_';
  // Runs of dots become one, so no name ever holds "..", whatever a box is called, and nothing at either
  // end that Windows takes off itself (a trailing dot or space makes a name it cannot open again). Short
  // enough, too, that the whole path stays well inside what Windows takes.
  out = out.replace(/\.{2,}/g, '.').replace(/^[ .]+/, '').replace(/[ .]+$/, '').slice(0, 96).replace(/[ .]+$/, '');
  return `${out === '' ? 'Berth output' : out}.txt`;
};
