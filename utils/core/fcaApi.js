/**
 * Compatibility helpers for al-fca's classic callback-based API.
 * The command layer keeps its namespaced method names; this adapter maps them
 * to al-fca methods and turns callbacks/thenables into one Promise contract.
 */
const METHOD_MAP = Object.freeze({
  "threads.getInfo": "getThreadInfo",
  "threads.getList": "getThreadList",
  "threads.setTitle": "setTitle",
  "threads.setAdmin": "changeAdminStatus",
  "threads.setNickname": "changeNickname",
  "threads.removeUser": "removeUserFromGroup",
  "threads.addUsers": "addUserToGroup",
  "threads.handleMessageRequest": "handleMessageRequest",
  "users.getInfo": "getUserInfo",
  "account.handleFriendRequest": "handleFriendRequest",
});
const clientCache = new WeakMap();

export function getFcaApi(api) {
  return api?.__rawApi || api;
}

export function getFcaClient(api) {
  const rawApi = getFcaApi(api);
  if (!rawApi || typeof rawApi !== "object") return null;
  let client = clientCache.get(rawApi);
  if (client) return client;

  client = {};
  for (const method of Object.keys(METHOD_MAP)) {
    if (!hasFcaMethod(rawApi, method)) continue;
    const [namespace, name] = method.split(".");
    client[namespace] ??= {};
    client[namespace][name] = (...args) => callFcaApi(rawApi, method, ...args);
  }
  clientCache.set(rawApi, client);
  return client;
}

function resolvePath(object, path) {
  let owner = object;
  for (const part of String(path).split(".")) {
    if (owner == null) return null;
    const next = owner[part];
    if (next == null) return null;
    if (part === String(path).split(".").at(-1)) return { fn: next, receiver: owner };
    owner = next;
  }
  return null;
}

function resolveMethod(api, method) {
  const rawApi = getFcaApi(api);
  if (!rawApi) return null;

  const existing = resolvePath(rawApi, method);
  if (typeof existing?.fn === "function") return { ...existing, rawApi, method };

  const mappedName = METHOD_MAP[method];
  if (mappedName && typeof rawApi[mappedName] === "function") {
    return { fn: rawApi[mappedName], receiver: rawApi, rawApi, method };
  }
  return null;
}

function normalizeArgs(method, args) {
  if (method === "threads.setAdmin") {
    const [threadID, userID, isAdmin, ...rest] = args;
    return [String(threadID), String(userID), Boolean(isAdmin), ...rest];
  }
  return args;
}

export function hasFcaMethod(api, method) {
  return typeof resolveMethod(api, method)?.fn === "function";
}

function invokeWithCallback(fn, receiver, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    try {
      const returned = fn.call(receiver, ...args, finish);
      if (returned && typeof returned.then === "function") {
        returned.then((value) => finish(null, value), finish);
      } else if (returned !== undefined && fn.length <= args.length) {
        finish(null, returned);
      }
    } catch (error) {
      finish(error);
    }
  });
}

export async function callFcaApi(api, method, ...args) {
  const resolved = resolveMethod(api, method);
  if (!resolved) throw new Error(`al-fca API is unavailable: ${method}`);
  return invokeWithCallback(resolved.fn, resolved.receiver, normalizeArgs(method, args));
}

export const $plugin = {
  name: "xx-core-fca-api",
  meta: { category: "core", path: "utils/core/fcaApi.js" },
  setup(_ctx) {},
};
