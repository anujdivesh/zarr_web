// app/test-inundation/page.tsx
"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { ZarrOverlay } from "@/lib/zarrOverlay";

export default function TestPage() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [-159.5, -20.5],
      zoom: 11,
    });
    mapRef.current = map;
    map.on("load", () => {
      const overlay = new ZarrOverlay(map, {
        id: "test",
        name: "Test",
        datasetName: "raro_inun.zarr",
        zarrBaseUrl: "/api/zarr/",
        heightVariable: "Depth",
        colorRange: { min: 0, max: 2 },
        showRaster: true,
        showArrows: false,
      });
      (window as Window & { overlay?: ZarrOverlay }).overlay = overlay;
    });
    return () => map.remove();
  }, []);

  return <div ref={containerRef} style={{ width: "100vw", height: "100vh" }} />;
}