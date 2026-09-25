export function checkAuth(senderID, command, botIndex = null, isGroupAdmin = false) {
  const role    = global.getUserRole(senderID, botIndex);
  const reqRole = command.config?.role ?? 0;
  const effectiveRole = (isGroupAdmin && role < 1) ? 1 : role;
  return effectiveRole < reqRole;
}

/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-middlewares-auth',
  meta: { category: 'middleware', path: 'utils/middleware/auth.js' },
  setup(_ctx) {
    // provides: checkAuth
  },
};
