import { normalizePath } from 'obsidian';
import type { MountPoint, TocFileConfig, TocFileMount } from './types';

export interface ParsedTocConfig {
    mounts: MountPoint[];
    warnings: string[];
}

function hashString(input: string): string {
    let hash = 0;
    for (let index = 0; index < input.length; index++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function buildTocMountId(sourcePath: string, mount: TocFileMount, index: number): string {
    return `toc-${hashString(`${sourcePath}::${mount.virtualPath}::${mount.realPath}::${index}`)}`;
}

function normalizeIgnoreList(mount: TocFileMount): string[] | undefined {
    const source = Array.isArray(mount.ignoreList)
        ? mount.ignoreList
        : Array.isArray(mount.ignore)
            ? mount.ignore
            : undefined;
    if (!source) return undefined;
    const normalized = source
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
}

function normalizeVirtualPath(input: string): string {
    return normalizePath(input.trim())
        .split('/')
        .filter(Boolean)
        .join('/');
}

function cleanObject<T extends object>(value: T): T {
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
    ) as T;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function serializeMountToTocEntry(mount: MountPoint): TocFileMount {
    const mountType: TocFileMount['mountType'] = mount.mountType === 'vault' ? 'vault' : 'local';
    const entry: TocFileMount = {
        id: mount.id,
        deviceId: mount.deviceId,
        virtualPath: normalizeVirtualPath(mount.virtualPath),
        realPath: mount.realPath,
        fallbackRealPath: mount.fallbackRealPath,
        label: mount.label,
        enabled: mount.enabled,
        readOnly: mount.readOnly,
        mountType,
        ignoreList: mount.ignoreList,
        visibleFileFilter: mount.visibleFileFilter,
        watcherDebounceMs: mount.watcherDebounceMs,
        watcherUsePolling: mount.watcherUsePolling,
        watcherPollingIntervalMs: mount.watcherPollingIntervalMs,
        watcherCreateFilter: mount.watcherCreateFilter,
        watcherSuppressAllEvents: mount.watcherSuppressAllEvents,
        maxFiles: mount.maxFiles,
        deviceOverrides: mount.deviceOverrides,
    };
    return cleanObject(entry);
}

export function serializeTocConfig(mounts: MountPoint[]): string {
    return JSON.stringify({
        version: 1,
        mounts: mounts.map(serializeMountToTocEntry),
    }, null, '\t');
}

export function parseTocConfig(text: string, sourcePath: string, deviceId: string): ParsedTocConfig {
    const warnings: string[] = [];
    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            mounts: [],
            warnings: [`${sourcePath}: failed to parse JSON (${message}).`],
        };
    }

    if (!parsed || typeof parsed !== 'object') {
        return {
            mounts: [],
            warnings: [`${sourcePath}: config must be a JSON object.`],
        };
    }

    const config = parsed as TocFileConfig;
    if (!Array.isArray(config.mounts)) {
        return {
            mounts: [],
            warnings: [`${sourcePath}: config must include a "mounts" array.`],
        };
    }

    const mounts: MountPoint[] = [];
    for (const [index, rawMount] of config.mounts.entries()) {
        if (!isObjectRecord(rawMount)) {
            warnings.push(`${sourcePath}: mounts[${index}] must be an object.`);
            continue;
        }

        const mount = rawMount;
        if (typeof mount.virtualPath !== 'string' || typeof mount.realPath !== 'string') {
            warnings.push(`${sourcePath}: mounts[${index}] must include string "virtualPath" and "realPath" values.`);
            continue;
        }

        const mountType = mount.mountType ?? 'local';
        if (mountType !== 'local' && mountType !== 'vault') {
            warnings.push(`${sourcePath}: mounts[${index}] uses unsupported mountType "${String(mount.mountType)}". Only "local" and "vault" are allowed in TOC files.`);
            continue;
        }

        const virtualPath = normalizeVirtualPath(mount.virtualPath);
        const realPath = mount.realPath.trim();
        if (!virtualPath || !realPath) {
            warnings.push(`${sourcePath}: mounts[${index}] cannot use empty paths.`);
            continue;
        }

        mounts.push({
            id: typeof mount.id === 'string' && mount.id.trim()
                ? mount.id.trim()
                : buildTocMountId(sourcePath, mount, index),
            virtualPath,
            realPath,
            fallbackRealPath: typeof mount.fallbackRealPath === 'string' && mount.fallbackRealPath.trim()
                ? mount.fallbackRealPath.trim()
                : undefined,
            enabled: mount.enabled ?? true,
            readOnly: mount.readOnly ?? false,
            label: typeof mount.label === 'string' && mount.label.trim() ? mount.label.trim() : undefined,
            deviceId: typeof mount.deviceId === 'string' && mount.deviceId.trim() ? mount.deviceId.trim() : deviceId,
            deviceOverrides: mount.deviceOverrides,
            ignoreList: normalizeIgnoreList(mount),
            visibleFileFilter: mount.visibleFileFilter,
            watcherDebounceMs: mount.watcherDebounceMs,
            watcherUsePolling: mount.watcherUsePolling,
            watcherPollingIntervalMs: mount.watcherPollingIntervalMs,
            watcherCreateFilter: mount.watcherCreateFilter,
            watcherSuppressAllEvents: mount.watcherSuppressAllEvents,
            maxFiles: mount.maxFiles,
            mountType,
            tocSourcePath: sourcePath,
        });
    }

    return { mounts, warnings };
}
