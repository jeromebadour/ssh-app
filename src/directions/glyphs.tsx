// The glyph set, drawn on a 16-unit grid. Stroke width and line ends come from the direction (CSS), so one set of
// shapes carries three different hands. Each action has its own shape; no two actions share one.
import type { JSX } from 'preact';

const shapes: Record<string, JSX.Element> = {
  box: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5 6.5l2 1.5-2 1.5M8.5 10H11" /></>,
  folder: <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />,
  up: <path d="M8 12.5V4M4.5 7.5L8 4l3.5 3.5" />,
  // Files: the page outline is shared, the mark inside says the kind; a few kinds have a shape of their own.
  archive: <><rect x="3" y="2.5" width="10" height="11" rx="1.5" /><path d="M8 2.5v1.5M7 4.5h1M8 5.5h1M7 6.5h1M8 7.5h1" /><rect x="6.75" y="9" width="2.5" height="2.5" rx=".5" /></>,
  log: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M5.75 7.5h.5M7.75 7.5h3M5.75 9.5h.5M7.75 9.5h3M5.75 11.5h.5M7.75 11.5h2" /></>,
  text: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M6 8h4.5M6 10.5h3" /></>,
  markdown: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M6 11.5V8l1.25 1.5L8.5 8v3.5M10.25 8v3.5M9.25 10.5l1 1 1-1" /></>,
  script: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M6 8.5l1.5 1.25L6 11M8.5 11.5h2" /></>,
  config: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M5.75 8.25h5M5.75 11h5" /><circle cx="7.5" cy="8.25" r="1" /><circle cx="9.5" cy="11" r="1" /></>,
  json: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M7 7.75c-.75 0-1 .4-1 1v.5c0 .4-.25.75-.6.75.35 0 .6.35.6.75v.5c0 .6.25 1 1 1M9.5 7.75c.75 0 1 .4 1 1v.5c0 .4.25.75.6.75-.35 0-.6.35-.6.75v.5c0 .6-.25 1-1 1" /></>,
  code: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M7 8.25L5.75 9.75 7 11.25M9.5 8.25l1.25 1.5-1.25 1.5" /></>,
  sql: <><ellipse cx="8" cy="4.5" rx="4.5" ry="1.75" /><path d="M3.5 4.5v7c0 1 2 1.75 4.5 1.75s4.5-.75 4.5-1.75v-7M3.5 8c0 1 2 1.75 4.5 1.75S12.5 9 12.5 8" /></>,
  image: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 11l3-3 2.5 2.5 1.5-1.5 4 3.5" /><circle cx="10" cy="6" r="1" /></>,
  binary: <><rect x="3" y="2.5" width="10" height="11" rx="1.5" /><path d="M5.5 6V8.5M10.5 6v2.5M7.25 6h1.5v2.5h-1.5zM5.5 10.5h1.5v2M8.75 10.5h1.75" /></>,
  keyfile: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><circle cx="7" cy="9" r="1.4" /><path d="M8.4 9h2.6M10.25 9v1.25" /></>,
  link: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M6.25 11.25l4-4M7.75 7.25h2.5v2.5" /></>,
  other: <path d="M4 2.5h6l2.5 2.5v8.5H4zM10 2.5V5h2.5" />,
  upload: <><path d="M8 11V3.5M5 6.5l3-3 3 3" /><path d="M3 12.5h10" /></>,
  download: <><path d="M8 3v7.5M5 7.5l3 3 3-3" /><path d="M3 12.5h10" /></>,
  newFolder: <><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" /><path d="M8 7.5v3.5M6.25 9.25h3.5" /></>,
  refresh: <><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" /><path d="M12.5 3v2.5H10" /></>,
  hidden: <><path d="M2 8s2.3-4 6-4 6 4 6 4-2.3 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.6" /></>,
  pin: <><path d="M6 2.5h4l-.5 4 2 2H4.5l2-2z" /><path d="M8 8.5v5" /></>,
  follow: <><path d="M6.5 9.5l3-3" /><path d="M7.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8.5 11.5l-1 1A2.5 2.5 0 0 1 4 9l1-1" /></>,
  copy: <><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1" /><path d="M3 10.5v-7.5h7.5" /></>,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
  key: <><circle cx="5.5" cy="10.5" r="2.5" /><path d="M7.3 8.7l5.2-5.2M10.5 5.5l1.5 1.5M9 7l1 1" /></>,
  check: <path d="M3.5 8.5l3 3 6-6.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  home: <><path d="M3 7.5L8 3.5l5 4" /><path d="M4.5 6.5v6h7v-6" /></>,
  search: <><circle cx="7" cy="7" r="3.75" /><path d="M10 10l3.5 3.5" /></>,
  boxes: <><rect x="2.5" y="2.5" width="11" height="4" rx="1" /><rect x="2.5" y="9.5" width="11" height="4" rx="1" /></>,
  files: <><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" /></>,
  reopen: <><path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" /><path d="M3.5 3v2.5H6" /></>,
  chevron: <path d="M6 4.5l3.5 3.5L6 11.5" />,
};

export function Glyph(props: { name: keyof typeof shapes | string; class?: string; label?: string }) {
  const shape = shapes[props.name];
  return (
    <svg class={`glyph ${props.class ?? ''}`} viewBox="0 0 16 16" aria-hidden={props.label ? undefined : 'true'} role={props.label ? 'img' : undefined} aria-label={props.label}>
      {shape}
    </svg>
  );
}
