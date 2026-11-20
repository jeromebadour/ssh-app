// The path, as the steps a person presses to walk back up it.
//
// Pure: no DOM, no state, so what it decides can be held by a test rather than only by a run of the whole
// app on a screen. The bar that draws it is in files.ts.

export interface Step {
  name: string; // what the step says: the folder's own name, or "/" for the root
  at: string; // the folder it goes to, as a whole path
}

// Every folder on the way to this one. /var/log/ledger is / then /var then /var/log then /var/log/ledger.
// The root is a step of its own, because a path that begins with it has to offer it.
export function stepsOf(path: string): Step[] {
  const parts = path.split('/').filter((x) => x !== '');
  const out: Step[] = [{ name: '/', at: '/' }];
  let at = '';
  for (const part of parts) {
    at += `/${part}`;
    out.push({ name: part, at });
  }
  return out;
}

// Which steps the bar draws and which it folds behind one press in the middle. A long path folds rather
// than being cut: the root, one button standing for the folders in between, and the last few. The end says
// which folder this is and the start says which disk it is on, and the middle is a press away instead of
// being three dots that say nothing. The folder he is actually in is never folded away and never cut.
export function foldSteps(path: string, fits: number, keep: number): { shown: Step[]; folded: Step[] } {
  const all = stepsOf(path);
  if (path.length <= fits || all.length <= keep + 2) return { shown: all, folded: [] };
  return { shown: [all[0]!, ...all.slice(all.length - keep)], folded: all.slice(1, all.length - keep) };
}
