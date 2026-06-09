"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { layersConfig, LayerConfig } from "@/lib/layers.config";
import { UgridOverlay } from "@/lib/UgridOverlay";
import { WindAnimationOverlay } from "@/lib/WindAnimationOverlay";
import { ZarrOverlay } from "@/lib/zarrOverlay";
import { TimeseriesPopup, TimeseriesProvider } from "@/lib/TimeseriesPopup";
import "maplibre-gl/dist/maplibre-gl.css";

const rasterStyle = (tiles: string[], attribution: string): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {
    basemap: { type: "raster", tiles, tileSize: 256, attribution },
  },
  layers: [{ id: "basemap", type: "raster", source: "basemap" }],
});

type Basemap = { id: string; name: string; style: maplibregl.StyleSpecification | string };

const basemaps: Basemap[] = [
  {
    id: "satellite",
    name: "Satellite",
    style: rasterStyle(
      ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      "&copy; Esri, Maxar, Earthstar Geographics",
    ),
  },
  {
    id: "maplibre",
    name: "MapLibre",
    style: "https://demotiles.maplibre.org/style.json",
  },
  {
    id: "osm",
    name: "Streets",
    style: rasterStyle(
      ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      "&copy; OpenStreetMap contributors",
    ),
  },
  
  {
    id: "light",
    name: "Light",
    style: rasterStyle(
      ["https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png"],
      "&copy; OpenStreetMap contributors &copy; CARTO",
    ),
  },
  {
    id: "dark",
    name: "Dark",
    style: rasterStyle(
      ["https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png"],
      "&copy; OpenStreetMap contributors &copy; CARTO",
    ),
  },
];

type OverlayController = {
  destroy: () => void;
  setTimeIndex: (value: number) => void;
  setDepthIndex?: (value: number) => void;
  startPlayback: (intervalMs?: number) => void;
  stopPlayback: () => void;
  getTimeseriesAtPoint?: TimeseriesProvider["getTimeseriesAtPoint"];
  onLoadingChange?: (loading: boolean) => void;
  onErrorChange?: (error: string | null) => void;
  onTimeChange?: (label: string, idx: number, max: number) => void;
  onStatsChange?: (min: number, max: number, units: string) => void;
  onDepthChange?: (levels: number[], idx: number, units: string) => void;
};

