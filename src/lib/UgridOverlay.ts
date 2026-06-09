// lib/UgridOverlay.ts
import { MapboxOverlay } from "@deck.gl/mapbox";
import { IconLayer, PolygonLayer } from "@deck.gl/layers";
import type { Map } from "maplibre-gl";
import FetchStore from "@zarrita/storage/fetch";
import { get as zarritaGet, open as openZarrita } from "zarrita";
import { getColormap } from "./colormaps";
import type { PointTimeseries } from "./TimeseriesPopup";

type MeshNode = [number, number];
type TrianglePolygon = [MeshNode, MeshNode, MeshNode];
type RgbaColor = [number, number, number, number];
type ArrowPoint = {
  position: MeshNode;
  angle: number;
  magnitude: number;
};
type TriangleNodeIndices = [number, number, number];
type BarycentricPoint = [number, number, number];
type VisibleTriangle = {
  nodes: TrianglePolygon;
  values: [number, number, number];
  directions: [number, number, number];
  bounds: ReturnType<typeof triangleBounds>;
};
type DirectionMetadata = {
  standardName: string;
  longName: string;
  comment: string;
  units: string;
};

const DEFAULT_ARROW_PIXEL_SPACING = 56;

function triangleBounds(a: MeshNode, b: MeshNode, c: MeshNode) {
  return {
    lonMin: Math.min(a[0], b[0], c[0]),
    lonMax: Math.max(a[0], b[0], c[0]),
    latMin: Math.min(a[1], b[1], c[1]),
    latMax: Math.max(a[1], b[1], c[1]),
  };
}

function boundsIntersect(a: ReturnType<typeof triangleBounds>, b: { west: number; east: number; south: number; north: number }) {
  return !(a.lonMax < b.west || a.lonMin > b.east || a.latMax < b.south || a.latMin > b.north);
}

function getVisibleBounds(map: Map) {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  };
}

function interpolateScalar(a: number, b: number, c: number, bary: BarycentricPoint) {
  const [wa, wb, wc] = bary;
  return a * wa + b * wb + c * wc;
}

function interpolateAngleDegrees(a: number, b: number, c: number, bary: BarycentricPoint) {
  const [wa, wb, wc] = bary;
  const radians = [a, b, c].map((value) => (value * Math.PI) / 180);
  const x = Math.cos(radians[0]) * wa + Math.cos(radians[1]) * wb + Math.cos(radians[2]) * wc;
  const y = Math.sin(radians[0]) * wa + Math.sin(radians[1]) * wb + Math.sin(radians[2]) * wc;
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  return (angle + 360) % 360;
}

function computeBarycentric(point: MeshNode, a: MeshNode, b: MeshNode, c: MeshNode): BarycentricPoint | null {
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) < 1e-12) {
    return null;
  }

  const w1 = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const w2 = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const w3 = 1 - w1 - w2;

  const epsilon = -1e-7;
  if (w1 < epsilon || w2 < epsilon || w3 < epsilon) {
    return null;
  }

  return [w1, w2, w3];
}

