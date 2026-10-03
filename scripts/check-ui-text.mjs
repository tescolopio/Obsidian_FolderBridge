import fs from 'fs/promises';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanTargets = [
    path.join(repoRoot, 'main.ts'),
    path.join(repoRoot, 'src'),
];

const monitoredMethods = new Set([
    'setName',
    'setDesc',
    'setTooltip',
    'setButtonText',
    'setTitle',
    'setPlaceholder',
    'setText',
]);

const objectTextMethods = new Set(['createEl', 'createSpan']);
const decorativeStatusIcons = /[🔒🔓⏸▶⚠✓]/u;
const stopWords = new Set([
    'a',
    'an',
    'and',
    'as',
    'at',
    'by',
    'for',
    'from',
    'here',
    'in',
    'into',
    'my',
    'of',
    'on',
    'only',
    'or',
    'our',
    'the',
    'then',
    'this',
    'to',
    'via',
    'with',
    'without',
    'your',
]);
const acronymWords = new Set([
    'AWS',
    'B2',
    'DPAPI',
    'JSON',
    'PDF',
    'PR',
    'S3',
    'SFTP',
    'SSH',
    'TOC',
    'UI',
    'UNC',
    'URL',
    'WSL',
]);
const knownProperPhrases = [
    'Amazon S3',
    'Backblaze B2',
    'Cloudflare R2',
    'Folder Bridge',
    'GitHub',
    'Linux',
    'MinIO',
    'Nextcloud',
    'Obsidian',
    'Obsidian Desktop',
    'Obsidian Sync',
    'OneDrive Files On Demand',
    'OneDrive',
    'Quick Switcher',
    'QuickAdd',
    'Syncthing',
    'Synology',
    'WebDAV',
    'Windows',
    'Windows 10',
    'Windows 11',
    'Win 10',
    'WSL 2',
];

async function collectTypeScriptFiles(targetPath) {
    const stats = await fs.stat(targetPath);
    if (stats.isFile()) return [targetPath];

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const files = await Promise.all(entries.map(async entry => {
        const entryPath = path.join(targetPath, entry.name);
        if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
        return entry.name.endsWith('.ts') ? [entryPath] : [];
    }));

    return files.flat();
}

function getObjectTextExpression(argument) {
    if (!argument || !ts.isObjectLiteralExpression(argument)) return null;

    for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ?
            property.name.text :
            null;
        if (propertyName === 'text') return property.initializer;
    }

    return null;
}

function collectLiteralFragments(node) {
    if (!node) return [];
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
        return [
            node.head.text,
            ...node.templateSpans.flatMap(span => [
                ...collectLiteralFragments(span.expression),
                span.literal.text,
            ]),
        ];
    }
    if (ts.isConditionalExpression(node)) {
        return [
            ...collectLiteralFragments(node.whenTrue),
            ...collectLiteralFragments(node.whenFalse),
        ];
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return [
            ...collectLiteralFragments(node.left),
            ...collectLiteralFragments(node.right),
        ];
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        return collectLiteralFragments(node.expression);
    }

    return [];
}

function stripKnownPhrases(text) {
    let stripped = text;
    for (const phrase of knownProperPhrases) {
        stripped = stripped.replaceAll(phrase, phrase.toLowerCase());
    }
    return stripped;
}

function isLikelySentenceCaseViolation(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.includes('://')) return false;
    if (/^[A-Za-z]:\\/.test(trimmed) || trimmed.startsWith('/')) return false;

    const normalized = stripKnownPhrases(trimmed)
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/^[^A-Za-z]+/, '')
        .replace(/\([^)]*\)/g, ' ');

    const clauses = normalized
        .split(/[:.!?]\s+|\n+/)
        .map(clause => clause.trim())
        .filter(Boolean);

    for (const clause of clauses) {
        if (/^[A-Za-z0-9_./-]+$/.test(clause) && !clause.includes(' ')) continue;
        const words = clause.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
        if (words.length < 3) continue;

        let capitalizedAfterFirst = 0;
        for (let index = 1; index < words.length; index++) {
            const word = words[index];
            const lower = word.toLowerCase();
            if (stopWords.has(lower)) continue;
            if (acronymWords.has(word.toUpperCase())) continue;
            if (/^[A-Z][a-z]/.test(word)) capitalizedAfterFirst++;
        }

        if (capitalizedAfterFirst >= 2) return true;
    }

    return false;
}

function lintTextFragment(text) {
    const issues = [];
    const trimmed = text.trim();
    if (!trimmed) return issues;

    if (/Folder bridge\b/.test(trimmed)) {
        issues.push('Use "Folder Bridge" branding in UI text.');
    }

    if (decorativeStatusIcons.test(trimmed)) {
        issues.push('Use plain text status labels instead of decorative icons.');
    }

    if (isLikelySentenceCaseViolation(trimmed)) {
        issues.push('Use sentence case for reviewer-facing UI text.');
    }

    return issues;
}

function collectViolations(sourceFile) {
    const violations = [];

    function pushViolations(node, expression, context) {
        for (const text of collectLiteralFragments(expression)) {
            const issues = lintTextFragment(text);
            if (issues.length === 0) continue;
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push({
                text,
                context,
                issues,
                line: line + 1,
                column: character + 1,
            });
        }
    }

    function visit(node) {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Notice') {
            pushViolations(node, node.arguments?.[0], 'Notice');
        }

        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const methodName = node.expression.name.text;
            if (monitoredMethods.has(methodName)) {
                pushViolations(node, node.arguments[0], methodName);
            }

            if (methodName === 'addOption') {
                pushViolations(node, node.arguments[1], methodName);
            }

            if (objectTextMethods.has(methodName)) {
                pushViolations(node, getObjectTextExpression(node.arguments[1]), `${methodName}.text`);
            }

            if (methodName === 'addRibbonIcon') {
                pushViolations(node, node.arguments[1], methodName);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

const files = (await Promise.all(scanTargets.map(target => collectTypeScriptFiles(target)))).flat();
const violations = [];

for (const filePath of files) {
    const sourceText = await fs.readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
    const fileViolations = collectViolations(sourceFile).map(violation => ({
        ...violation,
        filePath: path.relative(repoRoot, filePath),
    }));
    violations.push(...fileViolations);
}

if (violations.length > 0) {
    console.error('UI copy check found violations:');
    for (const violation of violations) {
        console.error(`- ${violation.filePath}:${violation.line}:${violation.column} [${violation.context}] ${JSON.stringify(violation.text)} -> ${violation.issues.join(' ')}`);
    }
    process.exit(1);
}

console.log('UI copy check passed.');
