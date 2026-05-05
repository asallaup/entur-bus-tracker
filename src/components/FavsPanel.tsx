import L from "leaflet";
import { useEffect, useState } from "react";
import { subscribeFavs, unsubscribeFavs, getFavStops, toggleFav } from "./StopsLayer";
import type { FavStop } from "./StopsLayer";

export function FavsPanel({ map }: { map: L.Map }) {
  const [favs, setFavs] = useState<FavStop[]>(getFavStops());

  useEffect(() => {
    const update = () => setFavs(getFavStops());
    subscribeFavs(update);
    return () => unsubscribeFavs(update);
  }, []);

  if (favs.length === 0) return null;

  return (
    <div
      className="favs-panel"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="favs-title">★ Favourites</div>
      {favs.map((fav) => (
        <div key={fav.id} className="favs-item">
          <span
            className="favs-name"
            onClick={() => map.flyTo([fav.lat, fav.lng], 17, { duration: 1.2 })}
          >
            {fav.name}
          </span>
          <button
            className="favs-remove"
            onClick={() => toggleFav(fav.id)}
            title="Remove from favourites"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
