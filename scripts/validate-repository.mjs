import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_NAME = 'hh-apply-assistant.user.js';
const SOURCE_PATH = path.join(ROOT, SOURCE_NAME);
const REPOSITORY_URL = 'https://github.com/tgeruzov/hh-auto-responder';
const RAW_URL = 'https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js';
const DEVELOPMENT_REPOSITORY_NAME = 'hh-auto-responder' + '-dev';
const errors = [];

function report(message) {
    errors.push(message);
}

async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === '.git') continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walk(absolute));
        else files.push(absolute);
    }
    return files;
}

function relative(file) {
    return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function metadataValues(block, key) {
    const pattern = new RegExp(`^//\\s+@${key}\\s+(.+)$`, 'gm');
    return [...block.matchAll(pattern)].map(match => match[1].trim());
}

function normalizeVersion(value) {
    return String(value || '').replace(/^v/, '');
}

function slugifyHeading(value, counts) {
    const plain = value
        .replace(/<[^>]*>/g, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[`*_~]/g, '')
        .trim()
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
    const count = counts.get(plain) || 0;
    counts.set(plain, count + 1);
    return count ? `${plain}-${count}` : plain;
}

function collectHeadings(markdown) {
    const counts = new Map();
    const headings = new Set();
    const levels = [];
    for (const match of markdown.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
        levels.push({ level: match[1].length, title: match[2] });
        headings.add(slugifyHeading(match[2], counts));
    }
    return { headings, levels };
}

function extractMarkdownTargets(markdown) {
    const targets = [];
    const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of markdown.matchAll(pattern)) {
        let target = match[1].trim();
        if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
        const titled = target.match(/^(\S+)\s+["'][^"']*["']$/);
        if (titled) target = titled[1];
        targets.push(target);
    }
    return targets;
}

async function validateMetadata(source) {
    const blockMatch = source.match(/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==/m);
    if (!blockMatch) {
        report(`${SOURCE_NAME}: metadata block not found at the beginning of the file`);
        return null;
    }
    const block = blockMatch[0];
    const single = (key) => {
        const values = metadataValues(block, key);
        if (values.length !== 1) report(`${SOURCE_NAME}: expected exactly one @${key}, found ${values.length}`);
        return values[0] || '';
    };

    const versionTag = single('version');
    const scriptName = single('name');
    if (scriptName !== `HH Apply Assistant ${versionTag}`) {
        report(`${SOURCE_NAME}: @name "${scriptName}" does not match @version ${versionTag}`);
    }
    const checks = new Map([
        ['namespace', 'http://tampermonkey.net/'],
        ['author', 'Timur Geruzov'],
        ['license', 'GPL-3.0-only'],
        ['homepageURL', REPOSITORY_URL],
        ['supportURL', `${REPOSITORY_URL}/issues`],
        ['updateURL', RAW_URL],
        ['downloadURL', RAW_URL],
        ['grant', 'none'],
        ['run-at', 'document-idle']
    ]);
    for (const [key, expected] of checks) {
        const actual = single(key);
        if (actual !== expected) report(`${SOURCE_NAME}: @${key} is "${actual}", expected "${expected}"`);
    }

    const expectedMatches = [
        '*://*.hh.ru/search/vacancy*',
        '*://*.hh.ru/vacancy/*',
        '*://*.hh.ru/applicant/vacancy_response*'
    ];
    const actualMatches = metadataValues(block, 'match');
    if (JSON.stringify(actualMatches) !== JSON.stringify(expectedMatches)) {
        report(`${SOURCE_NAME}: @match list differs from the documented supported paths`);
    }
    if (metadataValues(block, 'require').length || metadataValues(block, 'resource').length) {
        report(`${SOURCE_NAME}: external @require/@resource needs an explicit repository policy update`);
    }

    const runtimeVersion = source.match(/const VERSION = '([^']+)'/)?.[1] || '';
    const recordVersion = source.match(/runtimeRecord = \{[\s\S]*?version: '([^']+)'/)?.[1] || '';
    const normalized = normalizeVersion(versionTag);
    if (!/^\d+\.\d+\.\d+$/.test(normalized)) report(`${SOURCE_NAME}: @version is not SemVer-compatible: ${versionTag}`);
    if (runtimeVersion !== normalized) report(`${SOURCE_NAME}: VERSION ${runtimeVersion} does not match @version ${versionTag}`);
    if (recordVersion !== normalized) report(`${SOURCE_NAME}: runtimeRecord.version ${recordVersion} does not match @version ${versionTag}`);
    return normalized;
}

async function validateMarkdown(markdownFiles) {
    const headingCache = new Map();
    for (const file of markdownFiles) {
        const content = await readFile(file, 'utf8');
        const { headings, levels } = collectHeadings(content);
        headingCache.set(file, headings);

        for (let index = 1; index < levels.length; index++) {
            if (levels[index].level > levels[index - 1].level + 1) {
                report(`${relative(file)}: heading level jumps from H${levels[index - 1].level} to H${levels[index].level} at "${levels[index].title}"`);
            }
        }
        const fenceCount = (content.match(/^```/gm) || []).length;
        if (fenceCount % 2 !== 0) report(`${relative(file)}: unclosed fenced code block`);
    }

    for (const file of markdownFiles) {
        const content = await readFile(file, 'utf8');
        for (const target of extractMarkdownTargets(content)) {
            if (/^(?:https?:|mailto:)/i.test(target)) continue;
            const hashIndex = target.indexOf('#');
            const pathPartRaw = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
            const fragmentRaw = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';
            const pathPart = decodeURIComponent(pathPartRaw.split('?')[0]);
            const targetFile = pathPart ? path.resolve(path.dirname(file), pathPart) : file;
            if (!existsSync(targetFile)) {
                report(`${relative(file)}: missing local link target "${target}"`);
                continue;
            }
            if (!fragmentRaw) continue;
            const targetStat = await stat(targetFile);
            if (!targetStat.isFile() || path.extname(targetFile).toLowerCase() !== '.md') continue;
            let headings = headingCache.get(targetFile);
            if (!headings) {
                const targetContent = await readFile(targetFile, 'utf8');
                headings = collectHeadings(targetContent).headings;
                headingCache.set(targetFile, headings);
            }
            const fragment = decodeURIComponent(fragmentRaw).toLocaleLowerCase();
            if (!headings.has(fragment)) report(`${relative(file)}: missing Markdown anchor "${target}"`);
        }
    }
}

