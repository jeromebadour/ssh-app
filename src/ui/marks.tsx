// Berth's mark: a mooring bollard seen from above, its line taken round it: a fixed point you tie up to.
export function Mark() {
  return (
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="6.5" class="mark-fill" />
      <circle cx="16" cy="16" r="10.5" class="mark-line" />
      <path d="M3 16c0-4 4-6 8.5-6M29 16c0 4-4 6-8.5 6" class="mark-line" />
    </svg>
  );
}
