"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// TiTiler configuration
const TITILER_BASE = "http://localhost:8000";
const DATASET = "latest_merged_v2.zarr";
const VARIABLE = "sig_wav_ht";
const TILE_MATRIX_SET = "WebMercatorQuad";

// Zarr metadata URL (same bucket as original)
const ZARR_BASE_URL = "https://s3.ap-southeast-2.wasabisys.com/spc-zarr-file/";

// Build TiTiler tile URL with current time index (no colormap/rescale for now)
function getTileUrl(timeIndex: number): string {
  // IMPORTANT:
  // Do not use `new URL(...{z}...)` here: URL will percent-encode `{}` into
  // `%7B`/`%7D`, which breaks MapLibre's tile template substitution and causes
  // TiTiler to receive literal `{z}` strings (422).
  // TiTiler's OpenAPI exposes the tile endpoint as `{y}.{format}` (e.g. `.png`).
  const base = `${TITILER_BASE}/datasets/${DATASET}/tiles/${TILE_MATRIX_SET}/{z}/{x}/{y}.png`;
  const params = new URLSearchParams({
    variable: VARIABLE,
    // TiTiler does NOT accept `time=` on this endpoint.
    // Our Zarr variable is 3D (time, lat, lon) so TiTiler exposes time as "bands".
    // Use 1-based band index selection to request a single timestep.
    bidx: String(timeIndex + 1),
    // Match MapLibre's raster source tileSize.
    // TiTiler's tilejson for this dataset returns tiles with `tilesize=512`.
    tilesize: "512",
  });
  return `${base}?${params.toString()}`;
}

// Fetch time dimension directly from Zarr metadata (client-side)
async function fetchTimeInfo() {
  try {
    const zarrUrl = new URL(`${DATASET}/`, ZARR_BASE_URL).toString();
    const zmetadataResp = await fetch(zarrUrl + ".zmetadata");
    if (!zmetadataResp.ok) return { timeCount: 1 };
    const zmetadata = await zmetadataResp.json();
    const consolidated = zmetadata.metadata;
    const varEntry = consolidated[`${VARIABLE}/.zarray`];
    if (!varEntry) return { timeCount: 1 };
    const dimensions: string[] = Array.isArray(varEntry.dimension_names)
      ? varEntry.dimension_names.map((v: unknown) => String(v))
      : [];
    const shape = varEntry.shape;
    const timeDimIndex = dimensions.findIndex((d: string) =>
      d.toLowerCase().includes("time")
    );
    if (timeDimIndex === -1) return { timeCount: 1 };
    const timeCount = shape[timeDimIndex];
    return { timeCount: timeCount || 1 };
  } catch (err) {
    console.error("Failed to fetch time info from Zarr", err);
    return { timeCount: 1 };
  }
}

export default function TiTilerMapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [timeIndex, setTimeIndex] = useState(0);
  const [timeMax, setTimeMax] = useState(0);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [mapReady, setMapReady] = useState(false);

  // Load time dimension info
  useEffect(() => {
    fetchTimeInfo().then(({ timeCount }) => {
      setTimeMax(Math.max(0, timeCount - 1));
      setLoadingInfo(false);
    });
  }, []);

  // Initialize map once
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
          },
        ],
      },
      center: [0, 0],
      zoom: 1.3,
      maxPitch: 0,
      renderWorldCopies: true,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-left");

    map.on("load", () => {
      mapRef.current = map;
      setMapReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Add/update tile layer when map ready or time index changes
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const map = mapRef.current;
    const sourceId = "titiler-wave-height";

    // Remove existing source/layer if any
    if (map.getLayer(sourceId)) map.removeLayer(sourceId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    // Add new source and layer
    map.addSource(sourceId, {
      type: "raster",
      tiles: [getTileUrl(timeIndex)],
      tileSize: 512,
      attribution: `Wave height (${VARIABLE}) via TiTiler`,
    });
    map.addLayer({
      id: sourceId,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": 0.85 },
    });

    const handleError = (event: any) => {
      if (event?.sourceId === sourceId) {
        // MapLibre surfaces TileJSON/Tile request errors here.
        console.error("TiTiler source error", event?.error ?? event);
      }
    };

    map.on("error", handleError);

    return () => {
      map.off("error", handleError);
    };
  }, [mapReady, timeIndex]);

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTimeIndex(parseInt(e.target.value, 10));
  };

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />

      {!loadingInfo && timeMax > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            right: 16,
            zIndex: 10,
            background: "rgba(15, 23, 42, 0.9)",
            color: "#f8fafc",
            padding: "12px 16px",
            borderRadius: 12,
            fontFamily: "system-ui, sans-serif",
            width: 260,
            backdropFilter: "blur(8px)",
          }}
        >
          <div style={{ fontSize: 14, marginBottom: 8 }}>
            Timestep {timeIndex + 1} / {timeMax + 1}
          </div>
          <input
            type="range"
            min={0}
            max={timeMax}
            step={1}
            value={timeIndex}
            onChange={handleTimeChange}
            style={{ width: "100%" }}
          />
        </div>
      )}

      {loadingInfo && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background: "black",
            color: "white",
            padding: "8px 16px",
            borderRadius: 8,
            zIndex: 20,
          }}
        >
          Loading time info…
        </div>
      )}
    </div>
  );
}