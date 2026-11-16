// The tab in front comes first (plan B8.3).
//
// Every tab takes its box's output as fast as it can, shown or not: a tab never slows its box because it is
// behind another. One case is different: more tabs behind are flooded than the PC has processors to spare.
// Then something has to wait, and it is the tabs nobody is looking at, so that the window and the tab in front
// still answer at once.
//
// The rule has no guesswork in it and nothing to tune itself:
//   - A tab behind is "flooded" when its box is sending faster than the tab can work through: what the box
//     has sent and the tab has not yet taken stays near the fixed amount a box may be ahead. A tab that keeps
//     up with its box (a build's log, a chatty job) is never flooded, however much it prints.
//   - The processors to spare are the PC's, less two: one for the tab in front, one for the window, the
//     engines and the drawing. (A PC with two has half of one to spare.)
//   - If the flooded tabs behind are more than that, each may spend its part of the spare processors working
//     through output, and rests the remainder of the time. Otherwise every tab works flat out.
// On a PC with eight processors, six tabs behind can all be flooded at once and none is held back.
// The tab in front is never held back. A tab that is held back makes its box wait, and says so.

export const SHARE_MIN = 0.04;
// A box may be 512 KiB ahead of its tab (plan B8). Flooded: at least a quarter of that is waiting. Not flooded
// any more: under a sixteenth of it, six looks in a row.
export const FLOODED_FROM = 128 * 1024;
export const CALM_UNDER = 32 * 1024;
export const CALM_LOOKS = 6;
export const PACE_EVERY_MS = 50;

// The share of its time each flooded tab behind may work, from the PC's processors and how many such tabs.
export function shareFor(processors: number, floodedBehind: number): number {
  if (!Number.isInteger(floodedBehind) || floodedBehind < 1) return 1;
  const spare = Math.max(0.5, (Number.isFinite(processors) && processors >= 1 ? Math.floor(processors) : 1) - 2);
  return Math.round(Math.min(1, Math.max(SHARE_MIN, spare / floodedBehind)) * 100) / 100;
}

export interface Looked {
  id: number;
  behind: boolean;
  waiting: number; // bytes its box has sent that the tab has not yet taken
}

export class Pace {
  share = 1;
  lowest = 1; // the smallest share ever told, for the meter and the self-test
  private readonly flooded = new Set<number>();
  private readonly calm = new Map<number, number>();
  private forced: number | null = null;

  constructor(private readonly processors: number) {}

  // One look at every tab. True when the share changed and the tabs are to be told.
  look(tabs: Looked[]): boolean {
    const ids = new Set(tabs.map((t) => t.id));
    for (const id of this.flooded) if (!ids.has(id)) this.flooded.delete(id);
    for (const t of tabs) {
      if (t.waiting >= FLOODED_FROM) {
        this.flooded.add(t.id);
        this.calm.delete(t.id);
      } else if (this.flooded.has(t.id) && t.waiting < CALM_UNDER) {
        const looks = (this.calm.get(t.id) ?? 0) + 1;
        if (looks >= CALM_LOOKS) {
          this.flooded.delete(t.id);
          this.calm.delete(t.id);
        } else this.calm.set(t.id, looks);
      } else this.calm.delete(t.id);
    }
    const next = this.forced ?? shareFor(this.processors, tabs.filter((t) => t.behind && this.flooded.has(t.id)).length);
    if (next === this.share) return false;
    this.share = next;
    this.lowest = Math.min(this.lowest, next);
    return true;
  }

  // For the lab: a share given by hand and kept; null gives the rule back.
  force(share: number | null): void {
    this.forced = share === null ? null : Math.min(1, Math.max(SHARE_MIN, share));
  }
}
