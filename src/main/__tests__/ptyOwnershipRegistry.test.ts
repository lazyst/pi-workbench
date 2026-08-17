import { describe, it, expect } from 'vitest';
import { PtyOwnershipRegistry } from '../ptyOwnershipRegistry';

describe('PtyOwnershipRegistry', () => {
  describe('1:1 owner mapping', () => {
    it('should set and get owner', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setOwner('live-111', 'live-111');
      expect(reg.getOwner('live-111')).toBe('live-111');
    });

    it('should return undefined for unknown PTY', () => {
      const reg = new PtyOwnershipRegistry();
      expect(reg.getOwner('live-unknown')).toBeUndefined();
    });

    it('should overwrite existing owner', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setOwner('live-111', 'live-111');
      reg.setOwner('live-111', 'live-222');
      expect(reg.getOwner('live-111')).toBe('live-222');
    });

    it('should delete owner', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setOwner('live-111', 'live-111');
      reg.deleteOwner('live-111');
      expect(reg.getOwner('live-111')).toBeUndefined();
    });
  });

  describe('1:N data routing', () => {
    it('should add and get routes', () => {
      const reg = new PtyOwnershipRegistry();
      reg.addRoute('live-111', 'pi-aaa');
      reg.addRoute('live-111', 'pi-bbb');
      const routes = reg.getRoutes('live-111');
      expect(routes).toBeDefined();
      expect([...routes!]).toEqual(expect.arrayContaining(['pi-aaa', 'pi-bbb']));
    });

    it('should return undefined for PTY with no routes', () => {
      const reg = new PtyOwnershipRegistry();
      expect(reg.getRoutes('live-111')).toBeUndefined();
    });

    it('should not duplicate routes', () => {
      const reg = new PtyOwnershipRegistry();
      reg.addRoute('live-111', 'pi-aaa');
      reg.addRoute('live-111', 'pi-aaa');
      const routes = reg.getRoutes('live-111');
      expect(routes).toBeDefined();
      expect(routes!.size).toBe(1);
    });

    it('should delete routes', () => {
      const reg = new PtyOwnershipRegistry();
      reg.addRoute('live-111', 'pi-aaa');
      reg.deleteRoutes('live-111');
      expect(reg.getRoutes('live-111')).toBeUndefined();
    });
  });

  describe('virtual session mapping', () => {
    it('should set and get virtual mapping', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setVirtual('pi-aaa', 'live-111');
      expect(reg.getVirtual('pi-aaa')).toBe('live-111');
    });

    it('should return undefined for unknown virtual key', () => {
      const reg = new PtyOwnershipRegistry();
      expect(reg.getVirtual('pi-unknown')).toBeUndefined();
    });

    it('should delete virtual mapping', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setVirtual('pi-aaa', 'live-111');
      reg.deleteVirtual('pi-aaa');
      expect(reg.getVirtual('pi-aaa')).toBeUndefined();
    });
  });

  describe('findPtyByOwnerKey', () => {
    it('should find PTY by owner key', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setOwner('live-111', 'some-owner-key');
      expect(reg.findPtyByOwnerKey('some-owner-key')).toBe('live-111');
    });

    it('should return undefined for unknown owner key', () => {
      const reg = new PtyOwnershipRegistry();
      expect(reg.findPtyByOwnerKey('unknown')).toBeUndefined();
    });
  });

  describe('virtualPtyIds', () => {
    it('should yield all virtual PTY IDs', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setVirtual('pi-aaa', 'live-111');
      reg.setVirtual('pi-bbb', 'live-222');
      const ids = [...reg.virtualPtyIds()];
      expect(ids).toEqual(expect.arrayContaining(['live-111', 'live-222']));
    });

    it('should yield empty when no virtual mappings', () => {
      const reg = new PtyOwnershipRegistry();
      expect([...reg.virtualPtyIds()]).toEqual([]);
    });
  });

  describe('remove', () => {
    it('should remove all records for a PTY', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setOwner('live-111', 'live-111');
      reg.addRoute('live-111', 'pi-aaa');
      reg.setVirtual('pi-aaa', 'live-111');

      const result = reg.remove('live-111');

      expect(result.routes).toEqual(['pi-aaa']);
      expect(result.virtualKeys).toEqual(['pi-aaa']);
      expect(reg.getOwner('live-111')).toBeUndefined();
      expect(reg.getRoutes('live-111')).toBeUndefined();
      expect(reg.getVirtual('pi-aaa')).toBeUndefined();
    });

    it('should handle PTY with no routes or virtual mappings', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setOwner('live-111', 'live-111');

      const result = reg.remove('live-111');

      expect(result.routes).toEqual([]);
      expect(result.virtualKeys).toEqual([]);
      expect(reg.getOwner('live-111')).toBeUndefined();
    });

    it('should not affect other PTY entries', () => {
      const reg = new PtyOwnershipRegistry();
      reg.setOwner('live-111', 'live-111');
      reg.setOwner('live-222', 'live-222');
      reg.addRoute('live-111', 'pi-aaa');
      reg.addRoute('live-222', 'pi-bbb');

      reg.remove('live-111');

      expect(reg.getOwner('live-222')).toBe('live-222');
      const routes = reg.getRoutes('live-222');
      expect(routes).toBeDefined();
      expect([...routes!]).toEqual(['pi-bbb']);
    });
  });
});