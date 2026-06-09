// lib/WindAnimationOverlay.ts
import type { Map } from "maplibre-gl";
import FetchStore from "@zarrita/storage/fetch";
import { get as zarritaGet, open as openZarrita } from "zarrita";

export interface WindConfig {
  datasetName: string;
  zarrBaseUrl: string;
  speedVariable?: string;
  directionVariable?: string;
  // Alternative to speed+direction: supply eastward (u) and northward (v)
  // velocity components directly (e.g. ocean current u/v). When both are set
  // they take precedence over speedVariable/directionVariable.
  uVariable?: string;
  vVariable?: string;
  latVariable?: string;
  lonVariable?: string;
  speedFactor?: number;
  particleCount?: number;
  particleSize?: number;
  // Colour the particles by speed using this colormap (defaults to "jet" so the
  // particles match the raster). Speeds are normalized to [minSpeed, maxSpeed];
  // when maxSpeed is omitted it is derived from the data each time step.
  colormap?: string;
  minSpeed?: number;
  maxSpeed?: number;
}

type DirectionMetadata = {
  standardName: string;
  longName: string;
  comment: string;
  units: string;
};

type RectilinearWindField = {
  latValues: number[];
  lonValues: number[];
  speedValues: number[];
  directionValues: number[];
  width: number;
  height: number;
  lonStep: number;
  latStep: number;
  // Signed origin/step for O(1) regular-grid index lookups.
  lonStart: number;
  latStart: number;
  lonStepSigned: number;
  latStepSigned: number;
  lonWraps: boolean;
  timeCount: number;
  directionMetadata: DirectionMetadata;
  // Lower/upper speed bounds used to normalize speed -> colour ramp.
  speedFloor: number;
  speedScale: number;
};

type WindParticle = {
  lon: number;
  lat: number;
  age: number;
  maxAge: number;
};

const FLOW_SPEED_MULTIPLIER = 200;

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Shortest absolute angular distance between two longitudes (degrees),
// so a particle at lng -60 correctly matches grid lon 300 (0–360 datasets).
function lonDelta(a: number, b: number) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180);
}

