// How a time is said, in one place, because the dialog that asks about replacing a file and the list of files
// both say it and they must not drift apart (BUILD-RULES 2.13: reuse, never reinvent).
//
// Near times are said as distances, because that is how a person thinks about a file they touched today, and
// old ones by their date, because "213 days ago" is a number nobody converts.
export function whenAs(seconds: number): string {
  const ago = Date.now() / 1000 - seconds;
  if (ago < 90) return 'a moment ago';
  if (ago < 5400) return `${Math.round(ago / 60)} minutes ago`;
  if (ago < 36 * 3600) return `${Math.round(ago / 3600)} hours ago`;
  if (ago < 30 * 86400) return `${Math.round(ago / 86400)} days ago`;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

// The same moment, short enough for a column in a narrow list: today's files by their time, this year's by
// day and month, older ones by their date.
export function whenShort(seconds: number): string {
  if (seconds <= 0) return '';
  const at = new Date(seconds * 1000);
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return at.toISOString().slice(11, 16);
  if (at.getFullYear() === now.getFullYear()) return at.toISOString().slice(5, 10);
  return at.toISOString().slice(0, 10);
}
