import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { vehicleRouter } from "./routes/vehicles.js";
import { journeyRouter } from "./routes/journey.js";
import { geocoderRouter } from "./routes/geocoder.js";

const app = express();
app.use(express.json());

app.use("/api/vehicles", vehicleRouter);
app.use("/api/journey", journeyRouter);
app.use("/api/geocoder", geocoderRouter);

if (process.env.NODE_ENV === "production") {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = join(__dirname, "../../dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(join(clientDist, "index.html")));
}

const PORT = process.env.PORT ?? 3001;
app.listen(Number(PORT), () => console.log(`Server running on :${PORT}`));
