import { signupAllowed } from './signups';

describe('signupAllowed', () => {
  it('lets anyone in when sign-ups are open', () => {
    expect(signupAllowed('open', false, false)).toBe(true);
    expect(signupAllowed('open', true, false)).toBe(true);
  });

  it('lets only invited addresses in when sign-ups need an invitation', () => {
    expect(signupAllowed('invite', false, false)).toBe(false);
    expect(signupAllowed('invite', false, true)).toBe(true);
  });

  it('lets nobody in when sign-ups are closed', () => {
    expect(signupAllowed('closed', false, false)).toBe(false);
    expect(signupAllowed('closed', false, true)).toBe(false);
  });

  it('always lets the very first account in so a new server can be set up', () => {
    expect(signupAllowed('invite', true, false)).toBe(true);
    expect(signupAllowed('closed', true, false)).toBe(true);
  });
});
