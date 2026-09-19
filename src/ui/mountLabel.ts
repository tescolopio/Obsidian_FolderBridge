export function shouldUseFolderNameAsLabel(realPath: string, label: string | undefined): boolean {
    const trimmedLabel = label?.trim() ?? '';
    if (!trimmedLabel || !realPath) return false;
    const folderName = realPath.replace(/^[a-z]:/i, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return folderName === trimmedLabel;
}
