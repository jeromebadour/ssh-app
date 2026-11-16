// One picture to put together: each of the window's views as a PNG (so a view that is clear in places stays
// clear there), where each sits, and the strip that names the picture inside the image.
export interface EaselLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  png: Uint8Array;
}

export interface EaselJob {
  width: number;
  height: number;
  strip: string;
  background: string; // the window's own colour, seen wherever no view draws
  stripHeight: number;
  layers: EaselLayer[];
}
