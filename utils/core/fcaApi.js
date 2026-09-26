/**
 * Compatibility helpers for fcanew-r3nz75.
 *
 * The package exposes both the classic raw FCA API and createFcaClient(),
 * which provides namespaced users/threads/account methods. Commands use this
 * module so either representation remains safe and consistently bound.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFcaClient } = require("fcanew-r3nz75");

export function getFcaApi(api) {
  return api?.__rawApi || api;
}

export function getFcaClient(api) {
  const rawApi = getFcaApi(api);
  if (!rawApi) return null;
  if (!rawApi.__fcaClient) {
    Object.defineProperty(rawApi, "__fcaClient", {
      value: createFcaClient(rawApi),
      configurable: true,
      writable: true,
    });
  }
  return rawApi.__fcaClient;
}

function resolveMethod(api, method) {
  const rawApi = getFcaApi(api);
  if (typeof rawApi?.[method] === "function") {
    return { fn: rawApi[method], receiver: rawApi };
  }

  const client = getFcaClient(rawApi);
  const parts = String(method).split(".");
  let owner = client;
  for (const part of parts) owner = owner?.[part];
  if (typeof owner === "function") {
    return { fn: owner, receiver: null };
  }
  return null;
}

export function hasFcaMethod(api, method) {
  return Boolean(resolveMethod(api, method));
}

export async function callFcaApi(api, method, ...args) {
  const resolved = resolveMethod(api, method);
  if (!resolved) throw new Error(`fcanew-r3nz75 API غير متاحة: ${method}`);
  return await resolved.fn.apply(resolved.receiver, args);
}

export const $plugin = {
  name: "xx-core-fca-api",
  meta: { category: "core", path: "utils/core/fcaApi.js" },
  setup(_ctx) {},
};
