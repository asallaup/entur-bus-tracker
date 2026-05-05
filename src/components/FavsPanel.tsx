import L from "leaflet";
import { useEffect, useState } from "react";
import { subscribeFavs, unsubscribeFavs, getFavStops, toggleFav } from "./StopsLayer";
import type { FavStop } from "./StopsLayer";
import { subscribeFavLines, unsubscribeFavLines, getFavLines, toggleFavLine } from "../utils/favLines";
import type { FavLine } from "../utils/favLines";
import type { LineInfo } from "./BusMap";

interface Props {
  map: L.Map;
  onLineSelect: (line: LineInfo) => void;
}

export function FavsPanel({ map, onLineSelect }: Props) {
  const [stops, setStops] = useState<FavStop[]>(getFavStops());
  const [lines, setLines] = useState<FavLine[]>(getFavLines());

  useEffect(() => {
    const update = () => setStops(getFavStops());
    subscribeFavs(update);
    return () => unsubscribeFavs(update);
  }, []);

  useEffect(() => {
    const update = () => setLines(getFavLines());
    subscribeFavLines(update);
    return () => unsubscribeFavLines(update);
  }, []);

  if (stops.length === 0 && lines.length === 0) return null;

  return (
    <div
      className="favs-panel"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="favs-title">★ Favourites</div>

      {lines.map((line) => (
        <div key={line.id} className="favs-item">
          <span className="dep-badge" style={{ background: line.color, flexShrink: 0 }}>
            {line.publicCode}
          </span>
          <span className="favs-name" onClick={() => onLineSelect(line as LineInfo)}>
            {line.name}
          </span>
          <button className="favs-remove" onClick={() => toggleFavLine(line)} title="Remove from favourites">
            ✕
          </button>
        </div>
      ))}

      {stops.map((stop) => (
        <div key={stop.id} className="favs-item">
          <span className="favs-stop-dot" />
          <span className="favs-name" onClick={() => map.flyTo([stop.lat, stop.lng], 17, { duration: 1.2 })}>
            {stop.name}
          </span>
          <button className="favs-remove" onClick={() => toggleFav(stop.id)} title="Remove from favourites">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
