import { BusMap } from "./components/BusMap";
import { useBusPositions } from "./hooks/useBusPositions";
import "./index.css";

export function App() {
  const { vehicles, loading, error, lastUpdated } = useBusPositions();

  return (
    <div className="app">
      <header className="statusbar">
        <span className="title">Entur Bus Tracker</span>
        {loading && vehicles.length === 0 ? (
          <span>Loading…</span>
        ) : error ? (
          <span className="error">Error: {error}</span>
        ) : (
          <span>
            {vehicles.length} buses
            {lastUpdated && ` · updated ${lastUpdated.toLocaleTimeString()}`}
          </span>
        )}
      </header>
      <div className="map-wrapper">
        {!loading || vehicles.length > 0 ? (
          <BusMap vehicles={vehicles} />
        ) : (
          <div className="loading">Fetching bus positions…</div>
        )}
      </div>
    </div>
  );
}
