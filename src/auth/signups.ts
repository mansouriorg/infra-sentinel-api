export const SIGNUP_MODES = ['open', 'invite', 'closed'] as const;

export type SignupMode = (typeof SIGNUP_MODES)[number];

export const SIGNUPS_CLOSED_MESSAGE =
  'Sign-ups are closed on this server. Ask an administrator to invite you.';

export function signupAllowed(
  mode: SignupMode,
  firstAccount: boolean,
  invited: boolean,
): boolean {
  if (mode === 'open' || firstAccount) return true;
  return mode === 'invite' && invited;
}
