import { App, Modal } from 'obsidian';

export class SFTPHostKeyModal extends Modal {
    private settled = false;

    constructor(app: App, private endpoint: string, private fingerprint: string, private resolve: (accepted: boolean) => void) {
        super(app);
    }

    private finish(accepted: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve(accepted);
        this.close();
    }

    onOpen(): void {
        this.contentEl.empty();
        this.contentEl.createEl('h2', { text: 'Verify SFTP server identity' });
        this.contentEl.createEl('p', { text: `Server: ${this.endpoint}` });
        this.contentEl.createEl('p', { text: `Host key: ${this.fingerprint}` });
        this.contentEl.createEl('p', {
            text: 'Compare this fingerprint with the server administrator over a trusted channel. Approval saves this key before authentication; an unverified first connection can reach an impersonated server.',
        });
        const buttons = this.contentEl.createDiv({ cls: 'folderbridge-modal-buttons' });
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.finish(false);
        const approve = buttons.createEl('button', { text: 'Trust verified key', cls: 'mod-warning' });
        approve.onclick = () => this.finish(true);
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.settled) {
            this.settled = true;
            this.resolve(false);
        }
    }
}
