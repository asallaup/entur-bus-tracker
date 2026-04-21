import L from "leaflet";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

const MIN_ZOOM = 14;
const LABEL_MIN_ZOOM = 16;
const DEPARTURE_CACHE_TTL = 30_000;
const DEPARTURES_QUERY = `
  query($id: String!) {
    stopPlace(id: $id) {
      estimatedCalls(numberOfDepartures: 20, timeRange: 86400) {
        realtime
        expectedDepartureTime
        aimedDepartureTime
        destinationDisplay { frontText }
        serviceJourney { id line { publicCode transportMode } }
      }
    }
  }
`;

const JOURNEY_STOPS_QUERY = `
  query($id: String!) {
    serviceJourney(id: $id) {
      quays { name stopPlace { id name latitude longitude } }
      passingTimes {
        arrival { time }
        departure { time }
      }
    }
  }
`;

const STOP_ROUTES_QUERY = `
  query($id: String!) {
    stopPlace(id: $id) {
      quays {
        journeyPatterns {
          line { id publicCode transportMode }
          pointsOnLink { points }
        }
      }
    }
  }
`;

const STOP_ROUTE_COLORS = [
  "#e63946", "#1982c4", "#2a9d8f", "#f4a261",
  "#6a4c93", "#8ac926", "#ff924c", "#3a86ff",
  "#c77dff", "#06d6a0",
];

interface StopRouteData {
  lineId: string;
  publicCode: string;
  shapes: string[];
}

const stopRoutesCache = new Map<string, StopRouteData[]>();

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

async function fetchStopRoutes(stopId: string): Promise<StopRouteData[]> {
  if (stopRoutesCache.has(stopId)) return stopRoutesCache.get(stopId)!;
  try {
    const res = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({ query: STOP_ROUTES_QUERY, variables: { id: stopId } }),
    });
    const json = await res.json();
    const quays: Array<{ journeyPatterns: Array<{ line: { id: string; publicCode: string | null; transportMode: string | null }; pointsOnLink: { points: string } | null }> }> =
      json.data?.stopPlace?.quays ?? [];

    const lineMap = new Map<string, { publicCode: string; shapes: Set<string> }>();
    for (const quay of quays) {
      for (const jp of quay.journeyPatterns ?? []) {
        if (jp.line.transportMode !== "bus" && jp.line.transportMode !== "tram") continue;
        const points = jp.pointsOnLink?.points;
        if (!points) continue;
        if (!lineMap.has(jp.line.id)) {
          lineMap.set(jp.line.id, { publicCode: jp.line.publicCode ?? jp.line.id, shapes: new Set() });
        }
        lineMap.get(jp.line.id)!.shapes.add(points);
      }
    }

    const result: StopRouteData[] = [...lineMap.entries()].map(([lineId, { publicCode, shapes }]) => ({
      lineId,
      publicCode,
      shapes: [...shapes],
    }));
    stopRoutesCache.set(stopId, result);
    return result;
  } catch {
    return [];
  }
}

interface Departure {
  line: string;
  destination: string;
  expected: Date;
  delaySecs: number;
  realtime: boolean;
  mode: string;
  journeyId: string;
}

interface StopCall {
  name: string;
  time: string;
  stopPlaceId: string;
  lat: number;
  lng: number;
}

interface DepartureCache {
  data: Departure[];
  at: number;
}

const departureCache = new Map<string, DepartureCache>();
const journeyStopsCache = new Map<string, StopCall[]>();

async function fetchJourneyStops(journeyId: string): Promise<StopCall[]> {
  try {
    const res = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({ query: JOURNEY_STOPS_QUERY, variables: { id: journeyId } }),
    });
    const json = await res.json();
    if (json.errors) { console.error("JOURNEY_STOPS error:", JSON.stringify(json.errors)); return []; }
    const quays: any[] = json.data?.serviceJourney?.quays ?? [];
    const pts: any[] = json.data?.serviceJourney?.passingTimes ?? [];
    if (!pts.length) console.warn("passingTimes empty for", journeyId, json);
    const data: StopCall[] = pts.map((pt, i) => ({
      name: quays[i]?.stopPlace?.name ?? quays[i]?.name ?? "?",
      time: (pt.arrival?.time ?? pt.departure?.time ?? "").slice(0, 5),
      stopPlaceId: quays[i]?.stopPlace?.id ?? "",
      lat: quays[i]?.stopPlace?.latitude ?? 0,
      lng: quays[i]?.stopPlace?.longitude ?? 0,
    }));
    journeyStopsCache.set(journeyId, data);
    return data;
  } catch (e) {
    console.error("fetchJourneyStops failed", journeyId, e);
    return [];
  }
}

