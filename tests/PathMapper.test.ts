import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { PathMapper } from '../src/PathMapper';
import type { MountPoint } from '../src/types';

function mount(virtualPath: string, realPath: string): MountPoint {
	return { id: '1', virtualPath, realPath, enabled: true, readOnly: false };
}

describe('PathMapper', () => {
	let mapper: PathMapper;

	beforeEach(() => {
		mapper = new PathMapper();
	});

	describe('getMountForPath', () => {
		it('returns undefined when no mounts are loaded', () => {
			expect(mapper.getMountForPath('foo/bar')).toBeUndefined();
		});

		it('returns the mount for an exact match', () => {
			const m = mount('Projects/Work', '/real/Work');
			mapper.update([m]);
			expect(mapper.getMountForPath('Projects/Work')).toBe(m);
		});

		it('returns the mount for a child path', () => {
			const m = mount('Projects/Work', '/real/Work');
			mapper.update([m]);
			expect(mapper.getMountForPath('Projects/Work/notes.md')).toBe(m);
		});

		it('returns undefined for a path outside all mounts', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			expect(mapper.getMountForPath('Documents')).toBeUndefined();
		});

		it('returns the most-specific mount when mounts overlap in specificity', () => {
			const outer = mount('Projects', '/outer');
			const inner = mount('Projects/Work', '/inner');
			mapper.update([outer, inner]);
			expect(mapper.getMountForPath('Projects/Work/file.md')).toBe(inner);
		});

		it('only considers enabled mounts', () => {
			const disabled: MountPoint = { id: '2', virtualPath: 'Disabled', realPath: '/d', enabled: false, readOnly: false };
			mapper.update([disabled]);
			expect(mapper.getMountForPath('Disabled')).toBeUndefined();
		});
	});

	describe('toRealPath', () => {
		it.each([
			{ realPath: '/new-primary' },
			{ fallbackRealPath: undefined },
			{ fallbackRealPath: '/new-fallback' },
			{ deviceOverrides: { desktop: '/override' } },
			{ mountType: 'sftp' as const },
		])('invalidates a same-ID resolution after root changes: %j', changes => {
			const original = { ...mount('Work', '/primary'), fallbackRealPath: '/fallback' };
			mapper.update([original], 'desktop');
			mapper.setResolvedPath(original.id, '/fallback');
			const updated = { ...original, ...changes };
			mapper.update([updated], 'desktop');
			expect(mapper.getEffectiveRealPath(updated)).toBe(updated.deviceOverrides?.desktop ?? updated.realPath);
		});

		it('preserves a resolved root across unrelated settings changes', () => {
			const original = { ...mount('Work', '/primary'), fallbackRealPath: '/fallback' };
			mapper.update([original], 'desktop');
			mapper.setResolvedPath(original.id, '/fallback');
			const updated = { ...original, readOnly: true };
			mapper.update([updated], 'desktop');
			expect(mapper.getEffectiveRealPath(updated)).toBe('/fallback');
		});

		it('invalidates a resolved root when the current device changes', () => {
			const original = { ...mount('Work', '/primary'), fallbackRealPath: '/fallback' };
			mapper.update([original], 'desktop');
			mapper.setResolvedPath(original.id, '/fallback');
			mapper.update([original], 'laptop');
			expect(mapper.getEffectiveRealPath(original)).toBe('/primary');
		});

		it('returns realPath for the mount root', () => {
			const m = mount('Projects/Work', '/real/Work');
			expect(mapper.toRealPath('Projects/Work', m)).toBe('/real/Work');
		});

		it('joins relative segments correctly for a child path', () => {
			const m = mount('Projects/Work', '/real/Work');
			const result = mapper.toRealPath('Projects/Work/notes/todo.md', m);
			expect(result).toBe(path.join('/real/Work', 'notes', 'todo.md'));
		});
	});

	describe('toVirtualPath', () => {
		it('returns the virtual mount path for the real mount root', () => {
			const m = mount('Projects/Work', '/real/Work');
			expect(mapper.toVirtualPath('/real/Work', m)).toBe('Projects/Work');
		});

		it('converts a child real path to a virtual path', () => {
			const m = mount('Projects/Work', '/real/Work');
			const result = mapper.toVirtualPath(path.join('/real/Work', 'notes', 'todo.md'), m);
			expect(result).toBe('Projects/Work/notes/todo.md');
		});
	});

	describe('getVirtualMountsDirectChildren', () => {
		it('returns top-level mounts at the vault root', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.getVirtualMountsDirectChildren('')).toContain('Work');
		});

		it('returns the first path component for a nested mount at the vault root', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			const children = mapper.getVirtualMountsDirectChildren('');
			expect(children).toContain('Projects');
			expect(children).not.toContain('Projects/Work');
		});

		it('returns the full mount path when listing an intermediate directory', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			const children = mapper.getVirtualMountsDirectChildren('Projects');
			expect(children).toContain('Projects/Work');
		});

		it('deduplicates intermediate folders for multiple nested mounts', () => {
			mapper.update([
				mount('Projects/Work', '/real/Work'),
				mount('Projects/Personal', '/real/Personal'),
			]);
			const children = mapper.getVirtualMountsDirectChildren('');
			const projectsCount = children.filter(c => c === 'Projects').length;
			expect(projectsCount).toBe(1);
		});

		it('returns direct children only, not deeply nested paths', () => {
			mapper.update([mount('A/B/C', '/real/C')]);
			const root = mapper.getVirtualMountsDirectChildren('');
			expect(root).toContain('A');
			expect(root).not.toContain('A/B');

			const levelA = mapper.getVirtualMountsDirectChildren('A');
			expect(levelA).toContain('A/B');
			expect(levelA).not.toContain('A/B/C');
		});
	});

	describe('hasMountsUnder', () => {
		it('returns false when no mounts loaded', () => {
			expect(mapper.hasMountsUnder('Projects')).toBe(false);
		});

		it('returns true for a path that has a mount under it', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			expect(mapper.hasMountsUnder('Projects')).toBe(true);
		});

		it('returns false for a sibling path', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			expect(mapper.hasMountsUnder('Documents')).toBe(false);
		});

		it('returns true for the vault root when any mount exists', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.hasMountsUnder('')).toBe(true);
		});
	});

	describe('isInsideMount', () => {
		it('returns false when path is outside all mounts', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.isInsideMount('Documents')).toBe(false);
		});

		it('returns true for the mount root itself', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.isInsideMount('Work')).toBe(true);
		});

		it('returns true for a path inside a mount', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.isInsideMount('Work/notes.md')).toBe(true);
		});
	});
});
