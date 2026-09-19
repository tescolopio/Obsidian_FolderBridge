import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';
import { MountManagerModal } from '../src/ui/MountManagerModal';
import { SecurityManager } from '../src/SecurityManager';
import { checkPathAccessible, isDirectory } from '../src/OSHelpers';
import { MountPoint } from '../src/types';

vi.mock('../src/OSHelpers', async importOriginal => ({
    ...await importOriginal<typeof import('../src/OSHelpers')>(),
    isDirectory: vi.fn(),
    checkPathAccessible: vi.fn(),
}));

function createModal(editMount?: MountPoint) {
    const save = vi.fn().mockResolvedValue(undefined);
    const modal = new MountManagerModal({} as App, 'Folder Bridge', new SecurityManager([]), save, editMount);
    Object.assign(modal, {
        virtualPath: 'docs', realPath: '/primary', fallbackRealPath: '/fallback', close: vi.fn(),
    });
    return { modal: modal as unknown as { handleSave(): Promise<void> }, save };
}

describe('local mount submission', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(isDirectory).mockImplementation(candidate => Promise.resolve(candidate === '/fallback'));
        vi.mocked(checkPathAccessible).mockResolvedValue({ accessible: true, readOnly: false });
    });

    it('saves an unavailable primary with a usable fallback', async () => {
        const { modal, save } = createModal();
        await modal.handleSave();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ realPath: '/primary', fallbackRealPath: '/fallback' }), undefined);
        expect(checkPathAccessible).toHaveBeenCalledWith('/fallback');
    });

    it('rejects when neither candidate is a directory', async () => {
        vi.mocked(isDirectory).mockResolvedValue(false);
        const { modal, save } = createModal();
        await modal.handleSave();
        expect(save).not.toHaveBeenCalled();
    });

    it('tries fallback when the primary directory is unreadable', async () => {
        vi.mocked(isDirectory).mockResolvedValue(true);
        vi.mocked(checkPathAccessible).mockImplementation(candidate => Promise.resolve({ accessible: candidate === '/fallback', readOnly: false }));
        const { modal, save } = createModal();
        await modal.handleSave();
        expect(save).toHaveBeenCalledOnce();
    });

    it('rejects an unreadable fallback', async () => {
        vi.mocked(checkPathAccessible).mockResolvedValue({ accessible: false, readOnly: false });
        const { modal, save } = createModal();
        await modal.handleSave();
        expect(save).not.toHaveBeenCalled();
    });

    it('revalidates when only fallback changes', async () => {
        vi.mocked(isDirectory).mockResolvedValue(false);
        const { modal, save } = createModal({ id: 'docs', virtualPath: 'docs', realPath: '/primary', fallbackRealPath: '/old', enabled: true, readOnly: false });
        await modal.handleSave();
        expect(save).not.toHaveBeenCalled();
        expect(isDirectory).toHaveBeenCalledWith('/fallback');
    });
});
