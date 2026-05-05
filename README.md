# Entur Bus Tracker

A real-time bus and tram tracker for Norway built with React and Leaflet. Vehicle positions update every 15 seconds using the public [Entur](https://entur.no) APIs — no API key required.


## Features

- **Live vehicle positions** — buses and trams across Norway, refreshed every 15 s
- **Animated movement** — markers glide smoothly between position updates
- **Directional markers** — each marker rotates to show the vehicle's heading, color-coded by operator
- **Stop board** — click any bus stop (visible at zoom 14+) to see upcoming departures with real-time delay information
- **Journey view** — click a departure row to expand the full stop list for that trip
- **Route overlay** — click a vehicle or a line badge to draw its route shape on the map
- **Lines panel** — collapsible legend listing all lines in the current viewport; click to highlight
- **Location search** — autocomplete search for stops and places using the Entur geocoder
- **Go to my location** — centers the map on your current GPS position
- **Persistent map position** — your last view is saved to `localStorage`

## Tech stack

| Layer | Library |
|-------|---------|
| UI | React 18 + TypeScript |
| Map | Leaflet + react-leaflet |
| Bundler | Vite |
| Tiles | OpenStreetMap |
| Data | Entur Realtime API + Journey Planner GraphQL |

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Other commands

```bash
npm run build    # production build → dist/
npm run preview  # preview the production build locally
```

## Data sources

All transit data comes from [Entur's open APIs](https://developer.entur.org):

- **Realtime Vehicles API** — live GPS positions for buses and trams
- **Journey Planner v3 (GraphQL)** — stop places, departure boards, line details and route shapes
- **Geocoder API** — place and stop autocomplete

No authentication or API key is needed.

## License

MIT
