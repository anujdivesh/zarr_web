// lib/ZarrOverlay.ts

import { MapboxOverlay } from "@deck.gl/mapbox";
import { BitmapLayer, IconLayer } from "@deck.gl/layers";
import maplibregl from "maplibre-gl";
import FetchStore from "@zarrita/storage/fetch";
import { get as zarritaGet, open as openZarrita } from "zarrita";
import { getColormap } from "./colormaps";

// ========== Constants ==========
const MAX_MERCATOR_LAT = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;
const MAX_RENDER_DIMENSION = 2048;
const BITMAP_TEXTURE_PARAMETERS = {
  minFilter: "nearest",
  magFilter: "nearest",
  mipmapFilter: "none",
  addressModeU: "clamp-to-edge",
  addressModeV: "clamp-to-edge",
} as const;
const DIRECTION_ARROW_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 4 L50 24 H39 V60 H25 V24 H14 Z" fill="white"/></svg>',
)}`;

// ========== Helper functions ==========
function normalizeText(value: any) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function looksLikeTime(name: string, node: any) {
  const normalizedName = normalizeText(name);
  const units = normalizeText(node?.attributes?.units);
  const longName = normalizeText(node?.attributes?.long_name);
  const standardName = normalizeText(node?.attributes?.standard_name);
  return (
    normalizedName === "time" ||
    normalizedName === "valid_time" ||
    standardName === "time" ||
    longName.includes("time") ||
    units.includes("since")
  );
}
function inferTimeDimensionName(dimensionNames: string[], metadata: any) {
  return dimensionNames.find((dim) => looksLikeTime(dim, metadata?.[dim])) ?? null;
}
function buildSliceSelection(dimensionNames: string[], latName: string, lonName: string, timeDimName: string | null, timeIndex: number) {
  return dimensionNames.map((dim) => {
    if (dim === latName || dim === lonName) return null;
    if (timeDimName && dim === timeDimName) return timeIndex;
    return 0;
  });
}
function clampLatitudeToMercator(latitude: number) {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, latitude));
}
function latToMercatorY(latitude: number) {
  const radians = (clampLatitudeToMercator(latitude) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}
function mercatorYToLat(y: number) {
  return (Math.atan(Math.sinh(y)) * 180) / Math.PI;
}
function interpolateFinite(a: number, b: number, t: number) {
  const aFin = Number.isFinite(a);
  const bFin = Number.isFinite(b);
  if (aFin && bFin) return a + (b - a) * t;
  if (aFin) return a;
  if (bFin) return b;
  return NaN;
}
function computeEdges(values: ArrayLike<number>) {
  if (!values || values.length < 2) return null;
  const edges = new Float64Array(values.length + 1);
  edges[0] = values[0] - (values[1] - values[0]) / 2;
  for (let i = 1; i < values.length; i++) edges[i] = (values[i - 1] + values[i]) / 2;
  edges[values.length] = values[values.length - 1] + (values[values.length - 1] - values[values.length - 2]) / 2;
  return edges;
}
function isArrayMetadata(node: any) {
  return node && (node.node_type === "array" || Array.isArray(node.shape));
}
function getDimensionNames(node: any, fallbackName: string | null = null) {
  if (Array.isArray(node?.dimension_names) && node.dimension_names.length) return node.dimension_names;
  if (Array.isArray(node?.attributes?._ARRAY_DIMENSIONS) && node.attributes._ARRAY_DIMENSIONS.length) return node.attributes._ARRAY_DIMENSIONS;
  return fallbackName ? [fallbackName] : [];
}
function looksLikeLatitude(name: string, node: any) {
  const n = normalizeText(name);
  const u = normalizeText(node?.attributes?.units);
  const ln = normalizeText(node?.attributes?.long_name);
  const sn = normalizeText(node?.attributes?.standard_name);
  return n === "lat" || n === "latitude" || u.includes("degrees_north") || sn === "latitude" || ln.includes("latitude");
}
function looksLikeLongitude(name: string, node: any) {
  const n = normalizeText(name);
  const u = normalizeText(node?.attributes?.units);
  const ln = normalizeText(node?.attributes?.long_name);
  const sn = normalizeText(node?.attributes?.standard_name);
  return n === "lon" || n === "longitude" || u.includes("degrees_east") || sn === "longitude" || ln.includes("longitude");
}
function discoverCoordinateNames(metadata: any) {
  let latName: string | null = null, lonName: string | null = null;
  for (const [name, node] of Object.entries(metadata)) {
    if (!isArrayMetadata(node)) continue;
    if (!latName && looksLikeLatitude(name, node)) latName = name;
    if (!lonName && looksLikeLongitude(name, node)) lonName = name;
  }
  return { latName, lonName };
}
function buildSpatialAccessor(values: any, shape: number[], latAxis: number, lonAxis: number) {
  if (latAxis === 0 && lonAxis === 1) {
    const height = shape[0], width = shape[1];
    return { width, height, getValue: (x: number, y: number) => values[y * width + x] };
  }
  if (lonAxis === 0 && latAxis === 1) {
    const width = shape[0], height = shape[1];
    return { width, height, getValue: (x: number, y: number) => values[x * height + y] };
  }
  throw new Error("Expected exactly one latitude axis and one longitude axis.");
}
function getSplitLongitude(lonMin: number, lonMax: number) {
  const span = lonMax - lonMin;
  if (span < 359) return null;
  if (lonMin >= 0 && lonMax > 180) return 180;
  if (lonMin < 0 && lonMax <= 180) return 0;
  return lonMin + span / 2;
}
function wrapLongitudeNear(lon: number, ref: number) {
  let w = lon;
  while (w - ref <= -180) w += 360;
  while (w - ref > 180) w -= 360;
  return w;
}
function getWrappedBoundsVariants(bounds: any, refLon: number) {
  const mid = (bounds.lonMin + bounds.lonMax) / 2;
  const wrappedMid = wrapLongitudeNear(mid, refLon);
  const offset = wrappedMid - mid;
  return [offset - 360, offset, offset + 360].map((off) => ({
    lonMin: bounds.lonMin + off,
    lonMax: bounds.lonMax + off,
    latMin: bounds.latMin,
    latMax: bounds.latMax,
  }));
}
function buildInlineMetadataFromZarrV2(consolidated: any) {
  const inline: any = {};
  for (const [key, val] of Object.entries(consolidated ?? {})) {
    if (!key.includes("/")) continue;
    const [name, metaFile] = key.split("/");
    if (!name || !metaFile) continue;
    if (!inline[name]) inline[name] = {};
    const metadataValue = (val ?? {}) as any;
    if (metaFile === ".zarray") {
      inline[name] = {
        ...inline[name],
        ...(metadataValue && typeof metadataValue === "object" ? metadataValue : {}),
        node_type: "array",
        dimension_names: metadataValue?._ARRAY_DIMENSIONS ?? inline[name].dimension_names,
      };
    }
    if (metaFile === ".zattrs") {
      inline[name] = {
        ...inline[name],
        attributes: metadataValue,
        dimension_names: metadataValue?._ARRAY_DIMENSIONS ?? inline[name].dimension_names,
      };
    }
  }
  return inline;
}
function buildZarrUrl(datasetName: string, baseUrl?: string) {
  const DEFAULT_BASE = "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/";
  const configured = baseUrl || process.env.NEXT_PUBLIC_ZARR_BASE_URL || DEFAULT_BASE;
  return new URL(`${datasetName}/`, configured).toString();
}
async function openDatasetStore(datasetName: string, baseUrl?: string) {
  const store = new FetchStore(buildZarrUrl(datasetName, baseUrl));
  return { store, sourceLabel: "Zarr store" };
}
async function fetchRootMetadata(store: any) {
  const zarrV3 = await store.get("/zarr.json");
  if (zarrV3) {
    const meta = JSON.parse(new TextDecoder().decode(zarrV3));
    return { rootAttributes: meta?.attributes ?? {}, inlineMetadata: meta?.consolidated_metadata?.metadata ?? {} };
  }
  const zarrV2 = await store.get("/.zmetadata");
  if (zarrV2) {
    const meta = JSON.parse(new TextDecoder().decode(zarrV2));
    const consolidated = meta?.metadata ?? {};
    return { rootAttributes: consolidated[".zattrs"] ?? {}, inlineMetadata: buildInlineMetadataFromZarrV2(consolidated) };
  }
  throw new Error("Unable to read Zarr metadata.");
}
function formatIsoDate(d: Date | null) {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().replace(".000Z", "Z");
}
function buildTimeLabel(dataset: any, idx: number) {
  if (!dataset?.hasTime) return dataset?.timeCoverageStartLabel ?? dataset?.fallbackTimeLabel ?? "Single time slice";
  if (dataset.timeLabels?.[idx]) return dataset.timeLabels[idx];
  if (dataset.timeCount > 1 && dataset.timeStart && dataset.timeEnd) {
    const ratio = idx / Math.max(1, dataset.timeCount - 1);
    const ts = dataset.timeStart.getTime() + ratio * (dataset.timeEnd.getTime() - dataset.timeStart.getTime());
    const label = formatIsoDate(new Date(ts));
    if (label) return label;
  }
  return `Timestep ${idx + 1}`;
}
// Colormaps are defined in src/lib/colormaps.ts

// ========== Main ZarrOverlay class ==========
export interface ZarrLayerConfig {
  id: string;
  name: string;
  datasetName: string;
  zarrBaseUrl?: string;
  heightVariable: string;
  directionVariable?: string;
  colorRange?: { min: number; max: number };
  colormap?: string;
  showRaster?: boolean;
  showArrows?: boolean;
}

export class ZarrOverlay {
  private map: maplibregl.Map;
  private bitmapOverlay: MapboxOverlay;
  private directionOverlay: MapboxOverlay;
  private config: ZarrLayerConfig;
  private dataset: any = null;
  private canvasRefs: Record<string, HTMLCanvasElement> = {};
  private renderRequestId = 0;
  private renderTimeout: ReturnType<typeof setTimeout> | null = null;
  private renderInFlight = false;
  private renderQueued = false;
  private loadingDelayTimeout: ReturnType<typeof setTimeout> | null = null;
  private loadingVisible = false;
  private prefetchedTimeIndex: number | null = null;
  private prefetchedPromise: Promise<{ result: any; dirResult: any | null }> | null = null;
  private cachedStats: { min: number; max: number; units: string } | null = null;
  private timeIndex = 0;
  private playInterval: ReturnType<typeof setInterval> | null = null;
  private mounted = true;

  private readonly handleMapViewChange = () => {
    if (!this.mounted) {
      return;
    }

    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }

    this.renderTimeout = setTimeout(() => {
      this.renderTimeout = null;
      this.requestRender();
    }, 120);
  };

  private setLoadingVisible(nextVisible: boolean) {
    if (this.loadingVisible === nextVisible) {
      return;
    }

    this.loadingVisible = nextVisible;
    this.onLoadingChange?.(nextVisible);
  }

  private requestRender() {
    if (!this.mounted) {
      return;
    }

    if (this.renderInFlight) {
      this.renderQueued = true;
      return;
    }

    void this.render();
  }

  // UI callbacks
  public onTimeChange?: (label: string, idx: number, max: number) => void;
  public onStatsChange?: (min: number, max: number, units: string) => void;
  public onLoadingChange?: (loading: boolean) => void;
  public onErrorChange?: (error: string | null) => void;

  constructor(map: maplibregl.Map, config: ZarrLayerConfig) {
    this.map = map;
    this.config = config;

    // Separate overlays ensure the direction arrows always render above the bitmap raster.
    this.bitmapOverlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.directionOverlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.map.addControl(this.bitmapOverlay);
    this.map.addControl(this.directionOverlay);

    // Match the sample behavior: re-render on view changes (debounced).
    this.map.on("zoomend", this.handleMapViewChange);
    this.map.on("moveend", this.handleMapViewChange);
    this.map.on("resize", this.handleMapViewChange);

    this.initialize();
  }

  private async initialize() {
    try {
      this.onLoadingChange?.(true);
      await this.ensureDatasetLoaded();
      this.requestRender();
    } catch (err) {
      this.onErrorChange?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.onLoadingChange?.(false);
    }
  }

  private ensureCanvas(key: string, width: number, height: number): HTMLCanvasElement {
    if (!this.canvasRefs[key]) {
      const canvas = document.createElement("canvas");
      canvas.style.position = "fixed";
      canvas.style.top = "-10000px";
      canvas.style.left = "-10000px";
      canvas.style.pointerEvents = "none";
      canvas.setAttribute("aria-hidden", "true");
      this.canvasRefs[key] = canvas;
    }
    const canvas = this.canvasRefs[key];
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    return canvas;
  }

  private updateBitmapLayers(layers: any[]) {
    this.bitmapOverlay.setProps({ layers });
  }

  private updateDirectionLayers(layers: any[]) {
    this.directionOverlay.setProps({ layers });
  }

  private createBitmapLayer(id: string, image: HTMLCanvasElement, bounds: any) {
    return new BitmapLayer({
      id,
      image,
      bounds: [
        bounds.lonMin,
        clampLatitudeToMercator(bounds.latMin),
        bounds.lonMax,
        clampLatitudeToMercator(bounds.latMax),
      ],
      opacity: 1,
      parameters: { depthTest: false },
      textureParameters: BITMAP_TEXTURE_PARAMETERS,
    });
  }

  private createDirectionLayer(id: string, data: any[], zoom: number) {
    return new IconLayer({
      id,
      data,
      billboard: true,
      sizeUnits: "pixels",
      sizeMinPixels: 24,   // Larger for better visibility
      sizeMaxPixels: 48,   // Larger max
      getPosition: (item: any) => item.position,
      getIcon: () => ({
        url: DIRECTION_ARROW_ICON,
        width: 64,
        height: 64,
        anchorX: 32,
        anchorY: 32,
        mask: true,
      }),
      getSize: () => Math.max(24, Math.min(48, 14 + zoom * 2.2)), // Scales with zoom
      getAngle: (item: any) => item.angle,
      getColor: () => [0, 0, 0, 255],
      parameters: { depthTest: false },
      alphaCutoff: 0.01,
      pickable: false,
      textureParameters: {
        minFilter: "linear",
        magFilter: "linear",
        mipmapFilter: "none",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
  }

  private async ensureDatasetLoaded() {
    if (this.dataset) return this.dataset;

    const { store, sourceLabel } = await openDatasetStore(this.config.datasetName, this.config.zarrBaseUrl);
    const { rootAttributes, inlineMetadata } = await fetchRootMetadata(store);
    const { latName, lonName } = discoverCoordinateNames(inlineMetadata);
    if (!latName || !lonName) throw new Error("Could not detect lat/lon coordinates.");

    const varMeta = inlineMetadata[this.config.heightVariable];
    const dirMeta = this.config.directionVariable ? inlineMetadata[this.config.directionVariable] : null;
    if (!varMeta) throw new Error(`Missing variable ${this.config.heightVariable}`);
    if (this.config.directionVariable && !dirMeta) throw new Error(`Missing variable ${this.config.directionVariable}`);

    const dimNames = getDimensionNames(varMeta, this.config.heightVariable);
    const dirDimNames = dirMeta ? getDimensionNames(dirMeta, this.config.directionVariable!) : [];
    const timeDim = inferTimeDimensionName(dimNames, inlineMetadata);
    const dirTimeDim = inferTimeDimensionName(dirDimNames, inlineMetadata);

    const spatialDims = dimNames.filter((d: string) => d === latName || d === lonName);
    const dirSpatialDims = dirDimNames.filter((d: string) => d === latName || d === lonName);
    const latAxis = spatialDims.indexOf(latName);
    const lonAxis = spatialDims.indexOf(lonName);
    const dirLatAxis = dirSpatialDims.indexOf(latName);
    const dirLonAxis = dirSpatialDims.indexOf(lonName);
    if (latAxis < 0 || lonAxis < 0 || spatialDims.length !== 2) throw new Error("Only rectilinear lat/lon rasters supported.");
    if (this.config.directionVariable && (dirLatAxis < 0 || dirLonAxis < 0 || dirSpatialDims.length !== 2)) throw new Error("Direction variable must be rectilinear lat/lon.");

    const group = await openZarrita(store, { kind: "group" });
    const [variable, directionVar, latArr, lonArr] = await Promise.all([
      openZarrita(group.resolve(this.config.heightVariable), { kind: "array" }),
      this.config.directionVariable ? openZarrita(group.resolve(this.config.directionVariable), { kind: "array" }) : null,
      openZarrita(group.resolve(latName), { kind: "array" }),
      openZarrita(group.resolve(lonName), { kind: "array" }),
    ]);
    const [latRaw, lonRaw] = await Promise.all([zarritaGet(latArr), zarritaGet(lonArr)]);
    const latValues = Array.from(latRaw.data as ArrayLike<number>, Number);
    const lonValues = Array.from(lonRaw.data as ArrayLike<number>, Number);
    const latEdges = computeEdges(latValues);
    const lonEdges = computeEdges(lonValues);
    const lonMin = lonEdges ? Math.min(lonEdges[0], lonEdges[lonEdges.length-1]) : Math.min(lonValues[0], lonValues[lonValues.length-1]);
    const lonMax = lonEdges ? Math.max(lonEdges[0], lonEdges[lonEdges.length-1]) : Math.max(lonValues[0], lonValues[lonValues.length-1]);
    const splitLon = getSplitLongitude(lonMin, lonMax);
    const splitIdx = splitLon === null ? -1 : lonValues.findIndex((v: number) => v >= splitLon);
    const visibleRowStart = Math.max(0, latValues.findIndex((v: number) => v >= -MAX_MERCATOR_LAT));
    const visibleRowEnd = latValues.length - 1 - [...latValues].reverse().findIndex(v => v <= MAX_MERCATOR_LAT);
    const safeStart = visibleRowStart >= 0 ? visibleRowStart : 0;
    const safeEnd = visibleRowEnd >= safeStart ? visibleRowEnd : latValues.length - 1;
    const latMin = latEdges ? Math.min(latEdges[safeStart], latEdges[safeEnd+1]) : Math.min(latValues[0], latValues[latValues.length-1]);
    const latMax = latEdges ? Math.max(latEdges[safeStart], latEdges[safeEnd+1]) : Math.max(latValues[0], latValues[latValues.length-1]);
    const safeSplit = splitIdx > 0 && splitIdx < lonValues.length ? splitIdx : null;
    const timeDimIndex = timeDim ? dimNames.indexOf(timeDim) : -1;
    const timeCount = timeDimIndex >= 0 ? Number(variable.shape?.[timeDimIndex] ?? 1) : 1;
    const timeStartRaw = rootAttributes?.time_coverage_start ?? group.attrs?.time_coverage_start;
    const timeEndRaw = rootAttributes?.time_coverage_end ?? group.attrs?.time_coverage_end;
    const timeStart = timeStartRaw ? new Date(timeStartRaw) : null;
    const timeEnd = timeEndRaw ? new Date(timeEndRaw) : null;

    this.dataset = {
      variableName: this.config.heightVariable,
      directionVariableName: this.config.directionVariable,
      variableLongName: varMeta?.attributes?.long_name ?? this.config.heightVariable,
      directionLongName: dirMeta?.attributes?.long_name ?? this.config.directionVariable,
      variableUnits: varMeta?.attributes?.units ?? "",
      datasetTitle: rootAttributes?.title ?? this.config.datasetName,
      sourceLabel,
      latName, lonName,
      dimensionNames: dimNames,
      directionDimensionNames: dirDimNames,
      timeDimensionName: timeDim,
      directionTimeDimensionName: dirTimeDim,
      timeCount,
      hasTime: Boolean(timeDim && timeCount > 1),
      timeStart: timeStart && !isNaN(timeStart.getTime()) ? timeStart : null,
      timeEnd: timeEnd && !isNaN(timeEnd.getTime()) ? timeEnd : null,
      timeCoverageStartLabel: formatIsoDate(timeStart),
      fallbackTimeLabel: typeof group.attrs?.time_coverage_start === "string" ? new Date(group.attrs.time_coverage_start).toISOString().replace(".000Z","Z") : "Single time slice",
      latAxisInResult: latAxis,
      lonAxisInResult: lonAxis,
      variable,
      directionVariable: directionVar,
      directionLatAxisInResult: dirLatAxis,
      directionLonAxisInResult: dirLonAxis,
      latValues,
      lonValues,
      latEdges,
      lonEdges,
      latAscending: latValues[0] < latValues[latValues.length-1],
      splitIndex: safeSplit,
      splitLongitude: splitLon,
      visibleRowStart: safeStart,
      visibleRowEnd: safeEnd,
      scaleFactor: Number(variable.attrs?.scale_factor ?? 1),
      addOffset: Number(variable.attrs?.add_offset ?? 0),
      missingValue: variable.attrs?._FillValue !== undefined && variable.attrs?._FillValue !== null ? Number(variable.attrs._FillValue) : null,
      directionScaleFactor: directionVar ? Number(directionVar.attrs?.scale_factor ?? 1) : 1,
      directionAddOffset: directionVar ? Number(directionVar.attrs?.add_offset ?? 0) : 0,
      directionMissingValue: directionVar && directionVar.attrs?._FillValue !== undefined && directionVar.attrs?._FillValue !== null ? Number(directionVar.attrs._FillValue) : null,
      bounds: { latMin, latMax, lonMin, lonMax },
      lowerBounds: safeSplit !== null ? { lonMin: lonEdges ? lonEdges[0] : lonMin, lonMax: lonEdges ? lonEdges[safeSplit] : splitLon, latMin, latMax } : null,
      upperBounds: safeSplit !== null ? { lonMin: lonEdges ? lonEdges[safeSplit] : splitLon, lonMax: lonEdges ? lonEdges[lonEdges.length-1] : lonMax, latMin, latMax } : null,
    };

    this.onTimeChange?.(
      buildTimeLabel(this.dataset, 0),
      0,
      this.dataset.timeCount - 1
    );
    return this.dataset;
  }

  private async render() {
    if (!this.mounted) return;

    this.renderInFlight = true;
    const requestId = ++this.renderRequestId;

    if (this.loadingDelayTimeout) {
      clearTimeout(this.loadingDelayTimeout);
      this.loadingDelayTimeout = null;
    }

    // Avoid flicker during fast frames: only show loading if a frame is slow.
    this.loadingDelayTimeout = setTimeout(() => {
      this.loadingDelayTimeout = null;
      if (this.mounted && requestId === this.renderRequestId) {
        this.setLoadingVisible(true);
      }
    }, 140);

    this.onErrorChange?.(null);

    try {
      const dataset = await this.ensureDatasetLoaded();
      const activeTime = dataset.hasTime ? Math.min(this.timeIndex, dataset.timeCount - 1) : 0;
      const selection = buildSliceSelection(dataset.dimensionNames, dataset.latName, dataset.lonName, dataset.timeDimensionName, activeTime);
      const dirSelection = dataset.directionVariable ? buildSliceSelection(dataset.directionDimensionNames, dataset.latName, dataset.lonName, dataset.directionTimeDimensionName, activeTime) : null;

      let result: any;
      let dirResult: any | null;

      if (this.prefetchedPromise && this.prefetchedTimeIndex === activeTime) {
        ({ result, dirResult } = await this.prefetchedPromise);
      } else {
        [result, dirResult] = await Promise.all([
          zarritaGet(dataset.variable, selection),
          dirSelection ? zarritaGet(dataset.directionVariable, dirSelection) : Promise.resolve(null),
        ]);
      }

      // Prefetch next timestep to reduce stutter during playback.
      if (dataset.hasTime && dataset.timeCount > 1) {
        const nextTime = activeTime >= dataset.timeCount - 1 ? 0 : activeTime + 1;
        if (this.prefetchedTimeIndex !== nextTime) {
          const nextSelection = buildSliceSelection(
            dataset.dimensionNames,
            dataset.latName,
            dataset.lonName,
            dataset.timeDimensionName,
            nextTime,
          );
          const nextDirSelection = dataset.directionVariable
            ? buildSliceSelection(
                dataset.directionDimensionNames,
                dataset.latName,
                dataset.lonName,
                dataset.directionTimeDimensionName,
                nextTime,
              )
            : null;

          this.prefetchedTimeIndex = nextTime;
          this.prefetchedPromise = Promise.all([
            zarritaGet(dataset.variable, nextSelection),
            nextDirSelection
              ? zarritaGet(dataset.directionVariable, nextDirSelection)
              : Promise.resolve(null),
          ]).then(([prefetchResult, prefetchDirResult]) => ({
            result: prefetchResult,
            dirResult: prefetchDirResult,
          }));
        }
      }
      const accessor = buildSpatialAccessor(result.data, result.shape, dataset.latAxisInResult, dataset.lonAxisInResult);
      let dirAccessor = null;
      if (dirResult && dataset.directionVariable) {
        try {
          dirAccessor = buildSpatialAccessor(dirResult.data, dirResult.shape, dataset.directionLatAxisInResult, dataset.directionLonAxisInResult);
        } catch (e) {
          console.warn("Could not build direction accessor with detected axes, trying swapped axes");
          const swappedLatAxis = dataset.directionLonAxisInResult;
          const swappedLonAxis = dataset.directionLatAxisInResult;
          dirAccessor = buildSpatialAccessor(dirResult.data, dirResult.shape, swappedLatAxis, swappedLonAxis);
        }
      }
      const { width, height, getValue } = accessor;
      const decoded = new Float32Array(width * height);
      const shouldComputeStats = !this.config.colorRange && !this.cachedStats;
      let minVal = Infinity, maxVal = -Infinity;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const raw = getValue(x, y);
          const idx = y * width + x;
          if (!Number.isFinite(raw) || (dataset.missingValue !== null && raw === dataset.missingValue)) {
            decoded[idx] = NaN;
            continue;
          }
          const val = raw * dataset.scaleFactor + dataset.addOffset;
          decoded[idx] = val;

          if (shouldComputeStats) {
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
          }
        }
      }

      if (shouldComputeStats && Number.isFinite(minVal) && Number.isFinite(maxVal)) {
        this.cachedStats = { min: minVal, max: maxVal, units: dataset.variableUnits };
        // Only report stats once to avoid per-timestep UI churn.
        this.onStatsChange?.(minVal, maxVal, dataset.variableUnits);
      }

      const range =
        this.config.colorRange ??
        (this.cachedStats ? { min: this.cachedStats.min, max: this.cachedStats.max } : { min: 0, max: 1 });
      const rangeSpan = range.max - range.min || 1;
      const colormap = getColormap(this.config.colormap);

      const zoom = this.map.getZoom();
      const splitIdx = dataset.splitIndex;
      const visibleHeight = dataset.visibleRowEnd - dataset.visibleRowStart + 1;
      const lowerWidth = splitIdx === null ? width : splitIdx;
      const upperWidth = splitIdx === null ? 0 : width - splitIdx;
      const fullWidth = width;
      const requestedScale = Math.min(8, Math.max(1, 2 ** Math.max(0, zoom - 1.5)));
      const safeScale = Math.min(requestedScale, MAX_RENDER_DIMENSION / Math.max(1, fullWidth), MAX_RENDER_DIMENSION / Math.max(1, lowerWidth), MAX_RENDER_DIMENSION / Math.max(1, upperWidth || 1), MAX_RENDER_DIMENSION / Math.max(1, visibleHeight));
      const renderScale = Math.max(1, safeScale);
      const targetFullWidth = Math.max(fullWidth, Math.round(fullWidth * renderScale));
      const targetLowerWidth = Math.max(lowerWidth, Math.round(lowerWidth * renderScale));
      const targetUpperWidth = Math.max(upperWidth, Math.round(upperWidth * renderScale));
      const targetHeight = Math.max(visibleHeight, Math.round(visibleHeight * renderScale));
      const mercTop = latToMercatorY(dataset.bounds.latMax);
      const mercBottom = latToMercatorY(dataset.bounds.latMin);
      const latOrigin = dataset.latValues[0];

      const getInterpolated = (x: number, y: number) => {
        const x0 = Math.floor(x), y0 = Math.floor(y), x1 = x0+1, y1 = y0+1;
        if (x0<0 || x1>=width || y0<0 || y1>=height) {
          const nx = Math.round(x), ny = Math.round(y);
          if (nx>=0 && nx<width && ny>=0 && ny<height) return decoded[ny*width+nx];
          return NaN;
        }
        const fx = x - x0, fy = y - y0;
        const v00 = decoded[y0*width+x0], v10 = decoded[y0*width+x1], v01 = decoded[y1*width+x0], v11 = decoded[y1*width+x1];
        if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) {
          const nx = Math.round(x), ny = Math.round(y);
          if (nx>=0 && nx<width && ny>=0 && ny<height) return decoded[ny*width+nx];
          return NaN;
        }
        const top = interpolateFinite(v00, v10, fx);
        const bottom = interpolateFinite(v01, v11, fx);
        return interpolateFinite(top, bottom, fy);
      };

      const centerLng = this.map.getCenter()?.lng ?? 0;
      const mapBounds = this.map.getBounds();
      const rawWest = mapBounds.getWest();
      const rawEast = mapBounds.getEast();
      const viewCoversWorld = rawEast - rawWest >= 359.5 || (rawWest <= -179.999 && rawEast >= 179.999);
      const viewWest = viewCoversWorld ? -Infinity : wrapLongitudeNear(rawWest, centerLng);
      const viewEast = viewCoversWorld ? Infinity : wrapLongitudeNear(rawEast, centerLng);
      const viewSouth = Math.max(-MAX_MERCATOR_LAT, mapBounds.getSouth());
      const viewNorth = Math.min(MAX_MERCATOR_LAT, mapBounds.getNorth());

      const isLongitudeVisible = (shiftedLongitude: number) => {
        if (viewCoversWorld) {
          return true;
        }

        // When wrapping longitudes near the current center, it is possible for the
        // visible interval to cross the dateline in wrapped space (viewWest > viewEast).
        // In that case, the visible set is the union: [viewWest, +∞) ∪ (-∞, viewEast].
        if (viewWest <= viewEast) {
          return shiftedLongitude >= viewWest && shiftedLongitude <= viewEast;
        }

        return shiftedLongitude >= viewWest || shiftedLongitude <= viewEast;
      };

      // ========== ARROW GENERATION ==========
      let arrowPoints: any[] = [];
      if (dirAccessor && dataset.directionVariable) {
        const container = this.map.getContainer();
        const targetArrowColumns = Math.max(6, Math.round(container.clientWidth / 80));
        const targetArrowRows = Math.max(4, Math.round(container.clientHeight / 80));
        let visibleRowCount = 0;
        for (let r = dataset.visibleRowStart; r <= dataset.visibleRowEnd; r++) {
          const lat = dataset.latValues[r];
          if (lat >= viewSouth && lat <= viewNorth) visibleRowCount++;
        }
        let visibleColumnCount = 0;
        if (viewCoversWorld) {
          visibleColumnCount = width;
        } else {
          for (let c = 0; c < width; c++) {
            const shiftedLon = wrapLongitudeNear(dataset.lonValues[c], centerLng);
            if (isLongitudeVisible(shiftedLon)) visibleColumnCount++;
          }
        }
        const rowStride = Math.max(1, Math.ceil(Math.max(1, visibleRowCount) / targetArrowRows));
        const colStride = Math.max(1, Math.ceil(Math.max(1, visibleColumnCount) / targetArrowColumns));
        for (let r = dataset.visibleRowStart; r <= dataset.visibleRowEnd; r += rowStride) {
          const lat = dataset.latValues[r];
          if (lat < viewSouth || lat > viewNorth) continue;
          for (let c = 0; c < width; c += colStride) {
            const shiftedLon = wrapLongitudeNear(dataset.lonValues[c], centerLng);
            if (!isLongitudeVisible(shiftedLon)) continue;
            const val = decoded[r * width + c];
            if (!Number.isFinite(val)) continue;
            let dirVal = dirAccessor.getValue(c, r);
            if (!Number.isFinite(dirVal) || (dataset.directionMissingValue !== null && dirVal === dataset.directionMissingValue)) continue;
            dirVal = dirVal * dataset.directionScaleFactor + dataset.directionAddOffset;
            arrowPoints.push({
              position: [shiftedLon, lat],
              angle: ((dirVal % 360) + 360) % 360,
            });
          }
        }
      }

      const showRaster = this.config.showRaster !== false;
      const showArrows =
        this.config.showArrows !== false && Boolean(this.config.directionVariable);

      // Render bitmaps
      let bitmapLayers: any[] = [];
      if (showRaster && splitIdx !== null && dataset.lowerBounds && dataset.upperBounds) {
        const lowerCanvas = this.ensureCanvas("lower", targetLowerWidth, targetHeight);
        const upperCanvas = this.ensureCanvas("upper", targetUpperWidth, targetHeight);
        const lowerCtx = lowerCanvas.getContext("2d")!;
        const upperCtx = upperCanvas.getContext("2d")!;
        const lowerImg = lowerCtx.createImageData(targetLowerWidth, targetHeight);
        const upperImg = upperCtx.createImageData(targetUpperWidth, targetHeight);
        for (let row = 0; row < targetHeight; row++) {
          const t = (row + 0.5) / targetHeight;
          const mercY = mercTop + (mercBottom - mercTop) * t;
          const lat = mercatorYToLat(mercY);
          const srcY = dataset.latAscending ? (lat - latOrigin) / (dataset.latValues[1] - dataset.latValues[0]) : (latOrigin - lat) / (dataset.latValues[0] - dataset.latValues[1]);
          if (srcY < dataset.visibleRowStart || srcY > dataset.visibleRowEnd) continue;
          const lowerOff = row * targetLowerWidth * 4;
          const upperOff = row * targetUpperWidth * 4;
          for (let col = 0; col < targetLowerWidth; col++) {
            const srcX = ((col + 0.5) / targetLowerWidth) * lowerWidth - 0.5;
            const val = getInterpolated(srcX, srcY);
            const px = lowerOff + col * 4;
            if (!Number.isFinite(val)) { lowerImg.data[px+3] = 0; continue; }
            const tVal = Math.min(1, Math.max(0, (val - range.min) / rangeSpan));
            const [r,g,b] = colormap(tVal);
            lowerImg.data[px] = r; lowerImg.data[px+1] = g; lowerImg.data[px+2] = b; lowerImg.data[px+3] = 210;
          }
          for (let col = 0; col < targetUpperWidth; col++) {
            const srcX = splitIdx + ((col + 0.5) / targetUpperWidth) * upperWidth - 0.5;
            const val = getInterpolated(srcX, srcY);
            const px = upperOff + col * 4;
            if (!Number.isFinite(val)) { upperImg.data[px+3] = 0; continue; }
            const tVal = Math.min(1, Math.max(0, (val - range.min) / rangeSpan));
            const [r,g,b] = colormap(tVal);
            upperImg.data[px] = r; upperImg.data[px+1] = g; upperImg.data[px+2] = b; upperImg.data[px+3] = 210;
          }
        }
        lowerCtx.putImageData(lowerImg, 0, 0);
        upperCtx.putImageData(upperImg, 0, 0);
        if (!this.mounted || requestId !== this.renderRequestId) return;
        const lowerBoundsVar = getWrappedBoundsVariants(dataset.lowerBounds, centerLng);
        const upperBoundsVar = getWrappedBoundsVariants(dataset.upperBounds, centerLng);
        bitmapLayers = lowerBoundsVar.flatMap((b, i) => [
          this.createBitmapLayer(`lower-${requestId}-${i}`, lowerCanvas, b),
          this.createBitmapLayer(`upper-${requestId}-${i}`, upperCanvas, upperBoundsVar[i]),
        ]);
      } else if (showRaster) {
        const fullCanvas = this.ensureCanvas("full", targetFullWidth, targetHeight);
        const fullCtx = fullCanvas.getContext("2d")!;
        const fullImg = fullCtx.createImageData(targetFullWidth, targetHeight);
        for (let row = 0; row < targetHeight; row++) {
          const t = (row + 0.5) / targetHeight;
          const mercY = mercTop + (mercBottom - mercTop) * t;
          const lat = mercatorYToLat(mercY);
          const srcY = dataset.latAscending ? (lat - latOrigin) / (dataset.latValues[1] - dataset.latValues[0]) : (latOrigin - lat) / (dataset.latValues[0] - dataset.latValues[1]);
          if (srcY < dataset.visibleRowStart || srcY > dataset.visibleRowEnd) continue;
          const rowOff = row * targetFullWidth * 4;
          for (let col = 0; col < targetFullWidth; col++) {
            const srcX = ((col + 0.5) / targetFullWidth) * fullWidth - 0.5;
            const val = getInterpolated(srcX, srcY);
            const px = rowOff + col * 4;
            if (!Number.isFinite(val)) { fullImg.data[px+3] = 0; continue; }
            const tVal = Math.min(1, Math.max(0, (val - range.min) / rangeSpan));
            const [r,g,b] = colormap(tVal);
            fullImg.data[px] = r; fullImg.data[px+1] = g; fullImg.data[px+2] = b; fullImg.data[px+3] = 210;
          }
        }
        fullCtx.putImageData(fullImg, 0, 0);
        if (!this.mounted || requestId !== this.renderRequestId) return;
        const boundsVar = getWrappedBoundsVariants(dataset.bounds, centerLng);
        bitmapLayers = boundsVar.map((b, i) => this.createBitmapLayer(`full-${requestId}-${i}`, fullCanvas, b));
      }

      if (!this.mounted || requestId !== this.renderRequestId) {
        return;
      }

      this.updateBitmapLayers(bitmapLayers);
      this.updateDirectionLayers(
        showArrows && arrowPoints.length > 0
          ? [this.createDirectionLayer(`dir-${requestId}`, arrowPoints, zoom)]
          : [],
      );

      this.onTimeChange?.(buildTimeLabel(dataset, activeTime), activeTime, dataset.timeCount - 1);
    } catch (err) {
      this.onErrorChange?.(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.loadingDelayTimeout) {
        clearTimeout(this.loadingDelayTimeout);
        this.loadingDelayTimeout = null;
      }

      // Only clear loading for the latest request.
      if (requestId === this.renderRequestId) {
        this.setLoadingVisible(false);
      }

      this.renderInFlight = false;
      if (this.renderQueued) {
        this.renderQueued = false;
        this.requestRender();
      }
    }
  }

  // Public methods
  public setTimeIndex(index: number) {
    this.timeIndex = Math.max(0, Math.min(index, this.dataset?.timeCount - 1 || 0));
    this.requestRender();
  }

  public getTimeCount() {
    return this.dataset?.timeCount ?? 1;
  }

  public startPlayback(intervalMs = 700) {
    if (this.playInterval) clearInterval(this.playInterval);
    this.playInterval = setInterval(() => {
      const max = this.getTimeCount() - 1;
      const next = this.timeIndex >= max ? 0 : this.timeIndex + 1;
      this.setTimeIndex(next);
    }, intervalMs);
  }

  public stopPlayback() {
    if (this.playInterval) {
      clearInterval(this.playInterval);
      this.playInterval = null;
    }
  }

  public destroy() {
    this.mounted = false;
    this.stopPlayback();
    if (this.renderTimeout) clearTimeout(this.renderTimeout);

    if (this.loadingDelayTimeout) {
      clearTimeout(this.loadingDelayTimeout);
      this.loadingDelayTimeout = null;
    }

    this.map.off("zoomend", this.handleMapViewChange);
    this.map.off("moveend", this.handleMapViewChange);
    this.map.off("resize", this.handleMapViewChange);

    this.updateDirectionLayers([]);
    this.updateBitmapLayers([]);
    this.map.removeControl(this.directionOverlay);
    this.map.removeControl(this.bitmapOverlay);
  }
}