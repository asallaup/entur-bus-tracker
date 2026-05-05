import { Router } from "express";

const ENTUR_URL = "https://api.entur.io/journey-planner/v3/graphql";
const CLIENT = "demo-busmap";

export const journeyRouter = Router();

journeyRouter.post("/", async (req, res) => {
  try {
    const upstream = await fetch(ENTUR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": CLIENT },
      body: JSON.stringify(req.body),
    });
    const json = await upstream.json();
    res.json(json);
  } catch {
    res.status(502).json({ error: "Upstream request failed" });
  }
});
