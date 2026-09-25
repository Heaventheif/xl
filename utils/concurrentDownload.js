export async function downloadWithLimit(items, fetchFn, limit = 6) {
    if (!Array.isArray(items) || !items.length) return [];
    const concurrency = Math.max(1, Math.min(limit | 0, items.length));
    const results = new Array(items.length).fill(null);
    let next = 0;

    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            try {
                results[i] = await fetchFn(items[i], i);
            } catch {
                results[i] = null;
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
}

export const $plugin = {
    name: "xx-utils-concurrent-download",
    meta: { category: "utils", path: "utils/concurrentDownload.js" },
    setup(_ctx) {}
};
