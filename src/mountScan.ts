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
    onProgress?(fileCount: number, folderCount: number): void;
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
                if (folderName.startsWith('.') || folderName === 'node_modules') continue;

                if (!deps.hasAbstractFile(folder)) {
                    await deps.onFolderCreated(folder);
                    folderCount++;
                    if ((fileCount + folderCount) % 50 === 0) deps.onProgress?.(fileCount, folderCount);
                    if (scanLimit > 0 && fileCount + folderCount >= scanLimit) {
                        scanLimitHit = true;
                        return;
                    }
                }

                maybeMarkHuge();
                await recursivelyNotifyVault(folder);
            }

            for (let i = 0; i < list.files.length; i++) {
                if (scanLimitHit) break;

                const file = list.files[i];
                if (i > 0 && i % 100 === 0) {
                    await yieldToEventLoop();
                }

                const fileName = file.split('/').pop() || '';
                const fileMountRelPath = file.startsWith(mountVirtualPath + '/')
                    ? file.slice(mountVirtualPath.length + 1)
                    : undefined;

                if (deps.isIgnored(fileName, mount, fileMountRelPath)) continue;
                if (fileName.startsWith('.')) continue;
                if (!isVisibleFileInMount(file, mount)) continue;

                if (!deps.hasAbstractFile(file)) {
                    const stat = await deps.stat(file);
                    await deps.onFileCreated(file, stat);
                    fileCount++;
                    if ((fileCount + folderCount) % 50 === 0) deps.onProgress?.(fileCount, folderCount);
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
