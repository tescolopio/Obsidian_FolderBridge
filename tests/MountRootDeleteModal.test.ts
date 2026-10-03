import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { MountRootDeleteModal } from '../src/ui/MountRootDeleteModal';

class Element {
    children: Element[] = [];
    text = '';
    onclick?: () => void;
    empty() { this.children = []; }
    createEl(_tag: string, options: { text?: string } = {}) {
        const child = new Element();
        child.text = options.text ?? '';
        this.children.push(child);
        return child;
    }
    createDiv() { return this.createEl('div'); }
}

vi.mock('obsidian', async importOriginal => ({
    ...await importOriginal<typeof import('obsidian')>(),
    Setting: class {
        setName() { return this; }
        setDesc() { return this; }
        addToggle() { return this; }
    },
}));

describe('mount-root deletion copy', () => {
    it.each([false, true])('describes the requested deletion mode (trash=%s)', trash => {
        const resolve = vi.fn();
        const modal = new MountRootDeleteModal({} as App, 'Mounted', resolve, trash);
        const contentEl = new Element();
        Object.assign(modal, { contentEl, close: vi.fn() });

        modal.onOpen();

        const explanation = contentEl.children[2].text;
        expect(explanation).toContain(trash ? 'move the real folder to trash' : 'permanently delete');
        if (trash) expect(explanation).not.toContain('permanently delete');
        const buttons = contentEl.children[3].children;
        const deleteButton = buttons.find(button => button.text === (trash ? 'Move real folder to trash' : 'Delete real folder'));
        expect(deleteButton).toBeDefined();
        deleteButton!.onclick!();
        expect(resolve).toHaveBeenCalledExactlyOnceWith('delete');
    });
});
