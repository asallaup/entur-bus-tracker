import L from "leaflet";
import React, { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { BusMarkersLayer } from "./BusMarker";
import { StopsLayer } from "./StopsLayer";
import { FavsPanel } from "./FavsPanel";
import { isFavLine, toggleFavLine, subscribeFavLines, unsubscribeFavLines, getFavLines } from "../utils/favLines";
import type { Vehicle } from "../hooks/useBusPositions";

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

export interface Operator { id: string; name: string; color: string; }
export interface LineInfo  { id: string; publicCode: string; name: string; color: string; }

// --- Encoded polyline decoder --------------------------------------------

function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b: number, shift = 0, val = 0;
    do { b = encoded.charCodeAt(idx++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += val & 1 ? ~(val >> 1) : val >> 1;
    shift = 0; val = 0;
    do { b = encoded.charCodeAt(idx++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += val & 1 ? ~(val >> 1) : val >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// --- Lines by viewport ---------------------------------------------------

const LINES_BBOX_QUERY = `
  query($minLat:Float!,$minLon:Float!,$maxLat:Float!,$maxLon:Float!) {
    stopPlacesByBbox(
      minimumLatitude:$minLat, minimumLongitude:$minLon,
      maximumLatitude:$maxLat, maximumLongitude:$maxLon
    ) {
      quays {
        lines {
          id publicCode name transportMode
          operator { id name }
        }
      }
    }
  }
`;

async function fetchLinesByBbox(
  minLat: number, minLon: number,
  maxLat: number, maxLon: number
): Promise<LineInfo[]> {
  try {
    const res = await fetch("/api/journey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: LINES_BBOX_QUERY, variables: { minLat, minLon, maxLat, maxLon } }),
    });
    const json = await res.json();
    const stops: Array<{ quays: Array<{ lines: Array<{ id: string; publicCode: string | null; name: string | null; transportMode: string | null; operator: { id: string; name: string } | null }> }> }> =
      json.data?.stopPlacesByBbox ?? [];
    const lineMap = new Map<string, LineInfo>();
    for (const stop of stops) {
      for (const quay of stop.quays ?? []) {
        for (const line of quay.lines ?? []) {
          if (!line.publicCode || (line.transportMode !== "bus" && line.transportMode !== "tram")) continue;
          lineMap.set(line.id, {
            id: line.id,
            publicCode: line.publicCode,
            name: line.name ?? line.publicCode,
            color: operatorColor(line.operator?.id),
          });
        }
      }
    }
    return [...lineMap.values()];
  } catch {
    return [];
  }
}

function LinesFromViewportLayer({
  onLinesChange,
  selectedLineRef,
}: {
  onLinesChange: (lines: LineInfo[]) => void;
  selectedLineRef: React.RefObject<LineInfo | null>;
}) {
  const map = useMap();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function refresh() {
    const b = map.getBounds();
    fetchLinesByBbox(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()).then((incoming) => {
      const sel = selectedLineRef.current;
      if (sel && !incoming.some((l) => l.id === sel.id)) {
        onLinesChange([sel, ...incoming]);
      } else {
        onLinesChange(incoming);
      }
    });
  }

  useEffect(() => {
    function onMove() {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(refresh, 400);
    }
    map.on("moveend zoomend", onMove);
    refresh();
    return () => {
      map.off("moveend zoomend", onMove);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [map]);

  return null;
}

// --- Search control -------------------------------------------------------

interface SearchResult {
  id: string;
  label: string;
  lat: number;
  lng: number;
  isStop: boolean;
  lineInfo?: LineInfo;
}

const LINE_SEARCH_QUERY = `
  query($publicCode: String!) {
    lines(publicCode: $publicCode) {
      id publicCode name transportMode
      operator { id name }
    }
  }
`;

async function searchLines(publicCode: string): Promise<LineInfo[]> {
  if (!publicCode.trim()) return [];
  try {
    const res = await fetch("/api/journey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: LINE_SEARCH_QUERY, variables: { publicCode } }),
    });
    const json = await res.json();
    return (json.data?.lines ?? [])
      .filter((l: any) => l.publicCode && l.transportMode !== "water" && l.transportMode !== "air")
      .map((l: any) => ({
        id: l.id,
        publicCode: l.publicCode,
        name: l.name ?? l.publicCode,
        color: operatorColor(l.operator?.id),
      }));
  } catch {
    return [];
  }
}

async function searchPlaces(text: string): Promise<SearchResult[]> {
  if (!text.trim()) return [];
  try {
    const url = new URL("/api/geocoder/autocomplete", location.origin);
    url.searchParams.set("text", text);
    url.searchParams.set("lang", "no");
    url.searchParams.set("size", "8");
    url.searchParams.set("layers", "venue");
    const res = await fetch(url.toString());
    const json = await res.json();
    return (json.features ?? []).map((f: any) => ({
      id: f.properties.id,
      label: f.properties.label ?? f.properties.name,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      isStop: !!f.properties.id?.startsWith("NSR:StopPlace:"),
    }));
  } catch {
    return [];
  }
}

function SearchControl({ map, lines, onLineSelect }: { map: L.Map; lines: LineInfo[]; onLineSelect: (line: LineInfo) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const close = () => { setOpen(false); setQuery(""); setResults([]); };
    map.on("popupopen", close);
    return () => { map.off("popupopen", close); };
  }, [map]);

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!val.trim()) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      const q = val.trim().toLowerCase();

      const rankLine = (code: string) => code.toLowerCase() === q ? 0 : 1;

      const localLineResults: SearchResult[] = lines
        .filter((l) => l.publicCode.toLowerCase().startsWith(q) || l.name.toLowerCase().includes(q))
        .sort((a, b) => rankLine(a.publicCode) - rankLine(b.publicCode))
        .slice(0, 3)
        .map((l) => ({ id: l.id, label: `${l.publicCode} – ${l.name}`, lat: 0, lng: 0, isStop: false, lineInfo: l }));
      const seenIds = new Set(localLineResults.map((r) => r.id));
      const [apiLines, stopResults] = await Promise.all([searchLines(val.trim()), searchPlaces(val)]);
      const apiLineResults: SearchResult[] = apiLines
        .filter((l) => !seenIds.has(l.id))
        .sort((a, b) => rankLine(a.publicCode) - rankLine(b.publicCode))
        .map((l) => ({ id: l.id, label: `${l.publicCode} – ${l.name}`, lat: 0, lng: 0, isStop: false, lineInfo: l }));
      const combined = [...localLineResults, ...apiLineResults, ...stopResults].slice(0, 8);
      setResults(combined);
      setOpen(combined.length > 0);
    }, 250);
  }

  function select(r: SearchResult) {
    setQuery(r.label);
    setOpen(false);
    if (r.lineInfo) { onLineSelect(r.lineInfo); return; }
    map.flyTo([r.lat, r.lng], r.isStop ? 17 : 15, { duration: 1.2 });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setOpen(false); (e.target as HTMLElement).blur(); }
    if (e.key === "Enter" && results.length > 0) select(results[0]);
  }

  return (
    <div
      className="search-control"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <input
        type="text"
        className="search-input"
        placeholder="Search location or stop…"
        value={query}
        onChange={handleInput}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={handleKeyDown}
      />
      {query && (
        <button
          className="search-clear"
          onMouseDown={(e) => { e.preventDefault(); setQuery(""); setResults([]); setOpen(false); }}
          tabIndex={-1}
          aria-label="Clear search"
        >×</button>
      )}
      {open && (
        <ul className="search-results">
          {results.map((r) => (
            <li key={r.id} className="search-result" onMouseDown={() => select(r)}>
              {r.isStop && <span className="search-stop-badge">Stop</span>}
              {r.lineInfo && <span className="search-line-badge" style={{ background: r.lineInfo.color }}>{r.lineInfo.publicCode}</span>}
              {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Persistent map position ---------------------------------------------

function getSavedPos(): { center: [number, number]; zoom: number } {
  try {
    const raw = localStorage.getItem("mapPos");
    if (raw) {
      const { lat, lng, z } = JSON.parse(raw);
      if (typeof lat === "number" && typeof lng === "number" && typeof z === "number")
        return { center: [lat, lng], zoom: z };
    }
  } catch {}
  return { center: [59.91, 10.75], zoom: 12 };
}

const INITIAL_POS = getSavedPos();

function SaveMapPosition() {
  const map = useMap();
  useEffect(() => {
    const save = () => {
      const c = map.getCenter();
      localStorage.setItem("mapPos", JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() }));
    };
    map.on("moveend zoomend", save);
    return () => { map.off("moveend zoomend", save); };
  }, [map]);
  return null;
}

// --- Route layer ---------------------------------------------------------

function MapClickDeselect({ onDeselect }: { onDeselect: () => void }) {
  const map = useMap();
  const cb = useRef(onDeselect);
  cb.current = onDeselect;
  useEffect(() => {
    const handler = () => cb.current();
    map.on("click", handler);
    return () => { map.off("click", handler); };
  }, [map]);
  return null;
}

const ROUTE_QUERY = `
  query($id: ID!) {
    line(id: $id) {
      journeyPatterns { pointsOnLink { points } }
    }
  }
`;

const routeCache = new Map<string, string[]>(); // lineId → encoded polylines

async function fetchRouteShapes(lineId: string): Promise<string[]> {
  if (routeCache.has(lineId)) return routeCache.get(lineId)!;
  try {
    const res = await fetch("/api/journey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ROUTE_QUERY, variables: { id: lineId } }),
    });
    const json = await res.json();
    const patterns: Array<{ pointsOnLink: { points: string } }> =
      json.data?.line?.journeyPatterns ?? [];
    const seen = new Set<string>();
    const shapes = patterns
      .map((p) => p.pointsOnLink?.points)
      .filter((p): p is string => !!p && !seen.has(p) && !!seen.add(p));
    routeCache.set(lineId, shapes);
    return shapes;
  } catch {
    return [];
  }
}

function RouteLayer({ line, allLines, visible, onLineSelect }: { line: LineInfo | null; allLines: LineInfo[]; visible?: boolean; onLineSelect?: (line: LineInfo) => void }) {
  const map = useMap();
  const polylinesRef = useRef<L.Polyline[]>([]);
  const allLinesRef = useRef(allLines);
  allLinesRef.current = allLines;
  const prevLineId = useRef<string | null>(null);

  useEffect(() => {
    polylinesRef.current.forEach((p) => p.remove());
    polylinesRef.current = [];

    const linesToDraw = line ? [line] : (visible !== false ? allLinesRef.current.slice(0, 30) : []);
    if (linesToDraw.length === 0) return;

    let cancelled = false;

    Promise.all(linesToDraw.map((l) => fetchRouteShapes(l.id))).then((shapesArray) => {
      if (cancelled) return;
      const added: L.Polyline[] = [];
      const elemToLine = new Map<Element, LineInfo>();
      let labelPlaced = false;
      for (let i = 0; i < linesToDraw.length; i++) {
        const shapes = shapesArray[i];
        const lineInfo = linesToDraw[i];
        const color = lineInfo.color;
        const weight = line ? 5 : 4;
        for (const encoded of shapes) {
          const points = decodePolyline(encoded);
          if (points.length < 2) continue;
          const pl = L.polyline(points, { color, weight, opacity: line ? 0.85 : 0.8 }).addTo(map);
          const svgEl = pl.getElement();
          if (svgEl) elemToLine.set(svgEl, lineInfo);
          if (line && !labelPlaced) {
            pl.bindTooltip(
              `<div class="veh-popup"><div class="veh-head"><span class="dep-badge" style="background:${lineInfo.color}">${lineInfo.publicCode}</span><span class="veh-route">${lineInfo.name}</span></div></div>`,
              { permanent: true, className: "veh-tooltip", direction: "center" }
            );
            labelPlaced = true;
          } else if (!line) {
            pl.bindTooltip("", { sticky: true, className: "veh-tooltip" });
            pl.on("mouseover", (e: L.LeafletMouseEvent) => {
              pl.bringToFront();
              pl.setStyle({ weight: 6, opacity: 1 });
              const overlapping: LineInfo[] = [];
              const seen = new Set<string>();
              for (const el of document.elementsFromPoint(e.originalEvent.clientX, e.originalEvent.clientY)) {
                const li = elemToLine.get(el);
                if (li && !seen.has(li.id)) { overlapping.push(li); seen.add(li.id); }
              }
              if (!overlapping.length) overlapping.push(lineInfo);
              pl.setTooltipContent(
                `<div class="veh-popup">${overlapping.map((li) =>
                  `<div class="veh-head"><span class="dep-badge" style="background:${li.color}">${li.publicCode}</span><span class="veh-route">${li.name}</span></div>`
                ).join("")}</div>`
              );
            });
            pl.on("mouseout", () => pl.setStyle({ weight: 4, opacity: 0.8 }));
            pl.on("click", (e) => { L.DomEvent.stopPropagation(e); onLineSelect?.(lineInfo); });
          }
          added.push(pl);
        }
      }
      polylinesRef.current = added;
      const lineChanged = line?.id !== prevLineId.current;
      prevLineId.current = line?.id ?? null;
      if (line && added.length && lineChanged) map.fitBounds(L.featureGroup(added).getBounds(), { padding: [50, 50] });
    });

    return () => {
      cancelled = true;
      polylinesRef.current.forEach((p) => p.remove());
      polylinesRef.current = [];
    };
  }, [line, visible, allLines, map]);

  return null;
}

// --- Legends -------------------------------------------------------------

function OperatorLegend({ operators }: { operators: Operator[] }) {
  if (operators.length === 0) return null;
  const seen = new Set<string>();
  const unique = [...operators]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((op) => { if (seen.has(op.name)) return false; seen.add(op.name); return true; });
  return (
    <div className="map-legend" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="legend-title">Operators</div>
      {unique.map((op) => (
        <div key={op.id} className="legend-item">
          <span className="legend-dot" style={{ background: op.color }} />
          <span className="legend-name">{op.name}</span>
        </div>
      ))}
    </div>
  );
}

interface LinesLegendProps {
  lines: LineInfo[];
  selected: LineInfo | null;
  onSelect: (line: LineInfo | null) => void;
}

function LinesLegend({ lines, selected, onSelect }: LinesLegendProps) {
  const [open, setOpen] = React.useState(false);
  const [, setFavTick] = React.useState(0);

  React.useEffect(() => {
    const update = () => setFavTick((t) => t + 1);
    subscribeFavLines(update);
    return () => unsubscribeFavLines(update);
  }, []);

  if (lines.length === 0) return null;
  const sorted = [...lines].sort((a, b) => {
    const favDiff = (isFavLine(b.id) ? 1 : 0) - (isFavLine(a.id) ? 1 : 0);
    if (favDiff !== 0) return favDiff;
    return a.publicCode.localeCompare(b.publicCode, undefined, { numeric: true });
  });
  return (
    <div className="map-legend" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="legend-title legend-title--toggle" onClick={() => setOpen((o) => !o)}>
        Lines <span className="legend-chevron">{open ? "▲" : "▼"}</span>
      </div>
      {open && sorted.map((line) => {
        const isSelected = selected?.id === line.id;
        const isFav = isFavLine(line.id);
        return (
          <div
            key={line.id}
            className={`legend-item legend-item--clickable${isSelected ? " legend-item--selected" : ""}`}
            onClick={() => onSelect(isSelected ? null : line)}
          >
            <span className="legend-badge" style={{ background: line.color }}>{line.publicCode}</span>
            <span className="legend-name">{line.name}</span>
            <button
              className={`line-fav-btn${isFav ? " line-fav-btn--active" : ""}`}
              onClick={(e) => { e.stopPropagation(); toggleFavLine(line); }}
              title={isFav ? "Remove from favourites" : "Add to favourites"}
            >★</button>
          </div>
        );
      })}
    </div>
  );
}

// --- Locate control ------------------------------------------------------

const userIcon = L.divIcon({
  className: "",
  html: `<div class="user-dot"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

type LocateState = "idle" | "loading" | "error";

function LocateControl() {
  const map = useMap();
  const markerRef = useRef<L.Marker | null>(null);
  const [state, setState] = useState<LocateState>("idle");

  useEffect(() => { return () => { markerRef.current?.remove(); }; }, []);

  function locate() {
    if (!navigator.geolocation) { setState("error"); return; }
    setState("loading");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setState("idle");
        map.flyTo([coords.latitude, coords.longitude], 15, { duration: 1.2 });
        if (markerRef.current) {
          markerRef.current.setLatLng([coords.latitude, coords.longitude]);
        } else {
          markerRef.current = L.marker([coords.latitude, coords.longitude], { icon: userIcon })
            .bindTooltip("Your location", { direction: "top", offset: [0, -10] })
            .addTo(map);
        }
      },
      (err) => {
        setState("error");
        if (err.code === err.PERMISSION_DENIED)
          alert("Location access was denied.\n\nTo fix: click the lock icon in the address bar, set Location to Allow, then reload the page.");
      }
    );
  }

  return (
    <button
      className={`locate-btn${state === "error" ? " locate-btn--error" : ""}`}
      onClick={locate}
      disabled={state === "loading"}
      title={state === "loading" ? "Locating…" : state === "error" ? "Location unavailable" : "Go to my location"}
    >
      {state === "loading" ? "…" : "⊕"}
    </button>
  );
}

// --- BusMap --------------------------------------------------------------

interface Props { vehicles: Vehicle[]; }

function MapCapture({ onMap }: { onMap: (map: L.Map) => void }) {
  const map = useMap();
  useEffect(() => { onMap(map); }, [map]);
  return null;
}

export function BusMap({ vehicles }: Props) {
  const [map, setMap] = useState<L.Map | null>(null);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [lines, setLines] = useState<LineInfo[]>([]);
  const [selectedLine, setSelectedLine] = useState<LineInfo | null>(null);
  const [showVehicles, setShowVehicles] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  const selectedLineRef = useRef<LineInfo | null>(null);
  selectedLineRef.current = selectedLine;

  const viewportLinesRef = useRef<LineInfo[]>([]);

  function handleLinesChange(incoming: LineInfo[]) {
    viewportLinesRef.current = incoming;
    const favs = getFavLines().filter((f) => !incoming.some((l) => l.id === f.id));
    setLines([...favs, ...incoming]);
  }

  useEffect(() => {
    const update = () => {
      const incoming = viewportLinesRef.current;
      const favs = getFavLines().filter((f) => !incoming.some((l) => l.id === f.id));
      setLines([...favs, ...incoming]);
    };
    subscribeFavLines(update);
    return () => unsubscribeFavLines(update);
  }, []);

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <MapContainer center={INITIAL_POS.center} zoom={INITIAL_POS.zoom} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <SaveMapPosition />
        <LinesFromViewportLayer onLinesChange={handleLinesChange} selectedLineRef={selectedLineRef} />
        <MapClickDeselect onDeselect={() => setSelectedLine(null)} />
        <BusMarkersLayer
          vehicles={vehicles}
          onOperatorsChange={setOperators}
          onLineSelect={setSelectedLine}
          selectedLineId={selectedLine?.id ?? null}
          visible={showVehicles}
        />
        <RouteLayer line={selectedLine} allLines={lines} visible={showRoutes} onLineSelect={setSelectedLine} />
        <StopsLayer selectedLine={selectedLine} />
        <LocateControl />
        <MapCapture onMap={setMap} />
      </MapContainer>
      {map && (
        <SearchControl map={map} lines={lines} onLineSelect={setSelectedLine} />
      )}
      <div style={{ position: "absolute", top: 10, right: 10, zIndex: 1000 }} className="map-controls">
        <button
          className={`map-toggle map-toggle--vehicles${showVehicles ? " map-toggle--on" : ""}`}
          onClick={() => setShowVehicles((v) => !v)}
          title={showVehicles ? "Hide vehicles" : "Show vehicles"}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="4" width="13" height="7.5" rx="1.5" strokeWidth="1.4"/>
            <rect x="3" y="2" width="10" height="3" rx="1" strokeWidth="1.2"/>
            <line x1="1.5" y1="7.5" x2="14.5" y2="7.5" strokeWidth="1"/>
            <rect x="3.5" y="4.8" width="2.8" height="2" rx="0.4" strokeWidth="1"/>
            <rect x="9.7" y="4.8" width="2.8" height="2" rx="0.4" strokeWidth="1"/>
            <circle cx="4.5" cy="13" r="1.3" strokeWidth="1.3"/>
            <circle cx="11.5" cy="13" r="1.3" strokeWidth="1.3"/>
          </svg>
          Vehicles
        </button>
        <button
          className={`map-toggle map-toggle--routes${showRoutes ? " map-toggle--on" : ""}`}
          onClick={() => setShowRoutes((v) => !v)}
          title={showRoutes ? "Hide routes" : "Show routes"}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8">
            <path d="M3 14 C3 14 3 9 8 8 C13 7 13 2 13 2"/>
            <circle cx="3" cy="14" r="1.5" fill="currentColor" stroke="none"/>
            <circle cx="13" cy="2" r="1.5" fill="currentColor" stroke="none"/>
          </svg>
          Routes
        </button>
      </div>
      <div style={{ position: "absolute", bottom: 30, right: 10, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8 }}>
        <LinesLegend lines={lines} selected={selectedLine} onSelect={setSelectedLine} />
      </div>
      <div style={{ position: "absolute", bottom: 30, left: 10, zIndex: 1000 }}>
        {map && <FavsPanel map={map} onLineSelect={setSelectedLine} />}
      </div>
    </div>
  );
}
