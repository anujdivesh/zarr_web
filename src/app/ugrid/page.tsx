// app/ugrid-map/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { UgridOverlay } from "@/lib/UgridOverlay";
import "maplibre-gl/dist/maplibre-gl.css";

export default function UgridMapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<UgridOverlay | null>(null);
  const [timeIdx, setTimeIdx] = useState(0);
  const [timeMax, setTimeMax] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [-161.5, -20.5],
      zoom: 8,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    mapRef.current = map;

    map.on("load", () => {
      const overlay = new UgridOverlay(map, {
        type: "ugrid",
        id: "ugrid",
        name: "Wave height (unstructured)",
        datasetName: "rarotonga_ugrid.zarr",
        zarrBaseUrl: "/api/zarr/",
        variable: "hs",
        directionVariable: "dirm",
        colorRange: { min: 0, max: 4 },
        colormap: "jet",
        opacity: 0.8,
        arrowSize: 18,
      });
      overlay.onLoadingChange = setLoading;
      overlay.onErrorChange = setError;
      overlay.onTimeChange = (_, idx, max) => {
        setTimeIdx(idx);
        setTimeMax(max);
      };
      overlayRef.current = overlay;
    });

    return () => {
      overlayRef.current?.destroy();
      map.remove();
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
      {(loading || error) && (
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            zIndex: 10,
            background: "rgba(0,0,0,0.75)",
            color: "white",
            padding: 10,
            maxWidth: 360,
          }}
        >
          {loading && !error ? "Loading mesh…" : error}
        </div>
      )}
      {timeMax > 0 && (
        <div style={{ position: "absolute", bottom: 16, right: 16, zIndex: 10, background: "rgba(0,0,0,0.7)", color: "white", padding: 8 }}>
          Timestep {timeIdx + 1} / {timeMax + 1}
          <input
            type="range"
            min={0}
            max={timeMax}
            value={timeIdx}
            onChange={(e) => overlayRef.current?.setTimeIndex(parseInt(e.target.value))}
            style={{ display: "block", marginTop: 4 }}
          />
        </div>
      )}
    </div>
  );
}