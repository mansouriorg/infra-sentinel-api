import { canAssign, canManage, hasRole } from './roles';

describe('roles', () => {
  it('orders roles by privilege', () => {
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('member', 'admin')).toBe(false);
    expect(hasRole('viewer', 'viewer')).toBe(true);
  });

  it('lets owners manage everyone', () => {
    expect(canManage('owner', 'owner')).toBe(true);
    expect(canAssign('owner', 'owner')).toBe(true);
  });

  it('keeps admins below the admin line', () => {
    expect(canManage('admin', 'member')).toBe(true);
    expect(canManage('admin', 'viewer')).toBe(true);
    expect(canManage('admin', 'admin')).toBe(false);
    expect(canManage('admin', 'owner')).toBe(false);
    expect(canAssign('admin', 'member')).toBe(true);
    expect(canAssign('admin', 'admin')).toBe(false);
  });

  it('gives members and viewers no management rights', () => {
    expect(canManage('member', 'viewer')).toBe(false);
    expect(canAssign('viewer', 'viewer')).toBe(false);
  });
});
