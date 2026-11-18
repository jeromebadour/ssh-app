// The menu under the right button. One of these, used everywhere a right press means something: the file
// list on nothing, on one thing and on several, the path, the terminal, a tab, the transfers, the trash. What
// is in it is decided by whoever opens it; everything about how it behaves lives here, so ten menus cannot
// drift into ten different ideas of what a menu is (BUILD-RULES 2.13).
//
// What it will not do: show a thing that cannot be used. Nothing is greyed out and nothing says "no" when
// pressed; an action that is not available now is simply not in the menu (BUILD-RULES 2.8).

export interface MenuItem {
  glyph: string; // the name of a shape in the pane's own set; every item carries one (BUILD-RULES 2.1)
  label: string;
  keys?: string; // the press that does the same thing, said on the item, as the tooltips already say it
  run: () => void;
  danger?: boolean; // anything that removes or stops, which takes the colour that means that
  id?: string;
}

export interface MenuBreak {
  apart: true;
}

export type MenuLine = MenuItem | MenuBreak;

export interface Menu {
  close(): void;
  readonly at: HTMLElement;
}

const apart = (l: MenuLine): l is MenuBreak => 'apart' in l;

let open: { menu: HTMLElement; shut: () => void } | null = null;

// Shuts whatever menu is open. Safe to call when none is.
export function shutMenu(): void {
  open?.shut();
}

export function menuIsOpen(): boolean {
  return open !== null;
}

/**
 * Opens a menu inside `within`, at the point given, with these lines in it.
 *
 * The point is in the window's own coordinates, as a mouse event gives it. The menu is kept inside `within`:
 * near the right edge it opens to the left of the point, near the bottom it opens upwards, and if it is
 * taller than the room it has it scrolls rather than running off.
 */
export function openMenu(within: HTMLElement, x: number, y: number, lines: MenuLine[], glyph: (name: string) => SVGSVGElement): Menu | null {
  const items = lines.filter((l): l is MenuItem => !apart(l));
  if (items.length === 0) return null;
  shutMenu();

  const cameFrom = document.activeElement as HTMLElement | null;
  const menu = document.createElement('div');
  menu.className = 'fb-menu';
  menu.id = 'fb-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;

  const buttons: HTMLButtonElement[] = [];
  let lastWasBreak = true; // no rule at the top, and never two together
  for (const line of lines) {
    if (apart(line)) {
      if (!lastWasBreak && menu.childElementCount > 0) {
        const rule = document.createElement('div');
        rule.className = 'fb-menu-apart';
        menu.append(rule);
        lastWasBreak = true;
      }
      continue;
    }
    const b = document.createElement('button');
    b.className = line.danger ? 'fb-menu-one fb-menu-danger' : 'fb-menu-one';
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    if (line.id) b.id = line.id;
    b.append(glyph(line.glyph));
    const words = document.createElement('span');
    words.className = 'fb-menu-words';
    words.textContent = line.label;
    b.append(words);
    if (line.keys) {
      // The press that does the same thing, said on the item itself. His own reference menus do this
      // ("Copy file path to terminal (Middle mouse click)") and this app's tooltips already do it, so a
      // menu is where the keyboard is learned rather than a second way of doing everything.
      const keys = document.createElement('span');
      keys.className = 'fb-menu-keys';
      keys.textContent = line.keys;
      b.append(keys);
    }
    b.addEventListener('click', () => {
      const run = line.run;
      shut();
      run();
    });
    menu.append(b);
    buttons.push(b);
    lastWasBreak = false;
  }
  // A rule left at the end belongs to nothing.
  if (menu.lastElementChild?.className === 'fb-menu-apart') menu.lastElementChild.remove();

  within.append(menu);

  // Where it goes. Measured after it is in the window, because nothing can be measured before it is drawn.
  const room = within.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const left = x - room.left + size.width > room.width ? Math.max(0, x - room.left - size.width) : x - room.left;
  const top = y - room.top + size.height > room.height ? Math.max(0, y - room.top - size.height) : y - room.top;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.max(80, Math.round(room.height - top - 4))}px`;

  let shutting = false;
  const shut = (): void => {
    if (shutting) return;
    shutting = true;
    document.removeEventListener('pointerdown', awayPress, true);
    document.removeEventListener('wheel', awayScroll, true);
    window.removeEventListener('resize', shut);
    menu.remove();
    if (open?.menu === menu) open = null;
    // The focus goes back where it was, or the menu takes the keyboard with it when it goes.
    if (cameFrom && cameFrom.isConnected) cameFrom.focus();
  };
  function awayPress(e: PointerEvent): void {
    if (!menu.contains(e.target as Node)) shut();
  }
  function awayScroll(e: WheelEvent): void {
    if (!menu.contains(e.target as Node)) shut();
  }

  let on = 0;
  const stand = (to: number): void => {
    on = (to + buttons.length) % buttons.length;
    buttons[on]!.focus();
  };
  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') shut();
    else if (e.key === 'ArrowDown') stand(on + 1);
    else if (e.key === 'ArrowUp') stand(on - 1);
    else if (e.key === 'Home') stand(0);
    else if (e.key === 'End') stand(buttons.length - 1);
    else if (e.key === 'Tab') shut();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener('pointerdown', awayPress, true);
  document.addEventListener('wheel', awayScroll, true);
  window.addEventListener('resize', shut);

  open = { menu, shut };
  stand(0);
  return { close: shut, at: menu };
}
