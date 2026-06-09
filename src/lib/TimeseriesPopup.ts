// lib/TimeseriesPopup.ts
//
// Click-to-inspect time series popup that works for every layer type.
//
// When the user clicks the map, this reads the full time series of the active
// layer's variable(s) at the clicked location and shows a small SVG line chart
// inside a MapLibre popup. Layers with two variables (e.g. wave height + mean
// wave direction) get one chart each.
//
// Overlays opt in by implementing `TimeseriesProvider.getTimeseriesAtPoint`.

import maplibregl from "maplibre-gl";

// ========== Shared types (implemented by the overlay classes) ==========
export interface TimeseriesVariable {
  /** Display name, e.g. "Significant wave height". */
  name: string;
  /** Units string, e.g. "m" or "degree". */
  units: string;
  /** One value per timestep. May contain NaN where data is missing. */
  values: number[];
  /** When true, the chart uses a fixed 0–360° axis. */
  isDirection?: boolean;
}

export interface PointTimeseries {
  lon: number;
  lat: number;
  /** One label per timestep (ISO date when available, else "Timestep N"). */
  timeLabels: string[];
  variables: TimeseriesVariable[];
}

export interface TimeseriesProvider {
  getTimeseriesAtPoint(lng: number, lat: number): Promise<PointTimeseries | null>;
}

// ========== Small chart helpers ==========
const CHART_WIDTH = 300;
const CHART_HEIGHT = 110;
const PAD_LEFT = 38;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatValue(value: number, isDirection: boolean) {
  if (!Number.isFinite(value)) return "—";
  if (isDirection) return `${Math.round(((value % 360) + 360) % 360)}°`;
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.01 || abs >= 1000)) return value.toExponential(2);
  return value.toFixed(2);
}

function buildChartSvg(variable: TimeseriesVariable, labels: string[], color: string): string {
  const { values, isDirection = false } = variable;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return `<div style="font-size:12px;color:#9ca3af;padding:6px 0;">No data at this location.</div>`;
  }

  let yMin: number;
  let yMax: number;
  if (isDirection) {
    yMin = 0;
    yMax = 360;
  } else {
    yMin = Math.min(...finite);
    yMax = Math.max(...finite);
    if (yMin === yMax) {
      // Avoid a zero-height axis for a flat series.
      const pad = Math.abs(yMin) > 0 ? Math.abs(yMin) * 0.1 : 1;
      yMin -= pad;
      yMax += pad;
    }
  }
  const ySpan = yMax - yMin || 1;

  const plotW = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const n = values.length;
  const xOf = (i: number) => PAD_LEFT + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v: number) => PAD_TOP + plotH - ((v - yMin) / ySpan) * plotH;

  // Build the polyline, breaking the path where values are missing (NaN).
  const segments: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(values[i])) {
      current.push(`${xOf(i).toFixed(1)},${yOf(values[i]).toFixed(1)}`);
    } else if (current.length) {
      segments.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) segments.push(current.join(" "));

  const polylines = segments
    .map(
      (pts) =>
        `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />`,
    )
    .join("");

  // Hover dots with native tooltips (label + value).
  const dots = values
    .map((v, i) => {
      if (!Number.isFinite(v)) return "";
      const label = labels[i] ?? `Timestep ${i + 1}`;
      const title = `${label}: ${formatValue(v, isDirection)} ${variable.units}`.trim();
      return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="${n > 60 ? 1.6 : 2.6}" fill="${color}"><title>${escapeHtml(title)}</title></circle>`;
    })
    .join("");

  // Y axis tick labels (top = max, bottom = min, plus midpoint).
  const ticks = isDirection ? [0, 180, 360] : [yMax, (yMax + yMin) / 2, yMin];
  const yLabels = ticks
    .map((t) => {
      const y = yOf(t);
      return `<text x="${PAD_LEFT - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#9ca3af">${formatValue(t, isDirection)}</text>` +
        `<line x1="${PAD_LEFT}" y1="${y.toFixed(1)}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5" />`;
    })
    .join("");

  // X axis: first and last time labels.
  const firstLabel = labels[0] ?? "";
  const lastLabel = labels[n - 1] ?? "";
  const xLabels =
    `<text x="${PAD_LEFT}" y="${CHART_HEIGHT - 6}" text-anchor="start" font-size="9" fill="#9ca3af">${escapeHtml(firstLabel.slice(0, 16))}</text>` +
    (n > 1
      ? `<text x="${CHART_WIDTH - PAD_RIGHT}" y="${CHART_HEIGHT - 6}" text-anchor="end" font-size="9" fill="#9ca3af">${escapeHtml(lastLabel.slice(0, 16))}</text>`
      : "");

  return (
    `<svg width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" style="display:block;">` +
    yLabels +
    polylines +
    dots +
    xLabels +
    `</svg>`
  );
}

