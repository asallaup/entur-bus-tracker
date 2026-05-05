import { Router } from "express";

const ENTUR_URL = "https://api.entur.io/realtime/v2/vehicles/graphql";
const CLIENT = "demo-busmap";

const BUS_QUERY = `{ vehicles(mode: BUS) { vehicleId line { lineRef lineName } location { latitude longitude } delay lastUpdated } }`;
const TRAM_QUERY = `{ vehicles(mode: TRAM) { vehicleId line { lineRef lineName } location { latitude longitude } delay lastUpdated } }`;

let cache: unknown[] = [];
let lastUpdated: string | null = null;

async function poll() {
  try {
    const [busRes, tramRes] = await Promise.all([
      fetch(ENTUR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "ET-Client-Name": CLIENT },
        body: JSON.stringify({ query: BUS_QUERY }),
      }),
      fetch(ENTUR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "ET-Client-Name": CLIENT },
        body: JSON.stringify({ query: TRAM_QUERY }),
      }),
    ]);
    const [busJson, tramJson] = await Promise.all([busRes.json(), tramRes.json()]) as [any, any];
    cache = [
      ...(busJson.data?.vehicles ?? []),
      ...(tramJson.data?.vehicles ?? []),
    ].filter((v: any) => v.location !== null);
    lastUpdated = new Date().toISOString();
  } catch (e) {
    console.error("Vehicle poll failed:", e);
  }
}

poll();
setInterval(poll, 15_000);

export const vehicleRouter = Router();

vehicleRouter.get("/", (_req, res) => {
  res.json({ vehicles: cache, lastUpdated });
});
