import type { UgridLayerConfig } from "./UgridOverlay";
import type { WindConfig } from "./WindAnimationOverlay";

export interface ZarrLayerConfig {
  type: "zarr";
  id: string;
  name: string;
  datasetName: string;         // e.g., "latest_merged_v2.zarr"
  zarrBaseUrl?: string;        // optional, defaults to env or constant
  heightVariable: string;      // e.g., "sig_wav_ht"
  directionVariable?: string;  // e.g., "mn_wav_dir" (optional, can be null)
  colorRange?: { min: number; max: number }; // default { min: 0, max: 4 }
  colormap?: string;           // e.g., "jet", "red-blue" (defaults to jet)
  showRaster?: boolean;        // default true
  showArrows?: boolean;        // default true when directionVariable provided
  windAnimation?: WindConfig;
  // Optional custom color function or colormap name
}

// MapLibre-style source/layer definition used by the legacy helpers in `layerManager.ts`.
// (Separate from the Zarr overlay configs used by `ZarrOverlay`.)
export interface LayerDefinition {
  id: string;
  // Keep this intentionally permissive: MapLibre's style-spec types are not
  // re-exported in a stable way across versions.
  type: string;
  source: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  bounds?: unknown;
}

// You can extend with other layer types (e.g., GeoJSON, vector tile)
export type LayerConfig = ZarrLayerConfig | UgridLayerConfig; // | GeoJsonLayerConfig | ...

export const layersConfig: LayerConfig[] = [
  {
    type: "zarr",
    id: "croco-sea-velocity",
    name: "CROCO Sea Water Velocity (speed + u/v particles)",
    datasetName: "d1_temp_salt_uv_z_all.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    // Raster shows current speed magnitude (sqrt(u^2+v^2)); particles animate u/v.
    heightVariable: "current_speed",
    colorRange: { min: 0, max: 0.8 },
    colormap: "jet",
    showRaster: true,
    showArrows: false,
    windAnimation: {
      datasetName: "d1_temp_salt_uv_z_all.zarr",
      zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
      uVariable: "u",
      vVariable: "v",
      latVariable: "lat",
      lonVariable: "lon",
      speedFactor: 0.35,
      particleCount: 2000,
      particleSize: 2.6,
      // Speed normalization for streak brightness/thickness (matches raster range).
      minSpeed: 0,
      maxSpeed: 0.8,
    },
  },
  {
    type: "zarr",
    id: "wave-height",
    name: "WAVEWATCH3 Significant Wave Height + Dir",
    datasetName: "wavewatch3.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    heightVariable: "sig_wav_ht",
    directionVariable: "mn_wav_dir",
    colorRange: { min: 0, max: 4 },
    colormap: "jet",
    /*
    windAnimation: {
      datasetName: "wavewatch3.zarr",
      zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
      speedVariable: "sig_wav_ht",
      directionVariable: "mn_wav_dir",
      latVariable: "lat",
      lonVariable: "lon",
      speedFactor: 0.02,
      particleCount: 3000,
      particleSize: 4,
    },*/
  },
  {
    type: "zarr",
    id: "inundation-depth2",
    name: "CK MODEL Raro Time Inundation Depth",
    datasetName: "sfincs_h_forecast.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",    // or wherever your API routes serve the Zarr
    heightVariable: "h",
    // Remove colorRange and colormap temporarily
    colorRange: { min: 0, max: 2 },
    colormap: "jet",
    showRaster: true,
    showArrows: false,
  },
 /*{
    type: "zarr",
    id: "wave-direction-only",
    name: "WAVEWATCH3 Mean Wave Direction (arrows)",
    datasetName: "latest_merged_v2.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    heightVariable: "sig_wav_ht",
    directionVariable: "mn_wav_dir",
    showRaster: false,
    showArrows: true,
  },*/
  {
    type: "ugrid",
    id: "rarotonga-ugrid",
    name: "CK MODEL Rarotonga UGRID Waves",
    datasetName: "rarotonga_ugrid.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    variable: "hs",
    directionVariable: "dirm",
    colorRange: { min: 0, max: 5 },
    colormap: "jet",
    opacity: 0.8,
    arrowSize: 18,
  },
  {
    type: "zarr",
    id: "croco-temperature",
    name: "CROCO Sea Water Temperature (z-levels)",
    datasetName: "d1_temp_salt_uv_z_all.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    heightVariable: "temperature",
    colorRange: { min: 20, max: 30 },
    colormap: "jet",
    showRaster: true,
    showArrows: false,
  },
  // Add another Zarr dataset later:
  // {
  //   type: "zarr",
  //   id: "sst",
  //   name: "Sea Surface Temperature",
  //   datasetName: "sst_dataset.zarr",
  //   heightVariable: "sst",
  //   directionVariable: undefined,
  //   colorRange: { min: 10, max: 30 },
  // },
];