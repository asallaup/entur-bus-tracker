import L from "leaflet";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import type { Vehicle } from "../hooks/useBusPositions";

interface LineDetails {
  id: string;
  publicCode: string | null;
  name: string | null;
  description: string | null;
  transportMode: string | null;
  operator: { id: string; name: string } | null;
}

const LINE_QUERY = `
  query($ids: [ID!]!) {
    lines(ids: $ids) {
      id publicCode name description transportMode
      operator { id name }
    }
  }
`;

const lineCache = new Map<string, LineDetails>();

async function fetchLineDetails(lineRef: string): Promise<LineDetails | null> {
  if (lineCache.has(lineRef)) return lineCache.get(lineRef)!;
  try {
    const res = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({ query: LINE_QUERY, variables: { ids: [lineRef] } }),
    });
    const json = await res.json();
    const line: LineDetails | undefined = json.data?.lines?.[0];
    if (line) lineCache.set(lineRef, line);
    return line ?? null;
  } catch {
    return null;
  }
}

async function fetchPublicCodes(lineRefs: string[]): Promise<void> {
  const uncached = [...new Set(lineRefs.filter((r) => !lineCache.has(r)))];
  if (uncached.length === 0) return;
  try {
    const res = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({ query: LINE_QUERY, variables: { ids: uncached } }),
    });
    const json = await res.json();
    for (const line of json.data?.lines ?? []) lineCache.set(line.id, line);
  } catch {
    // silently ignore
  }
}

// --- Animation -----------------------------------------------------------

const ANIM_DURATION = 14_000;