async function validateIssueForms() {
    for (const name of ['bug_report.yml', 'feature_request.yml']) {
        const file = path.join(ROOT, '.github', 'ISSUE_TEMPLATE', name);
        const content = await readFile(file, 'utf8');
        if (/\t/.test(content)) report(`.github/ISSUE_TEMPLATE/${name}: YAML contains tabs`);
        for (const field of ['name:', 'description:', 'title:', 'labels:', 'body:']) {
            if (!content.includes(field)) report(`.github/ISSUE_TEMPLATE/${name}: missing ${field}`);
        }
        if (!content.includes('validations:') || !content.includes('required: true')) {
            report(`.github/ISSUE_TEMPLATE/${name}: no required fields found`);
        }
    }

    const config = await readFile(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'utf8');
    if (!config.includes(`${REPOSITORY_URL}/security/policy`)) {
        report('.github/ISSUE_TEMPLATE/config.yml: security contact does not use the canonical repository');
    }
}

async function validateYaml(yamlFiles) {
    for (const file of yamlFiles) {
        const content = await readFile(file, 'utf8');
        if (content.charCodeAt(0) === 0xFEFF) report(`${relative(file)}: YAML starts with a BOM`);
        if (/\t/.test(content)) report(`${relative(file)}: YAML contains tabs`);
        for (const [index, line] of content.split(/\r?\n/).entries()) {
            if (!line.trim() || line.trimStart().startsWith('#')) continue;
            const indent = line.length - line.trimStart().length;
            if (indent % 2 !== 0) report(`${relative(file)}:${index + 1}: YAML indentation is not a multiple of two`);
        }
    }
}

function validateRequiredFiles() {
    const required = [
        SOURCE_NAME,
        'LICENSE',
        'README.md',
        'README.en.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'PRIVACY.md',
        'CODE_OF_CONDUCT.md',
        '.nvmrc',
        '.github/ISSUE_TEMPLATE/bug_report.yml',
        '.github/ISSUE_TEMPLATE/feature_request.yml',
        '.github/ISSUE_TEMPLATE/config.yml',
        '.github/pull_request_template.md',
        '.github/workflows/ci.yml',
        'docs/README.md',
        'docs/installation.md',
        'docs/usage.md',
        'docs/architecture.md',
        'docs/storage.md',
        'docs/lifecycle.md',
        'docs/diagnostics.md',
        'docs/development.md',
        'docs/troubleshooting.md',
        'docs/release-process.md',
        'docs/migration-plan.md',
        'docs/release-notes/v4.0.0.md'
    ];
    for (const name of required) {
        if (!existsSync(path.join(ROOT, name))) report(`${name}: required repository file is missing`);
    }
}

