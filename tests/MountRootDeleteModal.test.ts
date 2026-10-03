import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { MountRootDeleteModal } from '../src/ui/MountRootDeleteModal';

type Toggle = {
    setValue(value: boolean): Toggle;
    onChange(callback: (value: boolean) => void): Toggle;
};

const toggleState = vi.hoisted(() => ({ setDontAskAgain: (_value: boolean) => {} }));

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
        addToggle(callback: (toggle: Toggle) => void) {
            callback({
                setValue() { return this; },
                onChange(handler) { toggleState.setDontAskAgain = handler; return this; },
            });
            return this;
        }
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

    it.each([false, true])('omits remote trash and permits only unmount when remembering=%s', remember => {
        const resolve = vi.fn();
        const modal = new MountRootDeleteModal({} as App, 'Remote', resolve, true, false);
        const contentEl = new Element();
        Object.assign(modal, { contentEl, close: vi.fn() });
        modal.onOpen();
        toggleState.setDontAskAgain(remember);

        expect(contentEl.children[2].text).toContain('Recoverable trash is unavailable');
        const buttons = contentEl.children[3].children;
        expect(buttons.map(button => button.text)).toEqual(['Cancel', 'Unmount only']);
        buttons.find(button => button.text === 'Unmount only')!.onclick!();
        expect(resolve).toHaveBeenCalledExactlyOnceWith(remember ? 'unmount-always' : 'unmount');
    });

    it('cancels remote trash without returning a remembered deletion choice', () => {
        const resolve = vi.fn();
        const modal = new MountRootDeleteModal({} as App, 'Remote', resolve, true, false);
        const contentEl = new Element();
        Object.assign(modal, { contentEl, close: vi.fn() });
        modal.onOpen();
        toggleState.setDontAskAgain(true);

        contentEl.children[3].children.find(button => button.text === 'Cancel')!.onclick!();
        expect(resolve).toHaveBeenCalledExactlyOnceWith('cancel');
    });

    it.each([false, true])('keeps explicit remote permanent deletion available when remembering=%s', remember => {
        const resolve = vi.fn();
        const modal = new MountRootDeleteModal({} as App, 'Remote', resolve, false, false);
        const contentEl = new Element();
        Object.assign(modal, { contentEl, close: vi.fn() });
        modal.onOpen();
        toggleState.setDontAskAgain(remember);

        expect(contentEl.children[2].text).toContain('permanently delete');
        contentEl.children[3].children.find(button => button.text === 'Delete real folder')!.onclick!();
        expect(resolve).toHaveBeenCalledExactlyOnceWith(remember ? 'delete-always' : 'delete');
    });
});
