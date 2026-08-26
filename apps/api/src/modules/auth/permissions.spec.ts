import { describe, expect, it } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLES, hasAllPermissions, hasAnyPermission, hasPermission } from './permissions';

describe('permission evaluation', () => {
  it('grants an exactly matching permission', () => {
    expect(hasPermission(['ticket:read'], 'ticket:read')).toBe(true);
  });

  it('denies by default', () => {
    expect(hasPermission(['ticket:read'], 'ticket:delete')).toBe(false);
    expect(hasPermission([], 'ticket:read')).toBe(false);
  });

  it('treats resource:manage as every action on that resource', () => {
    expect(hasPermission(['ticket:manage'], 'ticket:delete')).toBe(true);
    // …but only on that resource.
    expect(hasPermission(['ticket:manage'], 'customer:delete')).toBe(false);
  });

  it('honours the system wildcard', () => {
    expect(hasPermission(['*'], 'governance:manage')).toBe(true);
  });

  it('distinguishes any from all', () => {
    const granted = ['ticket:read'];
    expect(hasAnyPermission(granted, ['ticket:read', 'ticket:delete'])).toBe(true);
    expect(hasAllPermissions(granted, ['ticket:read', 'ticket:delete'])).toBe(false);
  });
});

describe('system roles', () => {
  it('only reference permissions in the catalog', () => {
    const catalog = new Set<string>(PERMISSIONS);
    for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
      for (const permission of role.permissions) {
        expect(catalog.has(permission), `${key} references unknown permission ${permission}`).toBe(true);
      }
    }
  });

  it('gives the owner billing control that no other role has', () => {
    expect(SYSTEM_ROLES.owner.permissions).toContain('billing:manage');
    for (const key of ['administrator', 'supervisor', 'qa_manager', 'agent', 'ai_builder', 'analyst', 'viewer'] as const) {
      expect(SYSTEM_ROLES[key].permissions).not.toContain('billing:manage');
    }
  });

  it('keeps agents out of configuration and cross-team reads', () => {
    const agent = SYSTEM_ROLES.agent.permissions;
    expect(agent).not.toContain('organization:manage');
    expect(agent).not.toContain('user:manage');
    expect(agent).not.toContain('conversation:read_all');
    expect(agent).not.toContain('qc:read_all');
  });

  it('gives the viewer no write permission at all', () => {
    for (const permission of SYSTEM_ROLES.viewer.permissions) {
      expect(permission.endsWith(':read')).toBe(true);
    }
  });

  it('escalates strictly: agent ⊆ supervisor ⊆ administrator ⊆ owner', () => {
    const chain = ['agent', 'supervisor', 'administrator', 'owner'] as const;
    for (let i = 0; i < chain.length - 1; i += 1) {
      const lower = SYSTEM_ROLES[chain[i]].permissions;
      const higher = new Set(SYSTEM_ROLES[chain[i + 1]].permissions);
      for (const permission of lower) {
        expect(higher.has(permission), `${chain[i + 1]} is missing ${permission}`).toBe(true);
      }
    }
  });
});
