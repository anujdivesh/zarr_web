export type RGB = readonly [number, number, number];

export type ColormapName = "jet" | "red-blue";

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ] as const;
}

function jet(t: number): RGB {
  const x = clamp01(t);
  const r = Math.round(clamp01(1.5 - Math.abs(4 * x - 3)) * 255);
  const g = Math.round(clamp01(1.5 - Math.abs(4 * x - 2)) * 255);
  const b = Math.round(clamp01(1.5 - Math.abs(4 * x - 1)) * 255);
  return [r, g, b] as const;
}

function redBlue(t: number): RGB {
  const x = clamp01(t);
  const blue: RGB = [0, 0, 255];
  const white: RGB = [255, 255, 255];
  const red: RGB = [255, 0, 0];

  if (x <= 0.5) {
    return lerpRgb(blue, white, x / 0.5);
  }

  return lerpRgb(white, red, (x - 0.5) / 0.5);
}

export function normalizeColormapName(value: unknown): ColormapName | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "jet") {
    return "jet";
  }

  if (normalized === "red-blue" || normalized === "redblue" || normalized === "red_blue") {
    return "red-blue";
  }

  return null;
}

export function getColormap(name: unknown): (t: number) => RGB {
  const normalized = normalizeColormapName(name) ?? "jet";

  switch (normalized) {
    case "red-blue":
      return redBlue;
    case "jet":
    default:
      return jet;
  }
}