async function fetchDepartures(stopId: string): Promise<Departure[]> {
  const cached = departureCache.get(stopId);
  if (cached && Date.now() - cached.at < DEPARTURE_CACHE_TTL) return cached.data;
  try {
    const res = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({ query: DEPARTURES_QUERY, variables: { id: stopId } }),
    });
    const json = await res.json();
    const calls = json.data?.stopPlace?.estimatedCalls ?? [];
    const data: Departure[] = calls.map((c: any) => ({
      line: c.serviceJourney?.line?.publicCode ?? "?",
      destination: c.destinationDisplay?.frontText ?? "",
      expected: new Date(c.expectedDepartureTime),
      delaySecs: Math.round(
        (new Date(c.expectedDepartureTime).getTime() -
          new Date(c.aimedDepartureTime).getTime()) / 1000
      ),
      realtime: c.realtime,
      mode: c.serviceJourney?.line?.transportMode ?? "",
      journeyId: c.serviceJourney?.id ?? "",
    }));
    departureCache.set(stopId, { data, at: Date.now() });
    return data;
  } catch {
    return [];
  }
}

function filterDepartures(deps: Departure[]): Departure[] {
  const relevant = deps.filter((d) => d.mode === "bus" || d.mode === "tram" || d.mode === "");

  const lineCounts = new Map<string, number>();
  const capped = relevant.filter((d) => {
    const n = (lineCounts.get(d.line) ?? 0) + 1;
    lineCounts.set(d.line, n);
    return n <= 3;
  });

  const hasMixed = capped.some((d) => d.mode === "tram") && capped.some((d) => d.mode !== "tram");
  if (!hasMixed) return capped;

  let tramCount = 0;
  return capped.filter((d) => {
    if (d.mode === "tram") return ++tramCount <= 6;
    return true;
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function minutesUntil(d: Date): string {
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins} min`;
  return formatTime(d);
}

function lineColor(line: string): string {
  const palette = ["#0464b4", "#c8471a", "#1a7340", "#7b3f9e", "#b07800", "#c0004e"];
  let h = 0;
  for (let i = 0; i < line.length; i++) h = (h * 31 + line.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

function stopHoverContent(name: string, routes: StopRouteData[]): string {
  const badges = routes
    .map((r) => `<span class="dep-badge" style="background:${lineColor(r.publicCode)}">${r.publicCode}</span>`)
    .join("");
  return `<div class="stop-hover">
    <div class="stop-hover-header"><span class="stop-hover-name">${name}</span></div>
    ${routes.length ? `<div class="stop-hover-badges">${badges}</div>` : ""}
  </div>`;
}

function stopLabel(name: string): string {
  return `<span class="stop-label">${name}</span>`;
}

function departureTable(name: string, deps: Departure[]): string {
  if (deps.length === 0) {
    return `<div class="stop-popup"><strong>${name}</strong><p class="stop-nodep">No upcoming departures</p></div>`;
  }
  const rows = deps
    .map((d) => {
      const delayMin = Math.round(d.delaySecs / 60);
      const delayHtml =
        delayMin > 2
          ? `<span class="dep-late dep-delay-inline">+${delayMin}m</span>`
          : delayMin < -1
          ? `<span class="dep-early dep-delay-inline">${delayMin}m</span>`
          : "";
      const mins = minutesUntil(d.expected);
      const minsClass = mins === "now" ? " dep-minutes--now" : "";
      const rt = d.realtime ? "" : `<span class="dep-noRT" title="No realtime data">~ </span>`;
      return `<tr data-line="${d.line}" data-journey-id="${d.journeyId}" class="dep-row">
        <td><span class="dep-badge" style="background:${lineColor(d.line)}">${d.line}</span></td>
        <td class="dep-dest">${d.destination}</td>
        <td class="dep-time-cell">${rt}<span class="dep-minutes${minsClass}">${mins}</span> <span class="dep-clock">${formatTime(d.expected)}</span>${delayHtml}</td>
        <td class="dep-chevron">›</td>
      </tr>`;
    })
    .join("");
  return `<div class="stop-popup">
    <strong>${name}</strong>
    <table class="dep-table">
      <thead><tr><th>Line</th><th>Destination</th><th>Departs</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

interface StopPlace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

const STOPS_QUERY = `
  query($minLat:Float!,$minLon:Float!,$maxLat:Float!,$maxLon:Float!) {
    stopPlacesByBbox(
      minimumLatitude:$minLat, minimumLongitude:$minLon,
      maximumLatitude:$maxLat, maximumLongitude:$maxLon
    ) { id name latitude longitude transportMode }
  }
`;

async function fetchStops(
  minLat: number, minLon: number,
  maxLat: number, maxLon: number
): Promise<StopPlace[]> {
  try {
    const res = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({
        query: STOPS_QUERY,
        variables: { minLat, minLon, maxLat, maxLon },
      }),
    });
    const json = await res.json();
    const places: Array<StopPlace & { transportMode: string[] }> =
      json.data?.stopPlacesByBbox ?? [];
    return places.filter((s) => s.transportMode?.includes("bus") || s.transportMode?.includes("tram"));
  } catch {
    return [];
  }
}

const stopIcon = L.divIcon({
  className: "",
  html: `<div class="stop-dot"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const stopIconHighlight = L.divIcon({
  className: "",
  html: `<div class="stop-dot stop-dot--hl"></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

export function StopsLayer() {
  const map = useMap();
  const markers = useRef<Map<string, L.Marker>>(new Map());
  const stopNames = useRef<Map<string, string>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPolylines = useRef<L.Polyline[]>([]);
  const selectedStopId = useRef<string | null>(null);
  const highlightedStopId = useRef<string | null>(null);
  const highlightedMarker = useRef<L.Marker | null>(null);
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyHighlight(stopId: string) {
    if (highlightedMarker.current) {
      highlightedMarker.current.setIcon(stopIcon);
      highlightedMarker.current = null;
    }
    if (highlightTimeout.current) { clearTimeout(highlightTimeout.current); highlightTimeout.current = null; }
    highlightedStopId.current = stopId;
    const m = markers.current.get(stopId);
    if (m) { m.setIcon(stopIconHighlight); highlightedMarker.current = m; }
    highlightTimeout.current = setTimeout(() => {
      if (highlightedMarker.current) { highlightedMarker.current.setIcon(stopIcon); highlightedMarker.current = null; }
      highlightedStopId.current = null;
      highlightTimeout.current = null;
    }, 5000);
  }

  function updateLabelVisibility() {
    const show = map.getZoom() >= LABEL_MIN_ZOOM;
    for (const m of markers.current.values()) {
      if (show) m.openTooltip(); else m.closeTooltip();
    }
  }

  function clearStopRoutes() {    stopPolylines.current.forEach((p) => p.remove());
    stopPolylines.current = [];
    selectedStopId.current = null;
  }

  function refresh() {
    if (map.getZoom() < MIN_ZOOM) {
      for (const m of markers.current.values()) m.remove();
      markers.current.clear();
      return;
    }
    const b = map.getBounds();
    fetchStops(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()).then((stops) => {
      const incoming = new Set(stops.map((s) => s.id));
      for (const [id, m] of markers.current) {
        if (!incoming.has(id)) { m.remove(); markers.current.delete(id); }
      }
      for (const stop of stops) {
        if (markers.current.has(stop.id)) continue;
        stopNames.current.set(stop.id, stop.name);
        const icon = highlightedStopId.current === stop.id ? stopIconHighlight : stopIcon;
        const marker = L.marker([stop.latitude, stop.longitude], { icon, zIndexOffset: 500 }).addTo(map);
        if (highlightedStopId.current === stop.id) highlightedMarker.current = marker;

        const popup = L.popup({
          closeButton: true,
          autoClose: true,
          className: "stop-tooltip",
          offset: L.point(0, -16),
          minWidth: 10,
        });

        let isHovered = false;
        let hoverTimer: ReturnType<typeof setTimeout> | null = null;

        const startHover = () => {
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
          isHovered = true;
          const name = stopNames.current.get(stop.id) ?? stop.name;
          const cached = stopRoutesCache.get(stop.id);
          if (cached) { marker.setTooltipContent(stopHoverContent(name, cached)); return; }
          fetchStopRoutes(stop.id).then((routes) => {
            if (isHovered) marker.setTooltipContent(stopHoverContent(name, routes));
          });
        };

        const endHover = () => {
          hoverTimer = setTimeout(() => {
            isHovered = false;
            marker.setTooltipContent(stopLabel(stopNames.current.get(stop.id) ?? stop.name));
          }, 80);
        };

        const openDepartures = () => {
          const name = stopNames.current.get(stop.id) ?? stop.name;
          if (popup.isOpen()) { popup.close(); return; }
          popup.setLatLng([stop.latitude, stop.longitude]);
          popup.openOn(map);
          const cached = departureCache.get(stop.id);
          if (cached && Date.now() - cached.at < DEPARTURE_CACHE_TTL) {
            popup.setContent(departureTable(name, filterDepartures(cached.data)));
            return;
          }
          popup.setContent(`<div class="stop-popup"><strong>${name}</strong><p class="stop-nodep">Loading…</p></div>`);
          fetchDepartures(stop.id).then((deps) => {
            if (popup.isOpen()) popup.setContent(departureTable(name, filterDepartures(deps)));
          });
        };

        marker.once("tooltipopen", () => {
          const tooltipEl = marker.getTooltip()?.getElement();
          if (!tooltipEl) return;
          tooltipEl.style.cursor = "pointer";
          tooltipEl.addEventListener("mouseover", startHover);
          tooltipEl.addEventListener("mouseout", endHover);
          tooltipEl.addEventListener("click", openDepartures);
          L.DomEvent.disableClickPropagation(tooltipEl);
        });

        marker.bindTooltip(stopLabel(stop.name), {
          permanent: true,
          direction: "right",
          offset: [6, 0],
          className: "stop-label-tooltip",
        });

        marker.on("mouseover", startHover);
        marker.on("mouseout", endHover);
        marker.on("click", openDepartures);

        popup.on("add", () => {
          const el = popup.getElement();
          if (!el || (el as any)._handlersAttached) return;
          (el as any)._handlersAttached = true;
          L.DomEvent.disableClickPropagation(el);
          el.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;

            const stopRow = target.closest(".dep-stop-row--link") as HTMLElement | null;
            if (stopRow) {
              const lat = parseFloat(stopRow.dataset.lat ?? "");
              const lng = parseFloat(stopRow.dataset.lng ?? "");
              const stopId = stopRow.dataset.stopId ?? "";
              if (!isNaN(lat) && !isNaN(lng)) {
                if (stopId) applyHighlight(stopId);
                popup.close();
                map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 1 });
              }
              return;
            }

            const row = target.closest("tr[data-line]") as HTMLElement | null;
            if (!row) return;

            // Badge click → select route on map
            if (target.closest(".dep-badge")) {
              const lineCode = row.dataset.line;
              if (!lineCode) return;
              clearStopRoutes();
              selectedStopId.current = stop.id;
              fetchStopRoutes(stop.id).then((routes) => {
                if (selectedStopId.current !== stop.id) return;
                const matching = routes.filter((r) => r.publicCode === lineCode);
                if (!matching.length) return;
                const added: L.Polyline[] = [];
                matching.forEach((route) => {
                  for (const encoded of route.shapes) {
                    const pts = decodePolyline(encoded);
                    if (pts.length < 2) continue;
                    added.push(L.polyline(pts, { color: "#e63946", weight: 5, opacity: 0.85 }).addTo(map));
                  }
                });
                stopPolylines.current = added;
              });
              return;
            }

            // Row click → expand / collapse stop list
            const journeyId = row.dataset.journeyId;
            if (!journeyId) return;
            const existing = row.nextElementSibling as HTMLElement | null;
            if (existing?.classList.contains("dep-expansion-row")) {
              existing.remove();
              row.classList.remove("dep-row--open");
              return;
            }
            // Close any other open expansion
            el.querySelectorAll(".dep-expansion-row").forEach((r) => r.remove());
            el.querySelectorAll(".dep-row--open").forEach((r) => r.classList.remove("dep-row--open"));
            row.classList.add("dep-row--open");
            const expRow = document.createElement("tr");
            expRow.className = "dep-expansion-row";
            expRow.innerHTML = `<td colspan="4" class="dep-expansion-cell"><span class="dep-expansion-loading">Loading…</span></td>`;
            row.insertAdjacentElement("afterend", expRow);
            fetchJourneyStops(journeyId).then((allStops) => {
              if (!expRow.isConnected) return;
              const fromIdx = allStops.findIndex((s) => s.stopPlaceId === stop.id);
              if (!allStops.length) {
                expRow.innerHTML = `<td colspan="4" class="dep-expansion-cell dep-expansion-loading">No data</td>`;
                return;
              }
              const stopsHtml = allStops.map((s, i) => {
                const cls = i < fromIdx ? " dep-stop-row--past" : i === fromIdx ? " dep-stop-row--current" : "";
                return `<div class="dep-stop-row dep-stop-row--link${cls}" data-lat="${s.lat}" data-lng="${s.lng}" data-stop-id="${s.stopPlaceId}">
                  <span class="dep-stop-name">${s.name}</span>
                  <span class="dep-stop-time">${s.time}</span>
                </div>`;
              }).join("");
              expRow.innerHTML = `<td colspan="4" class="dep-expansion-cell">${stopsHtml}</td>`;
              const cell = expRow.querySelector(".dep-expansion-cell") as HTMLElement;
              const currentEl = expRow.querySelector(".dep-stop-row--current") as HTMLElement | null;
              if (cell && currentEl) cell.scrollTop = currentEl.offsetTop - cell.clientHeight / 2;
            });
          });
        });

        markers.current.set(stop.id, marker);
      }
      updateLabelVisibility();
    });
  }

  useEffect(() => {
    function onMove() {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(refresh, 300);
    }
    map.on("moveend zoomend", onMove);
    refresh();
    return () => {
      map.off("moveend zoomend", onMove);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
      clearStopRoutes();
      for (const m of markers.current.values()) m.remove();
      markers.current.clear();
    };
  }, [map]);

  return null;
}