// Normalize any longitude into the map's -180..180 convention.
function toMapLng(lon: number) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function buildZarrUrl(datasetName: string, baseUrl?: string) {
  const configured = (baseUrl || "").trim() || "/";
  const normalizedDataset = datasetName.replace(/^\/+/, "").replace(/\/+$/, "") + "/";

  const joinPath = (basePath: string) => {
    const baseNormalized = basePath.replace(/\/+$/, "") + "/";
    return `${baseNormalized}${normalizedDataset}`;
  };

  if (configured.startsWith("/")) {
    const relative = joinPath(configured);
    if (typeof window !== "undefined" && window.location?.origin) {
      return new URL(relative, window.location.origin).toString();
    }
    return relative;
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(configured);
  if (!hasScheme && !configured.startsWith("//")) {
    const withoutDot = configured.replace(/^\.\/?/, "");
    const relative = joinPath(`/${withoutDot}`);
    if (typeof window !== "undefined" && window.location?.origin) {
      return new URL(relative, window.location.origin).toString();
    }
    return relative;
  }

  const absoluteBase = configured.startsWith("//")
    ? typeof window !== "undefined"
      ? `${window.location.protocol}${configured}`
      : `https:${configured}`
    : configured;

  return new URL(normalizedDataset, absoluteBase).toString();
}

function buildDirectionMetadata(raw: Record<string, unknown> | null | undefined): DirectionMetadata {
  return {
    standardName: normalizeText(raw?.standard_name),
    longName: normalizeText(raw?.long_name),
    comment: normalizeText(raw?.comment),
    units: normalizeText(raw?.units),
  };
}

function toPropagationHeading(rawAngle: number, metadata: DirectionMetadata) {
  let direction = ((rawAngle % 360) + 360) % 360;
  const isFromDirection =
    metadata.standardName.includes("from_direction") ||
    metadata.longName.includes("from direction") ||
    metadata.comment.includes("from direction");

  if (isFromDirection) {
    direction = (direction + 180) % 360;
  }
  return direction;
}

function getDimensionNames(
  node: Record<string, unknown> | null | undefined,
  fallbackName: string | null = null,
  shape: readonly number[] | null | undefined = null,
) {
  const dimensionNames = node?.dimension_names;
  if (Array.isArray(dimensionNames) && dimensionNames.length) {
    return dimensionNames as string[];
  }
  const rawArrayDimensions = node?._ARRAY_DIMENSIONS;
  if (Array.isArray(rawArrayDimensions) && rawArrayDimensions.length) {
    return rawArrayDimensions as string[];
  }
  const arrayDimensions = (node?.attributes as Record<string, unknown> | undefined)?._ARRAY_DIMENSIONS;
  if (Array.isArray(arrayDimensions) && arrayDimensions.length) {
    return arrayDimensions as string[];
  }
  if (shape && shape.length === 3) {
    return ["time", "lat", "lon"];
  }
  if (shape && shape.length === 2) {
    return ["lat", "lon"];
  }
  return fallbackName ? [fallbackName] : [];
}

function inferTimeAxis(dimensionNames: string[]) {
  return dimensionNames.findIndex((name) => {
    const normalized = normalizeText(name);
    return normalized === "time" || normalized === "valid_time";
  });
}

function findAxis(dimensionNames: string[], candidates: string[]) {
  return dimensionNames.findIndex((name) => candidates.includes(normalizeText(name)));
}

function buildSliceSelection(
  dimensionNames: string[],
  timeAxis: number,
  latAxis: number,
  lonAxis: number,
  timeIdx: number,
  depthAxis = -1,
  depthIdx = 0,
) {
  return dimensionNames.map((_, index) => {
    if (index === timeAxis) return timeIdx;
    if (index === depthAxis) return depthIdx;
    if (index === latAxis || index === lonAxis) return null;
    return 0;
  });
}

function readStoreMetadata(store: FetchStore) {
  return store.get("/.zmetadata")
    .then((bytes) => JSON.parse(new TextDecoder().decode(bytes))?.metadata ?? {})
    .catch(() => ({}));
}

export class WindAnimationOverlay {
  private map: Map;
  private config: WindConfig;
  private particles: WindParticle[] = [];
  private windField: RectilinearWindField | null = null;
  private dataBounds: { lonMin: number; lonMax: number; latMin: number; latMax: number } | null = null;
  private validCells: Set<number> | null = null;
  private animationFrame: number | null = null;
  private timeIndex = 0;
  private depthIndex = 0;
  private lastTimestamp = 0;
  private isPanning = false;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private readonly handleResize = () => this.syncCanvasSize();
  private readonly handleMoveStart = () => {
    this.isPanning = true;
  };
  private readonly handleMoveEnd = () => {
    this.isPanning = false;
    this.syncCanvasSize();
    // After a pan/zoom, redistribute any particle that is now off-screen (or
    // off valid data) back into the current view, so the revealed area fills in.
    this.reseedHidden();
  };

  constructor(map: Map, config: WindConfig) {
    this.map = map;
    this.config = config;
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.pointerEvents = "none";
    // Sit above the deck.gl raster overlay (added as a maplibre control) and any
    // other map chrome so the flow streaks are always visible.
    this.canvas.style.zIndex = "10000";
    this.context = this.canvas.getContext("2d", { alpha: true })!;

    const container = this.map.getContainer();
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(this.canvas);

    this.map.on("resize", this.handleResize);
    this.map.on("movestart", this.handleMoveStart);
    this.map.on("moveend", this.handleMoveEnd);
    this.map.on("zoomend", this.handleMoveEnd);

    this.syncCanvasSize();
    void this.init();
  }

  private async init() {
    await this.loadWindData();
    this.syncCanvasSize();
    this.seedParticles(true);
    this.startAnimation();
  }

  private syncCanvasSize() {
    const container = this.map.getContainer();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(container.clientWidth));
    const height = Math.max(1, Math.round(container.clientHeight));
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.clearCanvas();
  }

  private clearCanvas() {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private async loadWindData(timeIdx = 0) {
    const store = new FetchStore(buildZarrUrl(this.config.datasetName, this.config.zarrBaseUrl));
    const metadata = await readStoreMetadata(store);
    const group = await openZarrita(store, { kind: "group" });
    const latName = this.config.latVariable ?? "lat";
    const lonName = this.config.lonVariable ?? "lon";
    // Two ways to describe the flow field:
    //   * speed + direction (waves/wind), or
    //   * eastward (u) + northward (v) components (ocean currents).
    // We load whichever pair is configured, then normalize everything into the
    // internal speed/direction representation the rest of the class expects.
    const useComponents = Boolean(this.config.uVariable && this.config.vVariable);
    const speedName = this.config.speedVariable ?? "sig_wav_ht";
    const directionName = this.config.directionVariable ?? "mn_wav_dir";
    const primaryName = useComponents ? this.config.uVariable! : speedName;
    const secondaryName = useComponents ? this.config.vVariable! : directionName;

    const [latArr, lonArr, primaryArr, secondaryArr] = await Promise.all([
      openZarrita(group.resolve(latName), { kind: "array" }),
      openZarrita(group.resolve(lonName), { kind: "array" }),
      openZarrita(group.resolve(primaryName), { kind: "array" }),
      openZarrita(group.resolve(secondaryName), { kind: "array" }),
    ]);
    const [lat, lon] = await Promise.all([
      zarritaGet(latArr),
      zarritaGet(lonArr),
    ]);

    const primaryMeta = metadata?.[`${primaryName}/.zattrs`] ?? null;
    const secondaryMeta = metadata?.[`${secondaryName}/.zattrs`] ?? null;
    const primaryDims = getDimensionNames(primaryMeta, primaryName, primaryArr.shape);
    const speedTimeAxis = inferTimeAxis(primaryDims);
    const latAxis = (() => {
      const explicit = findAxis(primaryDims, [normalizeText(latName), "lat", "latitude"]);
      if (explicit >= 0) return explicit;
      return primaryDims.length >= 2 ? primaryDims.length - 2 : -1;
    })();
    const lonAxis = (() => {
      const explicit = findAxis(primaryDims, [normalizeText(lonName), "lon", "longitude"]);
      if (explicit >= 0) return explicit;
      return primaryDims.length >= 1 ? primaryDims.length - 1 : -1;
    })();

    // Select the active depth level (if the field has one), otherwise any extra
    // axes are pinned to index 0 by buildSliceSelection.
    const depthAxis = findAxis(primaryDims, ["depth", "z", "zlev", "lev", "level", "height"]);
    const depthIdx = depthAxis >= 0 ? Math.max(0, Math.min(this.depthIndex, Number(primaryArr.shape?.[depthAxis] ?? 1) - 1)) : 0;
    const dataSelection = buildSliceSelection(primaryDims, speedTimeAxis, latAxis, lonAxis, timeIdx, depthAxis, depthIdx);

    const [primary, secondary] = await Promise.all([
      zarritaGet(primaryArr, dataSelection),
      zarritaGet(secondaryArr, dataSelection),
    ]);

    if (!primary?.data || !secondary?.data) {
      throw new Error(`Unable to load flow slices for ${primaryName}/${secondaryName}.`);
    }

    const latValues = Array.from(lat.data as ArrayLike<number>, Number);
    const lonValues = Array.from(lon.data as ArrayLike<number>, Number);

    let speedValues: number[];
    let directionValues: number[];
    let directionMetadata: DirectionMetadata;
    if (useComponents) {
      // Convert (u, v) into the magnitude + compass heading that getWindAt()
      // re-expands later: heading = atan2(eastward, northward), degrees clockwise
      // from north, so getWindAt's u = speed·sin(h), v = speed·cos(h) round-trips.
      const uVals = Array.from(primary.data as ArrayLike<number>, Number);
      const vVals = Array.from(secondary.data as ArrayLike<number>, Number);
      speedValues = new Array(uVals.length);
      directionValues = new Array(uVals.length);
      for (let i = 0; i < uVals.length; i++) {
        const uu = uVals[i];
        const vv = vVals[i];
        if (Number.isFinite(uu) && Number.isFinite(vv)) {
          speedValues[i] = Math.hypot(uu, vv);
          directionValues[i] = ((Math.atan2(uu, vv) * 180) / Math.PI + 360) % 360;
        } else {
          speedValues[i] = NaN;
          directionValues[i] = 0;
        }
      }
      directionMetadata = buildDirectionMetadata(null);
    } else {
      speedValues = Array.from(primary.data as ArrayLike<number>, Number);
      directionValues = Array.from(secondary.data as ArrayLike<number>, Number);
      directionMetadata = buildDirectionMetadata(secondaryMeta);
    }
    const width = lonValues.length;
    const height = latValues.length;

    // Compute bounding box of the grid
    const lonMin = Math.min(...lonValues);
    const lonMax = Math.max(...lonValues);
    const latMin = Math.min(...latValues);
    const latMax = Math.max(...latValues);
    this.dataBounds = { lonMin, lonMax, latMin, latMax };

    // Build a set of indices that have finite, non‑zero wind speed, and gather
    // the finite speeds so we can normalize the colour ramp to this time step.
    const validSet = new Set<number>();
    const finiteSpeeds: number[] = [];
    for (let i = 0; i < speedValues.length; i++) {
      const speed = speedValues[i];
      if (Number.isFinite(speed) && speed > 0) {
        validSet.add(i);
        finiteSpeeds.push(speed);
      }
    }
    this.validCells = validSet;

    // Normalize speed -> colour. Use the configured range when provided,
    // otherwise derive a robust max (98th percentile) so a few outliers don't
    // wash out the ramp.
    const speedFloor = this.config.minSpeed ?? 0;
    let speedScale = this.config.maxSpeed ?? 0;
    if (!speedScale) {
      if (finiteSpeeds.length) {
        const sorted = [...finiteSpeeds].sort((a, b) => a - b);
        speedScale = sorted[Math.floor(sorted.length * 0.98)] ?? sorted[sorted.length - 1];
      }
      speedScale = Math.max(speedScale, speedFloor + 1e-6);
    }

    const lonStep = width > 1 ? Math.abs(lonMax - lonMin) / (width - 1) : 1;
    const latStep = height > 1 ? Math.abs(latMax - latMin) / (height - 1) : 1;
    const lonStepSigned = width > 1 ? (lonValues[width - 1] - lonValues[0]) / (width - 1) : 1;
    const latStepSigned = height > 1 ? (latValues[height - 1] - latValues[0]) / (height - 1) : 1;
    // A grid that spans (nearly) the full 360° wraps around the antimeridian.
    const lonWraps = width * lonStep >= 359;

    this.windField = {
      latValues,
      lonValues,
      speedValues,
      directionValues,
      width,
      height,
      lonStep,
      latStep,
      lonStart: lonValues[0],
      latStart: latValues[0],
      lonStepSigned,
      latStepSigned,
      lonWraps,
      timeCount: Number(primaryArr.shape?.[speedTimeAxis >= 0 ? speedTimeAxis : 0] ?? 1),
      directionMetadata,
      speedFloor,
      speedScale,
    };
  }

  // Map a lon/lat to its flattened grid index in O(1) (regular rectilinear grid).
  // Returns -1 when the point falls outside the grid.
  private cellIndex(lon: number, lat: number): number {
    const field = this.windField;
    if (!field) return -1;
    const { latValues, lonValues, width, height, latStep, lonStep, lonStart, latStart, lonStepSigned, latStepSigned, lonWraps } = field;

    const latIdx = Math.round((lat - latStart) / latStepSigned);
    if (latIdx < 0 || latIdx > height - 1) return -1;

    // Normalize the longitude offset into index space modulo a full turn, so a
    // -180..180 particle longitude maps onto a 0..360 grid (and vice versa).
    const period = 360 / Math.abs(lonStepSigned); // cells spanning 360°
    let rel = (lon - lonStart) / lonStepSigned;
    rel = ((rel % period) + period) % period; // [0, period)
    let lonIdx = Math.round(rel);
    if (lonIdx >= width) {
      // Past the last column: wrap for global grids, otherwise it's in the
      // uncovered longitude gap of a regional grid.
      lonIdx = lonWraps ? lonIdx % width : -1;
      if (lonIdx < 0) return -1;
    }

    // Reject points whose nearest cell is more than one grid step away.
    if (Math.abs(latValues[latIdx] - lat) > latStep * 1.5) return -1;
    if (lonDelta(lonValues[lonIdx], lon) > lonStep * 1.5) return -1;

    return latIdx * width + lonIdx;
  }

  private isValidWindPoint(lon: number, lat: number): boolean {
    if (!this.validCells) return false;
    const idx = this.cellIndex(lon, lat);
    return idx >= 0 && this.validCells.has(idx);
  }

  private spawn(lon: number, lat: number): WindParticle {
    return { lon, lat, age: 0, maxAge: 80 + Math.floor(Math.random() * 60) };
  }

  private randomParticle(): WindParticle {
    // Seed in screen space so particles always land in the area the user is
    // actually looking at, regardless of the dataset's longitude convention.
    const width = this.canvas.clientWidth || this.map.getContainer().clientWidth;
    const height = this.canvas.clientHeight || this.map.getContainer().clientHeight;

    for (let attempts = 0; attempts < 60; attempts++) {
      const ll = this.map.unproject([Math.random() * width, Math.random() * height]);
      if (this.isValidWindPoint(ll.lng, ll.lat)) {
        return this.spawn(ll.lng, ll.lat);
      }
    }

    // Fallback: aim at the centre of the data, in the map's longitude convention.
    if (this.dataBounds) {
      return this.spawn(
        toMapLng((this.dataBounds.lonMin + this.dataBounds.lonMax) / 2),
        (this.dataBounds.latMin + this.dataBounds.latMax) / 2,
      );
    }
    const center = this.map.getCenter();
    return this.spawn(center.lng, center.lat);
  }

  private seedParticles(resetAll: boolean) {
    const count = this.config.particleCount ?? 2000;
    if (resetAll || this.particles.length === 0) {
      this.particles = Array.from({ length: count }, () => this.randomParticle());
      return;
    }

    // Adjust particle count (remove or add)
    if (this.particles.length < count) {
      while (this.particles.length < count) {
        this.particles.push(this.randomParticle());
      }
    } else if (this.particles.length > count) {
      this.particles.length = count;
    }

    // Replace any particles that no longer sit over valid wind data
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!this.isValidWindPoint(p.lon, p.lat)) {
        this.particles[i] = this.randomParticle();
      }
    }
  }

  private reseedHidden() {
    if (this.particles.length === 0) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const pt = this.map.project({ lng: p.lon, lat: p.lat });
      const onScreen = pt.x >= 0 && pt.x <= w && pt.y >= 0 && pt.y <= h;
      if (!onScreen || !this.isValidWindPoint(p.lon, p.lat)) {
        this.particles[i] = this.randomParticle();
      }
    }
  }

  private ensureVisibleParticles() {
    if (this.particles.length === 0) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const hasVisible = this.particles.some(p => {
      const pt = this.map.project({ lng: p.lon, lat: p.lat });
      return pt.x >= 0 && pt.x <= w && pt.y >= 0 && pt.y <= h;
    });
    if (!hasVisible) {
      this.seedParticles(true);
    }
  }

  private getWindAt(lon: number, lat: number): [u: number, v: number] {
    if (!this.windField) return [0, 0];
    const { speedValues, directionValues, directionMetadata } = this.windField;

    const index = this.cellIndex(lon, lat);
    if (index < 0) return [0, 0];
    const speed = speedValues[index];
    const direction = directionValues[index];
    if (!Number.isFinite(speed) || speed <= 0) return [0, 0];

    const heading = toPropagationHeading(direction, directionMetadata);
    const radians = (heading * Math.PI) / 180;
    const u = speed * Math.sin(radians);
    const v = speed * Math.cos(radians);
    return [u, v];
  }

  private fadeFrame() {
    // "Trail" effect: keep previous frame with opacity
    this.context.save();
    this.context.globalCompositeOperation = "destination-in";
    this.context.fillStyle = "rgba(0, 0, 0, 0.92)";
    this.context.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    this.context.restore();
  }

  private updateParticles(deltaSeconds: number): Array<{ x0: number; y0: number; x1: number; y1: number; speed: number }> {
    const speedFactor = this.config.speedFactor ?? 0.02;
    const canvasWidth = this.canvas.clientWidth;
    const canvasHeight = this.canvas.clientHeight;
    const segments: Array<{ x0: number; y0: number; x1: number; y1: number; speed: number }> = [];

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      const [u, v] = this.getWindAt(particle.lon, particle.lat);
      const windSpeed = Math.hypot(u, v);
      if (!Number.isFinite(windSpeed) || windSpeed <= 0.0001) {
        // No wind → respawn
        this.particles[i] = this.randomParticle();
        continue;
      }

      const previous = this.map.project({ lng: particle.lon, lat: particle.lat });
      const dx = u * speedFactor * FLOW_SPEED_MULTIPLIER * deltaSeconds;
      const dy = -v * speedFactor * FLOW_SPEED_MULTIPLIER * deltaSeconds;
      const nextPoint = { x: previous.x + dx, y: previous.y + dy };
      const nextLngLat = this.map.unproject([nextPoint.x, nextPoint.y]);
      const newLon = nextLngLat.lng;
      const newLat = nextLngLat.lat;

      // Check if the new position still sits over valid wind data
      const hasValidWind = this.isValidWindPoint(newLon, newLat);
      const outOfCanvas =
        nextPoint.x < -20 || nextPoint.x > canvasWidth + 20 ||
        nextPoint.y < -20 || nextPoint.y > canvasHeight + 20;

      particle.age++;
      if (!hasValidWind || outOfCanvas || particle.age > particle.maxAge) {
        this.particles[i] = this.randomParticle();
        continue;
      }

      particle.lon = newLon;
      particle.lat = newLat;

      segments.push({
        x0: previous.x,
        y0: previous.y,
        x1: nextPoint.x,
        y1: nextPoint.y,
        speed: windSpeed,
      });
    }
    return segments;
  }

  private drawSegments(segments: Array<{ x0: number; y0: number; x1: number; y1: number; speed: number }>) {
    const particleSize = this.config.particleSize ?? 3;
    const floor = this.windField?.speedFloor ?? 0;
    const scale = this.windField?.speedScale ?? 1;
    const range = Math.max(scale - floor, 1e-6);

    // Bright streaks drawn additively ("lighter") so they glow on top of the
    // coloured speed raster instead of blending into a same-coloured background.
    // Speed is encoded by brightness + thickness (streak length already scales
    // with speed, since motion is proportional to the u/v vector).
    this.context.save();
    this.context.globalCompositeOperation = "lighter";
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
    for (const seg of segments) {
      const t = Math.max(0, Math.min(1, (seg.speed - floor) / range));
      const alpha = 0.3 + 0.65 * t;
      const lineWidth = Math.max(0.8, particleSize * (0.5 + 0.9 * t));
      // Near-white with a faint warm shift at high speed for a sense of energy.
      const g = Math.round(255 - 40 * t);
      const b = Math.round(255 - 90 * t);

      this.context.beginPath();
      this.context.moveTo(seg.x0, seg.y0);
      this.context.lineTo(seg.x1, seg.y1);
      this.context.strokeStyle = `rgba(255, ${g}, ${b}, ${alpha})`;
      this.context.lineWidth = lineWidth;
      this.context.stroke();
    }
    this.context.restore();
  }

  private animate = (now: number) => {
    if (!this.animationFrame) return;
    const delta = Math.min(0.033, (now - this.lastTimestamp) / 1000);
    this.lastTimestamp = now;

    // While the map is actively panning/zooming, skip the (expensive) per-particle
    // project/unproject work entirely and just clear the canvas — this keeps map
    // interaction smooth. Particles resume (and reseed) on moveend.
    if (this.isPanning) {
      this.clearCanvas();
      this.animationFrame = requestAnimationFrame(this.animate);
      return;
    }

    this.fadeFrame();
    const segments = this.updateParticles(delta);
    this.drawSegments(segments);
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private startAnimation() {
    this.lastTimestamp = performance.now();
    this.animationFrame = requestAnimationFrame(this.animate);
    // After one second, force visibility check
    setTimeout(() => this.ensureVisibleParticles(), 1000);
  }

  public setTimeIndex(index: number) {
    this.timeIndex = index;
    this.loadWindData(index).then(() => {
      this.seedParticles(true);
      this.ensureVisibleParticles();
    });
  }

  public setDepthIndex(index: number) {
    this.depthIndex = Math.max(0, index);
    // Reload the flow field at the new depth, then reseed so particles reflect it.
    this.loadWindData(this.timeIndex).then(() => {
      this.seedParticles(true);
      this.ensureVisibleParticles();
    });
  }

  public destroy() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.map.off("resize", this.handleResize);
    this.map.off("movestart", this.handleMoveStart);
    this.map.off("moveend", this.handleMoveEnd);
    this.map.off("zoomend", this.handleMoveEnd);
    this.canvas.remove();
  }
}