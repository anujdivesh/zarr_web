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
export type LayerConfig = ZarrLayerConfig; // | GeoJsonLayerConfig | ...

export const layersConfig: LayerConfig[] = [
  {
    type: "zarr",
    id: "wave-height",
    name: "Significant Wave Height + Direction",
    datasetName: "latest_merged_v2.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    heightVariable: "sig_wav_ht",
    directionVariable: "mn_wav_dir",
    colorRange: { min: 0, max: 4 },
    colormap: "jet",
  },
  {
    type: "zarr",
    id: "wave-height-only",
    name: "Significant Wave Height",
    datasetName: "latest_merged_v2.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    heightVariable: "sig_wav_ht",
    directionVariable: undefined,
    colorRange: { min: 0, max: 4 },
    colormap: "red-blue",
    showRaster: true,
    showArrows: false,
  },
  {
    type: "zarr",
    id: "wave-direction-only",
    name: "Mean Wave Direction (arrows)",
    datasetName: "latest_merged_v2.zarr",
    zarrBaseUrl: "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/",
    heightVariable: "sig_wav_ht",
    directionVariable: "mn_wav_dir",
    showRaster: false,
    showArrows: true,
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