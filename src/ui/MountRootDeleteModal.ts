import { App, Modal, Setting } from 'obsidian';
import { logger } from '../logger';

export class MountRootDeleteModal extends Modal {
    private resolve: (value: 'unmount' | 'delete' | 'unmount-always' | 'delete-always' | 'cancel') => void | Promise<void>;
    private dontAskAgain = false;
    private resolved = false;

    constructor(app: App, private mountPath: string, resolve: (value: 'unmount' | 'delete' | 'unmount-always' | 'delete-always' | 'cancel') => void | Promise<void>, private trash = false) {
        super(app);
        this.resolve = resolve;
    }

    private settle(value: 'unmount' | 'delete' | 'unmount-always' | 'delete-always' | 'cancel'): void {
        void Promise.resolve(this.resolve(value)).catch(error => {
            logger.error('Folder Bridge: Mount root delete callback failed', error);
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Remove mounted folder' });

        contentEl.createEl('p', {
            text: `You are about to remove the mounted folder root "${this.mountPath}".`
        });

        contentEl.createEl('p', {
            text: this.trash
                ? 'Do you want to move the real folder to trash, or just unmount it from Obsidian? Remote mounts do not support recoverable trash.'
                : 'Do you want to permanently delete the real folder on disk, or just unmount it from Obsidian?'
        });

        new Setting(contentEl)
            .setName("Don't ask again")
            .setDesc('Save this choice in settings')
            .addToggle(toggle => toggle
                .setValue(this.dontAskAgain)
                .onChange(value => {
                    this.dontAskAgain = value;
                })
            );
        const buttonContainer = contentEl.createDiv({ cls: 'folderbridge-modal-buttons' });

        const btnCancel = buttonContainer.createEl('button', { text: 'Cancel' });
        btnCancel.onclick = () => {
            if (!this.resolved) {
                this.resolved = true;
                this.settle('cancel');
                this.close();
            }
        };

        const btnUnmount = buttonContainer.createEl('button', { text: 'Unmount only' });
        btnUnmount.onclick = () => {
            if (!this.resolved) {
                this.resolved = true;
                this.settle(this.dontAskAgain ? 'unmount-always' : 'unmount');
                this.close();
            }
        };

        const btnDelete = buttonContainer.createEl('button', {
            text: this.trash ? 'Move real folder to trash' : 'Delete real folder',
            cls: 'mod-warning',
        });
        btnDelete.onclick = () => {
            if (!this.resolved) {
                this.resolved = true;
                this.settle(this.dontAskAgain ? 'delete-always' : 'delete');
                this.close();
            }
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (!this.resolved) {
            this.resolved = true;
            this.settle('cancel');
        }
    }
}
