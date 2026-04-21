import { useEffect, useRef, useState } from "react";

export interface Vehicle {
  vehicleId: string;
  line: { lineRef: string; lineName: string | null } | null;
  location: { latitude: number; longitude: number } | null;
  delay: number | null;
  lastUpdated: string | null;
}

const BUS_QUERY = `{
  vehicles(mode: BUS) {
    vehicleId
    line { lineRef lineName }
    location { latitude longitude }
    delay
    lastUpdated
  }
}`;

const TRAM_QUERY = `{
  vehicles(mode: TRAM) {
    vehicleId
    line { lineRef lineName }
    location { latitude longitude }
    delay
    lastUpdated
  }
}`;

async function fetchVehicles(): Promise<Vehicle[]> {
  const [busRes, tramRes] = await Promise.all([
    fetch("https://api.entur.io/realtime/v2/vehicles/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({ query: BUS_QUERY }),
    }),
    fetch("https://api.entur.io/realtime/v2/vehicles/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "demo-busmap" },
      body: JSON.stringify({ query: TRAM_QUERY }),
    }),
  ]);
  const [busJson, tramJson] = await Promise.all([busRes.json(), tramRes.json()]);
  return [...(busJson.data?.vehicles ?? []), ...(tramJson.data?.vehicles ?? [])];
}

export function useBusPositions() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const data = await fetchVehicles();
      setVehicles(data.filter((v) => v.location !== null));
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 15_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { vehicles, loading, error, lastUpdated };
}