function getArrowPixelSpacing(zoom: number) {
  return Math.max(28, DEFAULT_ARROW_PIXEL_SPACING - (zoom - 8) * 2);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function buildDirectionMetadata(raw: Record<string, unknown> | null | undefined): DirectionMetadata {
  return {
    standardName: normalizeText(raw?.standard_name),
    longName: normalizeText(raw?.long_name),
    comment: normalizeText(raw?.comment),
    units: normalizeText(raw?.units),
  };
}

function normalizeWaveDirectionForIcon(rawAngle: number, metadata: DirectionMetadata, offset = 0) {
  let direction = ((rawAngle % 360) + 360) % 360;

  const isFromDirection =
    metadata.standardName.includes("from_direction") ||
    metadata.longName.includes("from direction") ||
    metadata.comment.includes("from direction");

  if (isFromDirection) {
    direction = (direction + 180) % 360;
  }

  const isClockwiseFromNorth =
    metadata.comment.includes("clockwise from due north") ||
    metadata.comment.includes("north=0") ||
    metadata.units.includes("degree");

  const iconAngle = isClockwiseFromNorth ? -direction : direction;
  return ((iconAngle + offset) % 360 + 360) % 360;
}

async function fetchZarrAttributes(store: FetchStore, variableName: string) {
  try {
    const bytes = await store.get("/.zmetadata");
    if (!bytes) {
      return null;
    }
    const metadata = JSON.parse(new TextDecoder().decode(bytes));
    return metadata?.metadata?.[`${variableName}/.zattrs`] ?? null;
  } catch {
    return null;
  }
}

const DIRECTION_ARROW_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 4 L52 30 H40 V60 H24 V30 H12 Z" fill="black" stroke="white" stroke-width="4" stroke-linejoin="round"/></svg>',
)}`;

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

export interface UgridLayerConfig {
  type: "ugrid";
  id: string;
  name: string;
  datasetName: string;
  zarrBaseUrl?: string;
  variable: string;          // e.g., "hs"
  directionVariable?: string;
  colorRange?: { min: number; max: number };
  colormap?: string;
  opacity?: number;
  arrowStride?: number;
  arrowSize?: number;
  directionAngleOffset?: number;
  windAnimation?: import("./WindAnimationOverlay").WindConfig;
}

export class UgridOverlay {
  private map: Map;
  private overlay: MapboxOverlay;
  private config: UgridLayerConfig;
  private dataset: any = null;
  private timeIndex = 0;
  private playInterval: ReturnType<typeof setInterval> | null = null;
  private mounted = true;
  private renderRequestId = 0;
  private renderTimeout: ReturnType<typeof setTimeout> | null = null;
  private variableArray: any = null;
  private directionArray: any = null;
  private directionMetadata: DirectionMetadata = buildDirectionMetadata(null);
  private didAutoFitToData = false;
  private boundHandleMapMove = () => this.scheduleRender();
  private boundHandleMapZoom = () => this.scheduleRender();

  // UI callbacks
  public onTimeChange?: (label: string, idx: number, max: number) => void;
  public onStatsChange?: (min: number, max: number, units: string) => void;
  public onLoadingChange?: (loading: boolean) => void;
  public onErrorChange?: (error: string | null) => void;

  constructor(map: Map, config: UgridLayerConfig) {
    this.map = map;
    this.config = config;
    this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.map.addControl(this.overlay);
    this.map.on("moveend", this.boundHandleMapMove);
    this.map.on("zoomend", this.boundHandleMapZoom);
    queueMicrotask(() => {
      if (this.mounted) {
        void this.initialize();
      }
    });
  }

  private async initialize() {
    this.onLoadingChange?.(true);
    try {
      await this.loadDatasetMetadata();
      this.render();
    } catch (err) {
      this.onErrorChange?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.onLoadingChange?.(false);
    }
  }

  private async loadDatasetMetadata() {
    if (this.dataset) return this.dataset;

    const store = new FetchStore(buildZarrUrl(this.config.datasetName, this.config.zarrBaseUrl));
    const group = await openZarrita(store, { kind: "group" });

    const [lonArr, latArr, faceArr, timeArr] = await Promise.all([
      openZarrita(group.resolve("mesh_node_lon"), { kind: "array" }),
      openZarrita(group.resolve("mesh_node_lat"), { kind: "array" }),
      openZarrita(group.resolve("mesh_face_node"), { kind: "array" }),
      openZarrita(group.resolve("time"), { kind: "array" }).catch(() => null),
    ]);
    this.variableArray = await openZarrita(group.resolve(this.config.variable), {
      kind: "array",
    });
    this.directionArray = this.config.directionVariable
      ? await openZarrita(group.resolve(this.config.directionVariable), {
          kind: "array",
        }).catch(() => null)
      : null;
    if (this.config.directionVariable) {
      const rawDirectionMetadata = await fetchZarrAttributes(store, this.config.directionVariable);
      this.directionMetadata = buildDirectionMetadata(rawDirectionMetadata);
    }

    const [lon, lat, faces] = await Promise.all([
      zarritaGet(lonArr),
      zarritaGet(latArr),
      zarritaGet(faceArr),
    ]);

    // Convert face connectivity to 0‑based indices (NetCDF uses 1‑based)
    const indices = Array.from(faces.data as ArrayLike<number>);
    const minIndex = Math.min(...indices);
    const indexOffset = minIndex >= 1 ? 1 : 0;
    const triangles = indices.map((index) => index - indexOffset);

    const lonData = lon.data as ArrayLike<number>;
    const latData = lat.data as ArrayLike<number>;
    const nodes: MeshNode[] = Array.from(lonData, (x, i) => [x, latData[i]]);
    const lons = Array.from(lonData, Number);
    const lats = Array.from(latData, Number);

    const timeCount = timeArr?.shape?.[0] ?? this.variableArray?.shape?.[0] ?? 1;
    this.dataset = {
      nodes,
      triangles,
      timeCount,
      variable: this.config.variable,
      bounds: [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ] as [[number, number], [number, number]],
    };

    if (!this.didAutoFitToData) {
      this.didAutoFitToData = true;
      this.map.fitBounds(this.dataset.bounds, { padding: 30, animate: false });
    }

    this.onTimeChange?.("", 0, timeCount - 1);
    return this.dataset;
  }

  private async fetchDataSlice(timeIdx: number) {
    if (!this.variableArray) {
      await this.loadDatasetMetadata();
    }
    const slice = await zarritaGet(this.variableArray, [timeIdx, null]); // (time, mesh_node)
    return slice.data as ArrayLike<number>;
  }

  private async fetchDirectionSlice(timeIdx: number) {
    if (!this.config.directionVariable) return null;
    if (!this.directionArray) {
      await this.loadDatasetMetadata();
    }
    if (!this.directionArray) return null;
    const slice = await zarritaGet(this.directionArray, [timeIdx, null]);
    return slice.data as ArrayLike<number>;
  }

  private scheduleRender(delay = 0) {
    if (!this.mounted) return;
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }
    this.renderTimeout = setTimeout(() => {
      this.renderTimeout = null;
      void this.render();
    }, delay);
  }

  private async render() {
    if (!this.mounted) return;
    const requestId = ++this.renderRequestId;
    this.onLoadingChange?.(true);

    try {
      const ds = this.dataset;
      const [values, directionValues] = await Promise.all([
        this.fetchDataSlice(this.timeIndex),
        this.fetchDirectionSlice(this.timeIndex),
      ]);
      const numericValues = Array.from(values, Number);
      const minVal = this.config.colorRange?.min ?? Math.min(...numericValues);
      const maxVal = this.config.colorRange?.max ?? Math.max(...numericValues);
      const rangeSpan = maxVal - minVal || 1;
      const colormap = getColormap(this.config.colormap);
      const opacity = this.config.opacity ?? 0.7;
      const numericDirections = directionValues ? Array.from(directionValues, Number) : null;
      const arrowSize = this.config.arrowSize ?? 18;
      const directionAngleOffset = this.config.directionAngleOffset ?? 0;

      // Build polygon data: each triangle is an array of 3 vertices [lon, lat]
      const polygons: TrianglePolygon[] = [];
      const colors: RgbaColor[] = [];
      for (let i = 0; i < ds.triangles.length; i += 3) {
        const i0 = ds.triangles[i];
        const i1 = ds.triangles[i + 1];
        const i2 = ds.triangles[i + 2];
        if (
          i0 == null || i1 == null || i2 == null ||
          i0 < 0 || i1 < 0 || i2 < 0 ||
          i0 >= ds.nodes.length || i1 >= ds.nodes.length || i2 >= ds.nodes.length
        ) {
          continue;
        }
        const polygon: TrianglePolygon = [ds.nodes[i0], ds.nodes[i1], ds.nodes[i2]];
        polygons.push(polygon);
        // average value over the three nodes
        const val = (numericValues[i0] + numericValues[i1] + numericValues[i2]) / 3;
        if (!Number.isFinite(val)) {
          colors.push([0, 0, 0, 0]); // transparent
          continue;
        }
        const t = Math.min(1, Math.max(0, (val - minVal) / rangeSpan));
        const [r, g, b] = colormap(t);
        colors.push([r, g, b, Math.round(opacity * 255)]);
      }

      const fillLayer = new PolygonLayer({
        id: `ugrid-${requestId}`,
        data: polygons,
        getPolygon: (d: TrianglePolygon) => d,
        getFillColor: (_: TrianglePolygon, info: { index: number }) => colors[info.index] ?? [0, 0, 0, 0],
        stroked: false,
        extruded: false,
        opacity: 1,
        pickable: false,
      });

      const layers: any[] = [fillLayer];

      if (numericDirections) {
        const arrows: ArrowPoint[] = [];
        const zoom = this.map.getZoom();
        const visibleBounds = getVisibleBounds(this.map);
        const visibleTriangles: VisibleTriangle[] = [];

        for (let i = 0; i < ds.triangles.length; i += 3) {
          const i0 = ds.triangles[i];
          const i1 = ds.triangles[i + 1];
          const i2 = ds.triangles[i + 2];
          if (
            i0 == null || i1 == null || i2 == null ||
            i0 < 0 || i1 < 0 || i2 < 0 ||
            i0 >= ds.nodes.length || i1 >= ds.nodes.length || i2 >= ds.nodes.length
          ) {
            continue;
          }

          const a = ds.nodes[i0] as MeshNode;
          const b = ds.nodes[i1] as MeshNode;
          const c = ds.nodes[i2] as MeshNode;
          if (!boundsIntersect(triangleBounds(a, b, c), visibleBounds)) {
            continue;
          }

          const hs0 = numericValues[i0];
          const hs1 = numericValues[i1];
          const hs2 = numericValues[i2];
          const dir0 = numericDirections[i0];
          const dir1 = numericDirections[i1];
          const dir2 = numericDirections[i2];
          if (
            !Number.isFinite(hs0) || !Number.isFinite(hs1) || !Number.isFinite(hs2) ||
            !Number.isFinite(dir0) || !Number.isFinite(dir1) || !Number.isFinite(dir2)
          ) {
            continue;
          }

          visibleTriangles.push({
            nodes: [a, b, c],
            values: [hs0, hs1, hs2],
            directions: [dir0, dir1, dir2],
            bounds: triangleBounds(a, b, c),
          });
        }

        const arrowPixelSpacing = Math.max(12, this.config.arrowStride ?? getArrowPixelSpacing(zoom));
        const canvas = this.map.getCanvas();

        for (let y = arrowPixelSpacing / 2; y < canvas.height; y += arrowPixelSpacing) {
          for (let x = arrowPixelSpacing / 2; x < canvas.width; x += arrowPixelSpacing) {
            const lngLat = this.map.unproject([x, y]);
            const point: MeshNode = [lngLat.lng, lngLat.lat];

            for (const triangle of visibleTriangles) {
              if (
                point[0] < triangle.bounds.lonMin ||
                point[0] > triangle.bounds.lonMax ||
                point[1] < triangle.bounds.latMin ||
                point[1] > triangle.bounds.latMax
              ) {
                continue;
              }

              const bary = computeBarycentric(point, triangle.nodes[0], triangle.nodes[1], triangle.nodes[2]);
              if (!bary) {
                continue;
              }

              const magnitude = interpolateScalar(
                triangle.values[0],
                triangle.values[1],
                triangle.values[2],
                bary,
              );
              const angle = interpolateAngleDegrees(
                triangle.directions[0],
                triangle.directions[1],
                triangle.directions[2],
                bary,
              );

              if (Number.isFinite(magnitude) && Number.isFinite(angle)) {
                arrows.push({
                  position: point,
                  magnitude,
                  angle: normalizeWaveDirectionForIcon(angle, this.directionMetadata, directionAngleOffset),
                });
              }
              break;
            }
          }
        }

        layers.push(
          new IconLayer<ArrowPoint>({
            id: `ugrid-dir-${requestId}`,
            data: arrows,
            pickable: false,
            iconAtlas: DIRECTION_ARROW_ICON,
            iconMapping: {
              arrow: { x: 0, y: 0, width: 64, height: 64, anchorY: 32 },
            },
            getIcon: () => "arrow",
            getPosition: (d) => d.position,
            getAngle: (d) => d.angle,
            getSize: () => arrowSize,
            getColor: () => [0, 0, 0, 255],
            sizeUnits: "pixels",
            billboard: false,
          }),
        );
      }

      this.overlay.setProps({ layers });
      this.onStatsChange?.(minVal, maxVal, "m");
      this.onTimeChange?.(
        `Timestep ${this.timeIndex + 1}`,
        this.timeIndex,
        ds.timeCount - 1
      );
    } catch (err) {
      this.onErrorChange?.(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === this.renderRequestId) {
        this.onLoadingChange?.(false);
      }
    }
  }

  // Reads the full time series of the layer's variable(s) at the mesh node
  // nearest to a clicked point. Returns null when the mesh is too far away.
  public async getTimeseriesAtPoint(lng: number, lat: number): Promise<PointTimeseries | null> {
    await this.loadDatasetMetadata();
    if (!this.variableArray || !this.dataset) return null;

    const nodes = this.dataset.nodes as MeshNode[];
    if (!nodes.length) return null;

    // Reject clicks well outside the mesh bounding box.
    const [[lonMin, latMin], [lonMax, latMax]] = this.dataset.bounds;
    const margin = Math.max(lonMax - lonMin, latMax - latMin) * 0.05;
    if (lng < lonMin - margin || lng > lonMax + margin || lat < latMin - margin || lat > latMax + margin) {
      return null;
    }

    // Find the nearest mesh node (squared distance is enough for ranking).
    let bestNode = 0;
    let bestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const dLon = nodes[i][0] - lng;
      const dLat = nodes[i][1] - lat;
      const dist = dLon * dLon + dLat * dLat;
      if (dist < bestDist) {
        bestDist = dist;
        bestNode = i;
      }
    }

    const [heightRaw, dirRaw] = await Promise.all([
      zarritaGet(this.variableArray, [null, bestNode]), // (time, mesh_node) -> time
      this.directionArray ? zarritaGet(this.directionArray, [null, bestNode]) : Promise.resolve(null),
    ]);

    const toValues = (raw: ArrayLike<number>) =>
      Array.from(raw, (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
      });

    const heightValues = toValues(heightRaw.data as ArrayLike<number>);
    const timeLabels = heightValues.map((_, i) => `Timestep ${i + 1}`);

    const variables: PointTimeseries["variables"] = [
      { name: this.config.variable, units: "m", values: heightValues },
    ];
    if (dirRaw && this.config.directionVariable) {
      variables.push({
        name: this.config.directionVariable,
        units: "degree",
        values: toValues(dirRaw.data as ArrayLike<number>),
        isDirection: true,
      });
    }

    return {
      lon: nodes[bestNode][0],
      lat: nodes[bestNode][1],
      timeLabels,
      variables,
    };
  }

  public setTimeIndex(index: number) {
    this.timeIndex = Math.max(0, Math.min(index, this.dataset?.timeCount - 1));
    this.scheduleRender();
  }

  public getTimeCount() {
    return this.dataset?.timeCount ?? 1;
  }

  public startPlayback(intervalMs = 700) {
    if (this.playInterval) {
      clearInterval(this.playInterval);
    }
    this.playInterval = setInterval(() => {
      const max = this.getTimeCount();
      if (max <= 1) {
        return;
      }
      this.setTimeIndex((this.timeIndex + 1) % max);
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
    this.overlay.setProps({ layers: [] });
    this.map.off("moveend", this.boundHandleMapMove);
    this.map.off("zoomend", this.boundHandleMapZoom);
    this.map.removeControl(this.overlay);
  }
}