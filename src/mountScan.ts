import { normalizePath } from 'obsidian';
import { isVisibleFileInMount } from './mountFileFilter';
import { MountPoint } from './types';

type VaultStat = { type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null;

export interface MountScanDependencies {
    list(folderPath: string): Promise<{ files: string[]; folders: string[] }>;
    stat(path: string): Promise<VaultStat>;
    hasAbstractFile(path: string): boolean;
    isIgnored(name: string, mount: MountPoint, mountRelativePath?: string): boolean;
    onFolderCreated(path: string): Promise<void>;
    onFileCreated(path: string, stat: VaultStat): Promise<void>;
    onHugeMount?(): void;
    onError?(folderPath: string, error: unknown): void;
    yieldToEventLoop?(this: void): Promise<void>;
}

export interface MountScanResult {
    fileCount: number;
    folderCount: number;
    scanLimitHit: boolean;
    isHuge: boolean;
}

function defaultYieldToEventLoop(this: void): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export async function replayMountContentsToVault(
    mount: MountPoint,
    deps: MountScanDependencies,
): Promise<MountScanResult> {
    if (mount.watcherSuppressAllEvents) {
        return { fileCount: 0, folderCount: 0, scanLimitHit: false, isHuge: false };
    }

    let fileCount = 0;
    let folderCount = 0;
    let isHuge = false;
    const scanLimit = mount.maxFiles ?? 0;
    let scanLimitHit = false;
    const yieldToEventLoop = deps.yieldToEventLoop ?? defaultYieldToEventLoop;
    const mountVirtualPath = normalizePath(mount.virtualPath);

    const maybeMarkHuge = () => {
        if (folderCount + fileCount > 1000 && !isHuge) {
            isHuge = true;
            deps.onHugeMount?.();
        }
    };

    const recursivelyNotifyVault = async (folderPath: string): Promise<void> => {
        if (scanLimitHit) return;

        try {
            const list = await deps.list(folderPath);
            await yieldToEventLoop();

            for (const folder of list.folders) {
                if (scanLimitHit) return;

                const folderName = folder.split('/').pop() || '';
                const folderMountRelPath = folder.startsWith(mountVirtualPath + '/')
                    ? folder.slice(mountVirtualPath.length + 1)
                    : undefined;

                if (deps.isIgnored(folderName, mount, folderMountRelPath)) continue;

                if (!deps.hasAbstractFile(folder)) {
                    await deps.onFolderCreated(folder);
                    folderCount++;
                    if (scanLimit > 0 && fileCount + folderCount >= scanLimit) {
                        scanLimitHit = true;
                        return;
                    }
                }

                maybeMarkHuge();
                await recursivelyNotifyVault(folder);
            }

            const metadataConcurrency = !mount.mountType || mount.mountType === 'local' || mount.mountType === 'vault' ? 8 : 1;
            let fileIndex = 0;
            while (fileIndex < list.files.length && !scanLimitHit) {
                const batch: string[] = [];
                const remaining = scanLimit > 0 ? scanLimit - fileCount - folderCount : metadataConcurrency;
                const batchSize = Math.min(metadataConcurrency, remaining);
                while (fileIndex < list.files.length && batch.length < batchSize) {
                    if (fileIndex > 0 && fileIndex % 100 === 0) {
                        await yieldToEventLoop();
                    }
                    const file = list.files[fileIndex++];
                    const fileName = file.split('/').pop() || '';
                    const fileMountRelPath = file.startsWith(mountVirtualPath + '/')
                        ? file.slice(mountVirtualPath.length + 1)
                        : undefined;

                    if (deps.isIgnored(fileName, mount, fileMountRelPath)) continue;
                    if (!isVisibleFileInMount(file, mount)) continue;
                    if (!deps.hasAbstractFile(file)) batch.push(file);
                }

                const stats = await Promise.allSettled(batch.map(async file => deps.stat(file)));
                for (const [batchIndex, file] of batch.entries()) {
                    const result = stats[batchIndex];
                    if (result.status === 'rejected') throw result.reason;
                    if (deps.hasAbstractFile(file)) continue;
                    await deps.onFileCreated(file, result.value);
                    fileCount++;
                    if (scanLimit > 0 && fileCount + folderCount >= scanLimit) {
                        scanLimitHit = true;
                        break;
                    }
                }
            }
        } catch (error) {
            deps.onError?.(folderPath, error);
        }
    };

    await recursivelyNotifyVault(mountVirtualPath);

    return { fileCount, folderCount, scanLimitHit, isHuge };
}
