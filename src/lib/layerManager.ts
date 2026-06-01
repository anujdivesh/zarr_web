import maplibregl from "maplibre-gl";
import type { LayerDefinition } from "./layers.config";

/**
 * Adds a source and layer to the map based on the definition.
 * Existing source/layer with same id will be removed first to avoid conflicts.
 */
export function addLayerToMap(map: maplibregl.Map, layerDef: LayerDefinition) {
  // Remove existing source and layer if they exist (to cleanly switch)
  if (map.getLayer(layerDef.id)) {
    map.removeLayer(layerDef.id);
  }
  if (map.getSource(layerDef.id)) {
    map.removeSource(layerDef.id);
  }

  // Add source
  map.addSource(layerDef.id, layerDef.source as any);

  // Add layer
  map.addLayer(
    {
      id: layerDef.id,
      type: layerDef.type,
      source: layerDef.id,
      paint: layerDef.paint || {},
      layout: layerDef.layout || {},
    } as any,
  );
}

/**
 * Removes a layer and its source from the map.
 */
export function removeLayerFromMap(map: maplibregl.Map, layerId: string) {
  if (map.getLayer(layerId)) {
    map.removeLayer(layerId);
  }
  if (map.getSource(layerId)) {
    map.removeSource(layerId);
  }
}

/**
 * Fits the map bounds to the layer's defined bounds.
 */
export function fitBoundsToLayer(map: maplibregl.Map, layerDef: LayerDefinition) {
  if (layerDef.bounds) {
    map.fitBounds(layerDef.bounds as any, { padding: 20, animate: true });
  }
}