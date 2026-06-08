"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { layersConfig, LayerConfig } from "@/lib/layers.config";
import { UgridOverlay } from "@/lib/UgridOverlay";
import { WindAnimationOverlay } from "@/lib/WindAnimationOverlay";
import { ZarrOverlay } from "@/lib/zarrOverlay";
import "maplibre-gl/dist/maplibre-gl.css";

type OverlayController = {
  destroy: () => void;
  setTimeIndex: (value: number) => void;
  startPlayback: (intervalMs?: number) => void;
  stopPlayback: () => void;
  onLoadingChange?: (loading: boolean) => void;
  onErrorChange?: (error: string | null) => void;
  onTimeChange?: (label: string, idx: number, max: number) => void;
  onStatsChange?: (min: number, max: number, units: string) => void;
};

export default function Home() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<OverlayController | null>(null);
  const windRef = useRef<WindAnimationOverlay | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState(layersConfig[0].id);
  const [showWind, setShowWind] = useState(false);
  const [layerUi, setLayerUi] = useState({
    loading: false,
    error: null as string | null,
    timeLabel: "",
    timeIndex: 0,
    timeMax: 0,
    isPlaying: false,
    stats: null as { min: number; max: number } | null,
    units: "",
  });

  const currentLayer = layersConfig.find(l => l.id === selectedLayerId) as LayerConfig;

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
            attribution: "&copy; OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [0, 0],
      zoom: 1.3,
      maxPitch: 0,
      renderWorldCopies: true,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // Switch overlay when layer selection changes
  useEffect(() => {
    if (!mapRef.current) return;
    if (overlayRef.current) overlayRef.current.destroy();
    if (windRef.current) {
      windRef.current.destroy();
      windRef.current = null;
    }

    setLayerUi({
      loading: false,
      error: null,
      timeLabel: "",
      timeIndex: 0,
      timeMax: 0,
      isPlaying: false,
      stats: null,
      units: "",
    });

    const overlay: OverlayController = currentLayer.type === "ugrid"
      ? new UgridOverlay(mapRef.current, currentLayer)
      : new ZarrOverlay(mapRef.current, currentLayer);

    overlay.onLoadingChange = (loading) => setLayerUi(prev => ({ ...prev, loading }));
    overlay.onErrorChange = (error) => setLayerUi(prev => ({ ...prev, error }));
    overlay.onTimeChange = (label, idx, max) => setLayerUi(prev => ({ ...prev, timeLabel: label, timeIndex: idx, timeMax: max }));
    overlay.onStatsChange = (min, max, units) => setLayerUi(prev => ({ ...prev, stats: { min, max }, units }));

    overlayRef.current = overlay;

    return () => overlay.destroy();
  }, [selectedLayerId, currentLayer]);

  useEffect(() => {
    if (!mapRef.current) return;

    if (windRef.current) {
      windRef.current.destroy();
      windRef.current = null;
    }

    if (currentLayer.type !== "zarr" || !currentLayer.windAnimation || !showWind) {
      return;
    }

    const wind = new WindAnimationOverlay(mapRef.current, currentLayer.windAnimation);
    wind.setTimeIndex(layerUi.timeIndex);
    windRef.current = wind;

    return () => {
      wind.destroy();
      if (windRef.current === wind) {
        windRef.current = null;
      }
    };
  }, [currentLayer, showWind, layerUi.timeIndex]);

  const togglePlayback = () => {
    if (!overlayRef.current) return;
    if (layerUi.isPlaying) overlayRef.current.stopPlayback();
    else overlayRef.current.startPlayback();
    setLayerUi(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const handleTimeSlider = (val: number) => {
    if (overlayRef.current) overlayRef.current.setTimeIndex(val);
  };

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", top: 16, right: 16, zIndex: 10, background: "white", padding: 8, borderRadius: 8 }}>
        <select value={selectedLayerId} onChange={e => setSelectedLayerId(e.target.value)}>
          {layersConfig.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {currentLayer.type === "zarr" && currentLayer.windAnimation && (
          <label style={{ display: "block", marginTop: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={showWind}
              onChange={(e) => setShowWind(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Flow particles
          </label>
        )}
      </div>
      <div style={{ position: "absolute", bottom: 16, right: 16, zIndex: 10, width: 320, padding: 16, borderRadius: 12, background: "rgba(15,23,42,0.9)", color: "#f8fafc" }}>
        <div style={{ fontWeight: "bold" }}>{currentLayer.name}</div>
        <div style={{ fontSize: 13 }}>{layerUi.loading ? "Loading..." : layerUi.timeLabel}</div>
        {layerUi.stats && <div style={{ fontSize: 12 }}>Data: {layerUi.stats.min.toFixed(2)} – {layerUi.stats.max.toFixed(2)} {layerUi.units}</div>}
        {layerUi.timeMax > 0 && (
          <div>
            <button onClick={togglePlayback} style={{ width: "100%", marginBottom: 8, padding: "4px", background: layerUi.isPlaying ? "#dc2626" : "#2563eb", color: "white", border: "none", borderRadius: 4 }}>
              {layerUi.isPlaying ? "Pause" : "Play"}
            </button>
            <input type="range" min={0} max={layerUi.timeMax} value={layerUi.timeIndex} onChange={e => handleTimeSlider(Number(e.target.value))} style={{ width: "100%" }} />
            <div>Timestep {layerUi.timeIndex+1} / {layerUi.timeMax+1}</div>
          </div>
        )}
        {layerUi.error && <div style={{ color: "#fca5a5" }}>{layerUi.error}</div>}
      </div>
    </div>
  );
}