
const store = new Map();
const MAX_ENTRIES = 1500;
let perfManager = null;

const _bridgePerfManager = pm => { perfManager = pm; };

function get(key) {
  const entry = store.get(key);
  if (!entry) { perfManager?.get?.(`__miss__${key}`); return null; }
  if (Date.now() > entry.expiresAt) { store.delete(key); perfManager?.get?.(`__miss__${key}`); return null; }
  store.delete(key); store.set(key, entry);
  return entry.value;
}

function set(key, value, ttlMs = 5 * 60e3) {
  store.delete(key);
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

const del = key => store.delete(key);

function sweep() {
  const now = Date.now(); let removed = 0;
  for (const [key, entry] of store) if (now > entry.expiresAt) { store.delete(key); removed++; }
  return removed;
}
const size = () => store.size;

export { get, set, del, sweep, size, _bridgePerfManager };
export default { get, set, del, sweep, size, _bridgePerfManager };
export const $plugin = { name: "xx-utils-cache", meta: { category: "utils", path: "utils/cache.js" }, setup() {} };
