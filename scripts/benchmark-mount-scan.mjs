import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('..',
    import.meta.url));
const baselineRef = process.argv[2] || 'HEAD';
const fileCount = 20000;
const folderCount = 100;
const repetitions = 5;
const baselineSource = execFileSync('git', ['show', `${baselineRef}:src/mountScan.ts`], {
    cwd: projectRoot,
    encoding: 'utf8',
});
const currentSource = await readFile(path.join(projectRoot, 'src/mountScan.ts'), 'utf8');

async function loadScanner(source) {
    const result = await build({
        stdin: { contents: source, loader: 'ts', resolveDir: path.join(projectRoot, 'src') },
        alias: { obsidian: path.join(projectRoot, 'tests/__mocks__/obsidian.ts') },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
    });
    const module = await
    import (`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    return module.replayMountContentsToVault;
}

const scanners = {
    baseline: await loadScanner(baselineSource),
    current: await loadScanner(currentSource),
};
const root = await mkdtemp(path.join(tmpdir(), 'folderbridge-scan-benchmark-'));
const mount = { id: 'benchmark', virtualPath: 'mount', realPath: root, enabled: true, readOnly: true };
const samples = { baseline: [], current: [] };

async function measure(scanner) {
    let metadataReads = 0;
    let activeReads = 0;
    let peakReads = 0;
    const notifications = [];
    const toRealPath = virtualPath => path.join(root, virtualPath.slice(mount.virtualPath.length));
    const started = performance.now();
    const result = await scanner(mount, {
        list: async folder => {
            const entries = await readdir(toRealPath(folder), { withFileTypes: true });
            entries.sort((left, right) => left.name.localeCompare(right.name));
            return {
                folders: entries.filter(entry => entry.isDirectory()).map(entry => `${folder}/${entry.name}`),
                files: entries.filter(entry => entry.isFile()).map(entry => `${folder}/${entry.name}`),
            };
        },
        stat: async file => {
            metadataReads++;
            activeReads++;
            peakReads = Math.max(peakReads, activeReads);
            try {
                const info = await stat(toRealPath(file));
                return { type: 'file', ctime: info.ctimeMs, mtime: info.mtimeMs, size: info.size };
            } finally {
                activeReads--;
            }
        },
        hasAbstractFile: () => false,
        isIgnored: () => false,
        onFolderCreated: async folder => { notifications.push(folder); },
        onFileCreated: async file => { notifications.push(file); },
        onError: (_folder, error) => { throw error; },
    });
    const elapsedMs = performance.now() - started;
    assert.equal(result.fileCount, fileCount);
    assert.equal(result.folderCount, folderCount);
    assert.equal(metadataReads, fileCount);
    assert.equal(result.scanLimitHit, false);
    return { elapsedMs, metadataReads, peakReads, notifications };
}

try {
    for (let folderIndex = 0; folderIndex < folderCount; folderIndex++) {
        const folder = path.join(root, `folder-${folderIndex}`);
        await mkdir(folder);
        for (let offset = 0; offset < fileCount / folderCount; offset += 20) {
            await Promise.all(Array.from({ length: 20 }, (_, index) =>
                writeFile(path.join(folder, `${offset + index}.jpg`), '')));
        }
    }

    let expectedNotifications;
    for (let iteration = 0; iteration < repetitions; iteration++) {
        const order = iteration % 2 === 0 ? ['baseline', 'current'] : ['current', 'baseline'];
        for (const name of order) {
            const { notifications, ...sample } = await measure(scanners[name]);
            if (expectedNotifications === undefined) expectedNotifications = notifications;
            assert.deepEqual(notifications, expectedNotifications);
            samples[name].push(sample);
        }
    }
    const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const baselineMs = median(samples.baseline.map(sample => sample.elapsedMs));
    const currentMs = median(samples.current.map(sample => sample.elapsedMs));
    console.log(JSON.stringify({
        baselineRef,
        fileCount,
        folderCount,
        repetitions,
        node: process.version,
        platform: process.platform,
        fixture: 'Zero-byte files on the temporary filesystem; OS cache not flushed; no-op vault notifications',
        samples,
        medianMs: { baseline: baselineMs, current: currentMs },
        reductionPercent: (1 - currentMs / baselineMs) * 100,
        speedup: baselineMs / currentMs,
    }, null, 2));
} finally {
    await rm(root, { recursive: true, force: true });
}