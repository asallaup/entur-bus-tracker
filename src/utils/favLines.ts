export interface FavLine { id: string; publicCode: string; name: string; color: string; }

const FAV_LINES_KEY = "favLines";

type FavListener = () => void;
const listeners = new Set<FavListener>();
export function subscribeFavLines(cb: FavListener) { listeners.add(cb); }
export function unsubscribeFavLines(cb: FavListener) { listeners.delete(cb); }

const favLines: Map<string, FavLine> = (() => {
  try {
    const raw = localStorage.getItem(FAV_LINES_KEY);
    if (!raw) return new Map();
    const data = JSON.parse(raw);
    const map = new Map<string, FavLine>();
    for (const item of data) {
      if (item?.id) map.set(item.id, item as FavLine);
    }
    return map;
  } catch { return new Map(); }
})();

export function getFavLines(): FavLine[] { return [...favLines.values()]; }
export function isFavLine(id: string): boolean { return favLines.has(id); }

export function toggleFavLine(line: FavLine) {
  if (favLines.has(line.id)) favLines.delete(line.id);
  else favLines.set(line.id, line);
  localStorage.setItem(FAV_LINES_KEY, JSON.stringify([...favLines.values()]));
  listeners.forEach((cb) => cb());
}
