import { useEffect, useRef, useState } from "react";

export interface Vehicle {
  vehicleId: string;
  line: { lineRef: string; lineName: string | null } | null;
  location: { latitude: number; longitude: number } | null;
  delay: number | null;
  lastUpdated: string | null;
}

async function fetchVehicles(): Promise<Vehicle[]> {
  const res = await fetch("/api/vehicles");
  const json = await res.json();
  return json.vehicles ?? [];
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
      setVehicles(data);
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