interface AnimState {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  startTime: number;
  rafId: number;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function animateTo(
  marker: L.Marker,
  anims: Map<string, AnimState>,
  id: string,
  toLat: number,
  toLng: number
) {
  const prev = anims.get(id);
  if (prev) cancelAnimationFrame(prev.rafId);

  const from = marker.getLatLng();
  const dist = Math.hypot(toLat - from.lat, toLng - from.lng);
  if (dist > MAX_ANIM_DIST) {
    marker.setLatLng([toLat, toLng]);
    anims.delete(id);
    return;
  }
  const state: AnimState = {
    fromLat: from.lat,
    fromLng: from.lng,
    toLat,
    toLng,
    startTime: performance.now(),
    rafId: 0,
  };

  function tick() {
    const t = Math.min((performance.now() - state.startTime) / ANIM_DURATION, 1);
    marker.setLatLng([lerp(state.fromLat, state.toLat, t), lerp(state.fromLng, state.toLng, t)]);
    if (t < 1) state.rafId = requestAnimationFrame(tick);
  }

  state.rafId = requestAnimationFrame(tick);
  anims.set(id, state);
}

// --- Bearing --------------------------------------------------------------

function calcBearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const Δλ = ((toLng - fromLng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const MIN_MOVE = 0.0001; // ~11 m in degrees
const MAX_ANIM_DIST = 0.5; // ~50 km — teleport if jump is unrealistically large


const OPERATOR_COLORS = [
  "#e63946", "#2a9d8f", "#f4a261", "#6a4c93",
  "#1982c4", "#8ac926", "#ff924c", "#3a86ff",
  "#c77dff", "#06d6a0",
];

function operatorColor(operatorId: string | null | undefined): string {
  if (!operatorId) return "#888";
  let hash = 0;
  for (let i = 0; i < operatorId.length; i++) hash = (hash * 31 + operatorId.charCodeAt(i)) >>> 0;
  return OPERATOR_COLORS[hash % OPERATOR_COLORS.length];
}

function busIcon(label: string, color: string, bearing = 0) {
  const svg = `<svg width="32" height="32" viewBox="-16 -16 32 32" overflow="visible" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${bearing})">
      <polygon points="0,-22 -5,-14 5,-14" fill="${color}" stroke="white" stroke-width="1.5"/>
    </g>
    <circle r="14" fill="${color}" stroke="white" stroke-width="2"/>
    <text y="4" text-anchor="middle" font-size="10" font-weight="700" fill="white" font-family="system-ui,sans-serif">${label}</text>
  </svg>`;
  return L.divIcon({
    className: "",
    html: svg,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -22],
  });
}

function iconProps(lineRef: string | null | undefined) {
  const cached = lineRef ? lineCache.get(lineRef) : undefined;
  return {
    label: cached?.publicCode ?? "?",
    color: operatorColor(cached?.operator?.id),
  };
}

function tooltipContent(v: Vehicle): string {
  const cached = v.line?.lineRef ? lineCache.get(v.line.lineRef) : undefined;
  const code = cached?.publicCode ?? v.line?.lineName ?? "?";
  const name = cached?.name ?? v.line?.lineName ?? "";
  const color = operatorColor(cached?.operator?.id);

  const routeHtml = name && name !== code
    ? `<span class="veh-route">${name}</span>`
    : "";

  let delayHtml = "";
  if (v.delay != null) {
    const mins = Math.round(v.delay / 60);
    if (mins > 1)       delayHtml = `<div class="veh-delay dep-late">+${mins} min delayed</div>`;
    else if (mins < -1) delayHtml = `<div class="veh-delay dep-early">${Math.abs(mins)} min early</div>`;
    else                delayHtml = `<div class="veh-delay veh-ontime">On time</div>`;
  }

  return `<div class="veh-popup">
    <div class="veh-head">
      <span class="dep-badge" style="background:${color}">${code}</span>
      ${routeHtml}
    </div>
    ${delayHtml}
  </div>`;
}

// --- Component -----------------------------------------------------------

import type { Operator, LineInfo } from "./BusMap";

interface Props {
  vehicles: Vehicle[];
  onOperatorsChange?: (operators: Operator[]) => void;
  onLinesChange?: (lines: LineInfo[]) => void;
  onLineSelect?: (line: LineInfo | null) => void;
  selectedLineId?: string | null;
}

export function BusMarkersLayer({ vehicles, onOperatorsChange, onLinesChange, onLineSelect, selectedLineId }: Props) {
  const map = useMap();
  const markers = useRef<Map<string, L.Marker>>(new Map());
  const vehicleData = useRef<Map<string, Vehicle>>(new Map());
  const anims = useRef<Map<string, AnimState>>(new Map());
  const bearings = useRef<Map<string, number>>(new Map());
  const settled = useRef<Set<string>>(new Set());

  const updateVisibleOperators = useRef<() => void>(() => {});
  updateVisibleOperators.current = () => {
    const bounds = map.getBounds();
    const operatorMap = new Map<string, Operator>();
    const lineMap = new Map<string, LineInfo>();

    for (const [id, marker] of markers.current) {
      if (!bounds.contains(marker.getLatLng())) continue;
      const v = vehicleData.current.get(id);
      const line = v?.line?.lineRef ? lineCache.get(v.line.lineRef) : undefined;
      if (line?.operator) {
        operatorMap.set(line.operator.id, {
          id: line.operator.id,
          name: line.operator.name,
          color: operatorColor(line.operator.id),
        });
      }
    }

    for (const v of vehicleData.current.values()) {
      const line = v?.line?.lineRef ? lineCache.get(v.line.lineRef) : undefined;
      if (line?.publicCode) {
        lineMap.set(line.id, {
          id: line.id,
          publicCode: line.publicCode,
          name: line.name ?? line.publicCode,
          color: operatorColor(line.operator?.id),
        });
      }
    }

    onOperatorsChange?.([...operatorMap.values()]);
    onLinesChange?.([...lineMap.values()]);
  };

  // Dim markers that don't belong to the selected line
  useEffect(() => {
    for (const [id, marker] of markers.current) {
      const v = vehicleData.current.get(id);
      const match = !selectedLineId || v?.line?.lineRef === selectedLineId;
      marker.setOpacity(match ? 1 : 0);
    }
  }, [selectedLineId]);

  // Re-filter legend when the viewport changes
  useEffect(() => {
    const handler = () => updateVisibleOperators.current();
    map.on("moveend zoomend", handler);
    return () => { map.off("moveend zoomend", handler); };
  }, [map]);

  useEffect(() => {
    const current = markers.current;
    const incoming = new Set(vehicles.map((v) => v.vehicleId));

    for (const [id, marker] of current) {
      if (!incoming.has(id)) {
        cancelAnimationFrame(anims.current.get(id)?.rafId ?? 0);
        anims.current.delete(id);
        settled.current.delete(id);
        marker.remove();
        current.delete(id);
        vehicleData.current.delete(id);
      }
    }

    for (const v of vehicles) {
      if (!v.location) continue;
      const { latitude, longitude } = v.location;
      if (!latitude && !longitude) continue;
      vehicleData.current.set(v.vehicleId, v);

      const existing = current.get(v.vehicleId);
      if (existing) {
        const from = existing.getLatLng();
        const dist = Math.hypot(latitude - from.lat, longitude - from.lng);
        if (dist > MIN_MOVE) {
          const b = calcBearing(from.lat, from.lng, latitude, longitude);
          bearings.current.set(v.vehicleId, b);
          const { label, color } = iconProps(v.line?.lineRef);
          existing.setIcon(busIcon(label, color, b));
        }
        if (settled.current.has(v.vehicleId)) {
          animateTo(existing, anims.current, v.vehicleId, latitude, longitude);
        } else {
          settled.current.add(v.vehicleId);
          existing.setLatLng([latitude, longitude]);
        }
      } else {
        const { label, color } = iconProps(v.line?.lineRef);
        const marker = L.marker([latitude, longitude], { icon: busIcon(label, color) })
          .bindTooltip(tooltipContent(v), { direction: "top", offset: [0, -16], className: "veh-tooltip" })
          .addTo(map);

        marker.on("click", () => {
          const vehicle = vehicleData.current.get(v.vehicleId) ?? v;
          const lineRef = vehicle?.line?.lineRef;
          if (!lineRef) { onLineSelect?.(null); return; }
          const cached = lineCache.get(lineRef);
          if (cached) {
            onLineSelect?.({ id: cached.id, publicCode: cached.publicCode ?? lineRef, name: cached.name ?? cached.publicCode ?? lineRef, color: operatorColor(cached.operator?.id) });
            return;
          }
          fetchLineDetails(lineRef).then((line) => {
            if (!line) { onLineSelect?.(null); return; }
            onLineSelect?.({ id: line.id, publicCode: line.publicCode ?? lineRef, name: line.name ?? line.publicCode ?? lineRef, color: operatorColor(line.operator?.id) });
          });
        });

        current.set(v.vehicleId, marker);
        settled.current.add(v.vehicleId);
      }
    }

    const lineRefs = vehicles.map((v) => v.line?.lineRef).filter((r): r is string => !!r);

    fetchPublicCodes(lineRefs).then(() => {
      for (const v of vehicles) {
        const marker = current.get(v.vehicleId);
        if (marker) {
          const { label, color } = iconProps(v.line?.lineRef);
          const b = bearings.current.get(v.vehicleId) ?? 0;
          marker.setIcon(busIcon(label, color, b));
          marker.setTooltipContent(tooltipContent(v));
        }
      }
      updateVisibleOperators.current();
    });
  }, [vehicles, map]);

  useEffect(() => {
    return () => {
      for (const state of anims.current.values()) cancelAnimationFrame(state.rafId);
      anims.current.clear();
      bearings.current.clear();
      settled.current.clear();
      for (const marker of markers.current.values()) marker.remove();
      markers.current.clear();
      vehicleData.current.clear();
    };
  }, []);

  return null;
}
