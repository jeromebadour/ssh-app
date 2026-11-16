// Berth's own icon, drawn from the same numbers as its mark (src/ui/marks.tsx): a mooring bollard seen from
// above, its line taken round it. Drawn here rather than kept as a file beside the code, so the icon can never
// drift from the mark, and with nothing added to the build: the pixels, the PNGs and the .ico container are
// all written below.
//
// The small sizes are not the big one shrunk. At 16 and 24 pixels the two arcs and a thin ring turn to mush,
// so those sizes drop the arcs and carry a thicker ring: the icon has to be read at 16 pixels in a taskbar.
import { crc32, deflateSync } from 'node:zlib';

// The app's own colours (src/ui/berth.css).
const PLATE = [0x16, 0x1e, 0x25];
const FILL = [0x5a, 0x9a, 0x8c];
const LINE = [0x96, 0xa3, 0xae];

const UP = 4; // drawn this many times larger, then averaged down: that is the whole of the smoothing

// One square of pixels, RGBA, straight-alpha.
function canvas(size) {
  return { size, px: new Uint8Array(size * size * 4) };
}

// Paint one pixel. Everything here is drawn at UP times the wanted size and averaged down afterwards, so a
// pixel is either in a shape or out of it: the edges are smoothed by the averaging, not here.
function put(c, x, y, colour) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const at = (y * c.size + x) * 4;
  c.px[at] = colour[0];
  c.px[at + 1] = colour[1];
  c.px[at + 2] = colour[2];
  c.px[at + 3] = 255;
}

// Walk only the pixels a shape could reach, never the whole square: at 1024 pixels across, with a pen rolled
// along a curve, walking the square for every step of the pen takes minutes instead of an instant.
function within(c, left, top, right, bottom, each) {
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(c.size - 1, Math.ceil(right));
  const y1 = Math.min(c.size - 1, Math.ceil(bottom));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) each(x, y);
}

// A rounded square, the plate the mark sits on.
function plate(c, radius, colour) {
  const s = c.size;
  within(c, 0, 0, s - 1, s - 1, (x, y) => {
    const dx = Math.max(radius - x - 0.5, 0, x + 0.5 - (s - radius));
    const dy = Math.max(radius - y - 0.5, 0, y + 0.5 - (s - radius));
    if (Math.hypot(dx, dy) <= radius) put(c, x, y, colour);
  });
}

function ring(c, cx, cy, r, width, colour) {
  const half = width / 2;
  within(c, cx - r - half, cy - r - half, cx + r + half, cy + r + half, (x, y) => {
    if (Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r) <= half) put(c, x, y, colour);
  });
}

function disc(c, cx, cy, r, colour) {
  within(c, cx - r, cy - r, cx + r, cy + r, (x, y) => {
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) put(c, x, y, colour);
  });
}

// A cubic curve, stroked by rolling a round pen along it. The mark's two arcs are cubic curves in its SVG.
function curve(c, p, width, colour) {
  const at = (t) => {
    const u = 1 - t;
    return [
      u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
      u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1],
    ];
  };
  // Enough steps that the pen's circles overlap rather than leaving a dotted line.
  const steps = Math.max(64, Math.ceil(c.size * 2));
  for (let i = 0; i <= steps; i++) {
    const [x, y] = at(i / steps);
    disc(c, x, y, width / 2, colour);
  }
}

// The mark itself, at `size` pixels, in the 32-unit space its SVG uses. The mark is set inside the plate
// rather than filling it: the two arcs reach almost the full width of that space, and with no margin they run
// into the plate's rounded corners.
function mark(size, withArcs) {
  const c = canvas(size);
  const inset = size * 0.1;
  const u = (size - inset * 2) / 32; // one SVG unit in pixels
  const o = inset; // where the 32-unit space starts
  plate(c, size * 0.22, PLATE);
  if (withArcs) {
    // M3 16 c0-4 4-6 8.5-6   and   M29 16 c0 4 -4 6 -8.5 6
    curve(c, [[o + 3 * u, o + 16 * u], [o + 3 * u, o + 12 * u], [o + 7 * u, o + 10 * u], [o + 11.5 * u, o + 10 * u]], 1.8 * u, LINE);
    curve(c, [[o + 29 * u, o + 16 * u], [o + 29 * u, o + 20 * u], [o + 25 * u, o + 22 * u], [o + 20.5 * u, o + 22 * u]], 1.8 * u, LINE);
  }
  ring(c, o + 16 * u, o + 16 * u, 10.5 * u, (withArcs ? 1.8 : 2.6) * u, LINE);
  disc(c, o + 16 * u, o + 16 * u, 6.5 * u, FILL);
  return c;
}

// Average the big square down to the wanted size.
function shrink(big, size) {
  const out = canvas(size);
  const step = big.size / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * step); sy < (y + 1) * step; sy++) {
        for (let sx = Math.floor(x * step); sx < (x + 1) * step; sx++) {
          const at = (sy * big.size + sx) * 4;
          const alpha = big.px[at + 3] / 255;
          r += big.px[at] * alpha;
          g += big.px[at + 1] * alpha;
          b += big.px[at + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const at = (y * size + x) * 4;
      out.px[at] = a > 0 ? Math.round(r / a) : 0;
      out.px[at + 1] = a > 0 ? Math.round(g / a) : 0;
      out.px[at + 2] = a > 0 ? Math.round(b / a) : 0;
      out.px[at + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

function chunk(kind, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, 'latin1');
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'latin1'), body])), 0);
  return Buffer.concat([head, body, sum]);
}

// A PNG of one square. Eight bits a channel, RGBA, no interlacing, every row unfiltered.
function png(c) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(c.size, 0);
  head.writeUInt32BE(c.size, 4);
  head[8] = 8; // bits a channel
  head[9] = 6; // RGBA
  const stride = c.size * 4 + 1;
  const rows = Buffer.alloc(stride * c.size);
  for (let y = 0; y < c.size; y++) {
    rows[y * stride] = 0; // this row is stored as it is
    Buffer.from(c.px.buffer, c.px.byteOffset + y * c.size * 4, c.size * 4).copy(rows, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Each size as its own PNG, drawn for that size.
export function iconPngs() {
  return ICON_SIZES.map((size) => ({ size, png: png(shrink(mark(size * UP, size >= 32), size)) }));
}

// The .ico container: a header, one directory entry a size, then the PNGs. Windows reads PNG inside .ico.
export function iconFile() {
  const images = iconPngs();
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // an icon, not a cursor
  head.writeUInt16LE(images.length, 4);
  const entries = [];
  let at = 6 + images.length * 16;
  for (const { size, png: body } of images) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size; // 256 is written as 0
    e[1] = size === 256 ? 0 : size;
    e[2] = 0; // colours in the palette: none, it is a true-colour image
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits a pixel
    e.writeUInt32LE(body.length, 8);
    e.writeUInt32LE(at, 12);
    entries.push(e);
    at += body.length;
  }
  return Buffer.concat([head, ...entries, ...images.map((i) => i.png)]);
}