function buildPopupHtml(data: PointTimeseries): string {
  const colors = ["#2563eb", "#dc2626", "#059669", "#d97706"];
  const coord = `${data.lat.toFixed(3)}°, ${data.lon.toFixed(3)}°`;
  const charts = data.variables
    .map((variable, i) => {
      const color = colors[i % colors.length];
      const unit = variable.units ? ` (${escapeHtml(variable.units)})` : "";
      return (
        `<div style="margin-top:${i === 0 ? 0 : 10}px;">` +
        `<div style="font-size:12px;font-weight:600;color:#111827;display:flex;align-items:center;gap:6px;">` +
        `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};"></span>` +
        `${escapeHtml(variable.name)}${unit}</div>` +
        buildChartSvg(variable, data.timeLabels, color) +
        `</div>`
      );
    })
    .join("");

  return (
    `<div style="font-family:system-ui,-apple-system,sans-serif;min-width:${CHART_WIDTH}px;">` +
    `<div style="font-size:11px;color:#6b7280;margin-bottom:2px;">Time series @ ${coord}</div>` +
    charts +
    `</div>`
  );
}

function loadingHtml(lng: number, lat: number): string {
  return (
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:#374151;min-width:160px;">` +
    `<div style="color:#6b7280;margin-bottom:4px;">Time series @ ${lat.toFixed(3)}°, ${lng.toFixed(3)}°</div>` +
    `Loading…</div>`
  );
}

function messageHtml(text: string): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:#6b7280;min-width:160px;">${escapeHtml(text)}</div>`;
}

// Lift the popup above the absolutely-positioned UI panels (z-index 10) and the
// wind animation canvas (z-index 10000), so the time-series plot is never hidden.
const POPUP_CLASS = "ts-popup";
function ensurePopupStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById("ts-popup-style")) return;
  const style = document.createElement("style");
  style.id = "ts-popup-style";
  style.textContent = `.${POPUP_CLASS}{z-index:10001;}`;
  document.head.appendChild(style);
}

// ========== Popup controller ==========
export class TimeseriesPopup {
  private map: maplibregl.Map;
  private getProvider: () => TimeseriesProvider | null;
  private popup: maplibregl.Popup | null = null;
  private requestId = 0;

  constructor(map: maplibregl.Map, getProvider: () => TimeseriesProvider | null) {
    this.map = map;
    this.getProvider = getProvider;
    ensurePopupStyle();
    this.map.on("click", this.handleClick);
  }

  private handleClick = async (event: maplibregl.MapMouseEvent) => {
    const provider = this.getProvider();
    if (!provider || typeof provider.getTimeseriesAtPoint !== "function") return;

    const { lng, lat } = event.lngLat;
    const requestId = ++this.requestId;

    this.showPopup(event.lngLat, loadingHtml(lng, lat));

    try {
      const data = await provider.getTimeseriesAtPoint(lng, lat);
      if (requestId !== this.requestId || !this.popup) return; // superseded or closed
      if (!data || data.variables.length === 0) {
        this.popup.setHTML(messageHtml("No data at this location."));
        return;
      }
      this.popup.setHTML(buildPopupHtml(data));
    } catch (err) {
      if (requestId !== this.requestId || !this.popup) return;
      this.popup.setHTML(messageHtml(err instanceof Error ? err.message : String(err)));
    }
  };

  private showPopup(lngLat: maplibregl.LngLat, html: string) {
    if (!this.popup) {
      this.popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: "340px",
        className: POPUP_CLASS,
      });
      // Drop the reference when the user closes it so the next click re-creates one.
      this.popup.on("close", () => {
        this.popup = null;
      });
      this.popup.setLngLat(lngLat).setHTML(html).addTo(this.map);
      return;
    }
    // Reuse the open popup: just move it and swap content. Avoid calling addTo()
    // again — it removes/re-adds internally, which fires "close" and would cancel
    // the in-flight request.
    this.popup.setLngLat(lngLat).setHTML(html);
    if (!this.popup.isOpen()) this.popup.addTo(this.map);
  }

  public destroy() {
    this.map.off("click", this.handleClick);
    this.requestId++;
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
  }
}
