// The password rule (docs/31), shared by the server (lib/server/accounts.mjs) and the sign-up and
// new-password forms: at least 8 characters, with both letters and numbers.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const PASSWORD_HINT = 'At least 8 characters, with both letters and numbers.';

/** Why `password` is not acceptable, or null when it is. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN)
    return 'Use at least 8 characters.';
  if (password.length > PASSWORD_MAX) return 'Use at most 128 characters.';
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) return 'Use both letters and numbers.';
  return null;
}
