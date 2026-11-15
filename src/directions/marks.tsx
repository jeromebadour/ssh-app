// Each direction's mark: drawn for Berth, from the harbour, never a stock symbol.

// A: Chart. A mooring bollard seen from above, its line taken twice round: a fixed point you tie up to.
function Bollard() {
  return (
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="6.5" class="mark-fill" />
      <circle cx="16" cy="16" r="10.5" class="mark-line" />
      <path d="M3 16c0-4 4-6 8.5-6M29 16c0 4-4 6-8.5 6" class="mark-line" />
    </svg>
  );
}

// B: Lamp. A harbour light: the lantern and its two beams.
function Lantern() {
  return (
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M12 26h8M13 26l1-13h4l1 13" class="mark-line" />
      <rect x="12.5" y="7" width="7" height="6" rx="1" class="mark-fill" />
      <path d="M11 6.5l4-3h2l4 3" class="mark-line" />
      <path d="M21.5 9L30 5.5v8zM10.5 9L2 5.5v8z" class="mark-beam" />
    </svg>
  );
}

// C: Drydock. A mooring cleat in side view, as a fitting drawing: two horns on a plate.
function Cleat() {
  return (
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M3 13.5c3 0 5 1 7 3h12c2-2 4-3 7-3" class="mark-line" />
      <path d="M10 16.5l1.5 6h9l1.5-6" class="mark-fill" />
      <path d="M7 25.5h18" class="mark-line" />
      <circle cx="13" cy="25.5" r="1" class="mark-fill" />
      <circle cx="19" cy="25.5" r="1" class="mark-fill" />
    </svg>
  );
}

export const marks = { a: Bollard, b: Lantern, c: Cleat } as const;
