// One picture to put together: the window's views as raw pixels (blue, green, red, alpha, as Electron hands
// them over), where each sits, and the strip that names the picture inside the image.
export interface EaselLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  bgra: Uint8Array;
}

export interface EaselJob {
  width: number;
  height: number;
  strip: string;
  stripHeight: number;
  layers: EaselLayer[];
}