export default function Home() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<OverlayController | null>(null);
  const windRef = useRef<WindAnimationOverlay | null>(null);
  const timeseriesPopupRef = useRef<TimeseriesPopup | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState(layersConfig[0].id);
  const [selectedBasemap, setSelectedBasemap] = useState(basemaps[0].id);
  const [showWind, setShowWind] = useState(true);
  const [depth, setDepth] = useState({ levels: [] as number[], index: 0, units: "" });
  const depthIndexRef = useRef(0);
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
      style: basemaps[0].style,
      center: [0, 0],
      zoom: 1.3,
      maxPitch: 0,
      renderWorldCopies: true,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    mapRef.current = map;

    // Click anywhere to inspect the active layer's full time series at that point.
    timeseriesPopupRef.current = new TimeseriesPopup(map, () => {
      const overlay = overlayRef.current;
      return overlay && typeof overlay.getTimeseriesAtPoint === "function"
        ? (overlay as TimeseriesProvider)
        : null;
    });

    return () => {
      timeseriesPopupRef.current?.destroy();
      timeseriesPopupRef.current = null;
      map.remove();
    };
  }, []);

  // Swap the basemap style. Overlays live on separate deck.gl/canvas layers,
  // so they survive setStyle and don't need to be rebuilt here. The map is
  // initialised with basemaps[0], so skip the first run to avoid a reload.
  const didInitBasemap = useRef(false);
  useEffect(() => {
    if (!mapRef.current) return;
    if (!didInitBasemap.current) {
      didInitBasemap.current = true;
      return;
    }
    const basemap = basemaps.find(b => b.id === selectedBasemap);
    if (basemap) mapRef.current.setStyle(basemap.style);
  }, [selectedBasemap]);

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
    depthIndexRef.current = 0;
    setDepth({ levels: [], index: 0, units: "" });

    const overlay: OverlayController = currentLayer.type === "ugrid"
      ? new UgridOverlay(mapRef.current, currentLayer)
      : new ZarrOverlay(mapRef.current, currentLayer);

    overlay.onLoadingChange = (loading) => setLayerUi(prev => ({ ...prev, loading }));
    overlay.onErrorChange = (error) => setLayerUi(prev => ({ ...prev, error }));
    overlay.onTimeChange = (label, idx, max) => setLayerUi(prev => ({ ...prev, timeLabel: label, timeIndex: idx, timeMax: max }));
    overlay.onStatsChange = (min, max, units) => setLayerUi(prev => ({ ...prev, stats: { min, max }, units }));
    overlay.onDepthChange = (levels, idx, units) => setDepth({ levels, index: idx, units });

    overlayRef.current = overlay;

    return () => overlay.destroy();
  }, [selectedLayerId, currentLayer]);

  useEffect(() => {
    if (!mapRef.current) return;

    if (windRef.current) {
      windRef.current.destroy();
      windRef.current = null;
    }

    if (!currentLayer.windAnimation || !showWind) {
      return;
    }

    const wind = new WindAnimationOverlay(mapRef.current, currentLayer.windAnimation);
    wind.setTimeIndex(layerUi.timeIndex);
    if (depthIndexRef.current > 0) wind.setDepthIndex(depthIndexRef.current);
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

  const handleDepthSlider = (val: number) => {
    depthIndexRef.current = val;
    setDepth(prev => ({ ...prev, index: val }));
    overlayRef.current?.setDepthIndex?.(val);
    windRef.current?.setDepthIndex(val);
  };

  const formatDepth = (value: number) => {
    // Depth is stored negative-down (e.g. -5 = 5 m below surface).
    const magnitude = Math.abs(value);
    return `${magnitude % 1 === 0 ? magnitude : magnitude.toFixed(1)} m`;
  };

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", left: 16, bottom: 16, zIndex: 10, padding: 8, borderRadius: 8, background: "rgba(15,23,42,0.9)", color: "#f8fafc", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 11, fontWeight: "bold", opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.5 }}>Basemap</div>
        {basemaps.map(b => (
          <button
            key={b.id}
            onClick={() => setSelectedBasemap(b.id)}
            style={{
              padding: "4px 10px",
              fontSize: 13,
              textAlign: "left",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              background: selectedBasemap === b.id ? "#2563eb" : "rgba(255,255,255,0.1)",
              color: "#f8fafc",
            }}
          >
            {b.name}
          </button>
        ))}
      </div>
      <div style={{ position: "absolute", top: 16, right: 16, zIndex: 10, background: "white", padding: 8, borderRadius: 8 }}>
        <select value={selectedLayerId} onChange={e => setSelectedLayerId(e.target.value)}>
          {layersConfig.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {currentLayer.windAnimation && (
          <label style={{ display: "block", marginTop: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={showWind}
              onChange={(e) => setShowWind(e.target.checked)}
              style={{ marginRight: 6, color:'black' }}
            />
            <span style={{color:'black' }}>Flow particles</span>
          </label>
        )}
      </div>
      {depth.levels.length > 1 && (
        <div style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", zIndex: 10, padding: "12px 10px", borderRadius: 12, background: "rgba(15,23,42,0.9)", color: "#f8fafc", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: "bold" }}>Depth</div>
          <div style={{ fontSize: 12, minWidth: 48, textAlign: "center" }}>{formatDepth(depth.levels[depth.index])}</div>
          <input
            type="range"
            min={0}
            max={depth.levels.length - 1}
            step={1}
            value={depth.index}
            onChange={e => handleDepthSlider(Number(e.target.value))}
            style={{ writingMode: "vertical-lr", direction: "rtl", height: 200 }}
          />
          <div style={{ fontSize: 10, opacity: 0.7, textAlign: "center", lineHeight: 1.3 }}>surface<br />↑ ↓<br />deep</div>
        </div>
      )}
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