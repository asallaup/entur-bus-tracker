import { Router } from "express";

const ENTUR_BASE = "https://api.entur.io/geocoder/v1";
const CLIENT = "demo-busmap";

export const geocoderRouter = Router();

geocoderRouter.get("/autocomplete", async (req, res) => {
  try {
    const url = new URL(`${ENTUR_BASE}/autocomplete`);
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === "string") url.searchParams.set(k, v);
    }
    const upstream = await fetch(url.toString(), {
      headers: { "ET-Client-Name": CLIENT },
    });
    const json = await upstream.json();
    res.json(json);
  } catch {
    res.status(502).json({ error: "Upstream request failed" });
  }
});