const allFiles = await walk(ROOT);
validateRequiredFiles();
if (!existsSync(SOURCE_PATH)) report(`${SOURCE_NAME}: production userscript is missing`);
const source = existsSync(SOURCE_PATH) ? await readFile(SOURCE_PATH, 'utf8') : '';
const version = source ? await validateMetadata(source) : null;

if (version) {
    const versionFiles = [
        ['README.md', `version-${version}`],
        ['README.en.md', `version-${version}`],
        ['CHANGELOG.md', `## [${version}]`],
        [`docs/release-notes/v${version}.md`, `# HH Apply Assistant v${version}`]
    ];
    for (const [name, marker] of versionFiles) {
        const file = path.join(ROOT, name);
        if (!existsSync(file)) {
            report(`${name}: required version file is missing`);
            continue;
        }
        const content = await readFile(file, 'utf8');
        if (!content.includes(marker)) report(`${name}: version marker "${marker}" does not match ${version}`);
    }
}

const markdownFiles = allFiles.filter(file => path.extname(file).toLowerCase() === '.md');
const yamlFiles = allFiles.filter(file => /\.ya?ml$/i.test(file));
await validateMarkdown(markdownFiles);
await validateYaml(yamlFiles);
await validateIssueForms();

for (const file of allFiles.filter(file => /(?:\.md|\.ya?ml|\.user\.js)$/i.test(file))) {
    const content = await readFile(file, 'utf8');
    if (content.includes(DEVELOPMENT_REPOSITORY_NAME)) {
        report(`${relative(file)}: public-facing content references the development repository name`);
    }
}

const readmeRu = await readFile(path.join(ROOT, 'README.md'), 'utf8');
const readmeEn = await readFile(path.join(ROOT, 'README.en.md'), 'utf8');
for (const marker of [
    SOURCE_NAME,
    RAW_URL,
    '@updateURL',
    '@downloadURL',
    '50',
    'CAPTCHA',
    'localStorage',
    'sessionStorage',
    'PRIVACY.md',
    'docs/installation.md',
    'docs/troubleshooting.md'
]) {
    if (!readmeRu.includes(marker)) report(`README.md: missing shared fact marker "${marker}"`);
    if (!readmeEn.includes(marker)) report(`README.en.md: missing shared fact marker "${marker}"`);
}

const legacySourceName = 'script' + '.js';
for (const file of allFiles.filter(file => /\.(?:md|mjs|html|ya?ml)$/.test(file))) {
    const content = await readFile(file, 'utf8');
    const name = relative(file);
    if (content.includes(legacySourceName) && name !== 'docs/migration-plan.md') {
        report(`${name}: references removed production path ${legacySourceName}`);
    }
}
const workflow = await readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
for (const command of [
    'actions/checkout@v7',
    'actions/setup-node@v7',
    'node-version: 24',
    'node --check hh-apply-assistant.user.js',
    'node --test',
    'node scripts/validate-repository.mjs'
]) {
    if (!workflow.includes(command)) report(`.github/workflows/ci.yml: missing command "${command}"`);
}

const nvmVersion = (await readFile(path.join(ROOT, '.nvmrc'), 'utf8')).trim();
if (nvmVersion !== '24') report(`.nvmrc: expected Node.js 24, found "${nvmVersion}"`);

const releaseProcess = await readFile(path.join(ROOT, 'docs', 'release-process.md'), 'utf8');
for (const marker of ['## Сейчас', '## Будущий production flow', REPOSITORY_URL, RAW_URL, 'tag `v4.0.0`']) {
    if (!releaseProcess.includes(marker)) report(`docs/release-process.md: missing release boundary marker "${marker}"`);
}

if (errors.length) {
    console.error(`Repository validation failed with ${errors.length} problem(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
} else {
    console.log(`Repository validation passed: ${markdownFiles.length} Markdown files, ${yamlFiles.length} YAML files, required files and userscript metadata checked.`);
}
