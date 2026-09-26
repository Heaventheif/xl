/**
 * Small compatibility layer for FCA-NX APIs.
 *
 * Command handlers receive the safety wrapper, while data/mutation methods
 * must execute on the original fcanew-r3nz75 API object. FCA-NX 6.7.x returns
 * Promises for these methods and also accepts legacy callbacks; keeping the
 * call in one place prevents command code from depending on either detail.
 */
export function getFcaApi(api) {
  return api?.__rawApi || api;
}

export function hasFcaMethod(api, method) {
  return typeof getFcaApi(api)?.[method] === "function";
}

export async function callFcaApi(api, method, ...args) {
  const fcaApi = getFcaApi(api);
  const fn = fcaApi?.[method];
  if (typeof fn !== "function") {
    throw new Error(`fcanew-r3nz75 API غير متاحة: ${method}`);
  }
  return await fn.apply(fcaApi, args);
}

export const $plugin = {
  name: "xx-core-fca-api",
  meta: { category: "core", path: "utils/core/fcaApi.js" },
  setup(_ctx) {},
};
