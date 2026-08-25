import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_NAME = 'hh-apply-assistant.user.js';
const SOURCE_PATH = path.join(ROOT, SOURCE_NAME);
const PRODUCT_NAME = 'HH Apply Assistant';
const EXPECTED_PRODUCT_VERSION = '4.0.0';
const EXPECTED_RUNTIME_KEY = '__hhApplyAssistantRuntime';
const EXPECTED_STORAGE_SCHEMA_VERSION = 1;
const EXPECTED_STORAGE_PREFIX = 'hh_apply_assistant_s1_';
const REPOSITORY_URL = 'https://github.com/tgeruzov/hh-apply-assistant';
const RAW_URL = 'https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js';
const DEVELOPMENT_REPOSITORY_NAME = 'hh-apply-assistant' + '-dev';
const ISSUE_FORM_NAMES = [
    'bug_report.yml',
    'bug_report_en.yml',
    'feature_request.yml',
    'feature_request_en.yml'
];
const errors = [];

function report(message) {
    errors.push(message);
}

async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (
            entry.name === '.git' ||
            entry.name === 'node_modules' ||
            entry.name === 'dist' ||
            entry.name === '.vite' ||
            entry.name === 'ui-reference' ||
            entry.name === 'coverage'
        ) continue;
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

async function validatePackageAndViteVersions() {
    const packageJsonPath = path.join(ROOT, 'package.json');
    if (!existsSync(packageJsonPath)) {
        report('package.json: missing file');
        return null;
    }
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const packageVersion = pkg.version;
    if (!packageVersion) {
        report('package.json: missing version field');
    } else if (packageVersion !== EXPECTED_PRODUCT_VERSION) {
        report(`package.json: version is "${packageVersion}", expected "${EXPECTED_PRODUCT_VERSION}"`);
    }

    const viteConfigPath = path.join(ROOT, 'vite.config.ts');
    if (existsSync(viteConfigPath)) {
        const viteConfig = await readFile(viteConfigPath, 'utf8');
        const match = viteConfig.match(/version:\s*['"]([^'"]+)['"]/);
        const viteVersion = match?.[1];
        if (!viteVersion) {
            report('vite.config.ts: missing userscript version in monkey configuration');
        } else if (viteVersion !== packageVersion) {
            report(`vite.config.ts: version "${viteVersion}" does not match package.json version "${packageVersion}"`);
        }
    }

    const runtimeSourcePath = path.join(ROOT, 'src', 'core', 'runtime.ts');
    if (existsSync(runtimeSourcePath)) {
        const runtimeSource = await readFile(runtimeSourcePath, 'utf8');
        const match = runtimeSource.match(/export\s+const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
        const runtimeVersion = match?.[1];
        if (!runtimeVersion) {
            report('src/core/runtime.ts: missing VERSION declaration');
        } else if (runtimeVersion !== packageVersion) {
            report(`src/core/runtime.ts: VERSION "${runtimeVersion}" does not match package.json version "${packageVersion}"`);
        }
    }

    const buildScriptPath = path.join(ROOT, 'scripts', 'build.mjs');
    if (existsSync(buildScriptPath)) {
        const buildScript = await readFile(buildScriptPath, 'utf8');
        const match = buildScript.match(/\/\/\s*@version\s+([^\r\n]+)/);
        const buildScriptVersion = match?.[1]?.trim();
        if (!buildScriptVersion) {
            report('scripts/build.mjs: missing @version in USER_SCRIPT_HEADER');
        } else if (buildScriptVersion !== packageVersion) {
            report(`scripts/build.mjs: header @version "${buildScriptVersion}" does not match package.json version "${packageVersion}"`);
        }
    }

    return packageVersion;
}

async function validateMetadata(source, packageVersion) {
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

    const productVersionRaw = single('version');
    const PRODUCT_VERSION = normalizeVersion(productVersionRaw);
    const TAG_VERSION = `v${PRODUCT_VERSION}`;
    const scriptName = single('name');
    if (scriptName !== PRODUCT_NAME) {
        report(`${SOURCE_NAME}: @name is "${scriptName}", expected version-independent "${PRODUCT_NAME}"`);
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

    if (!/^\d+\.\d+\.\d+$/.test(PRODUCT_VERSION)) {
        report(`${SOURCE_NAME}: @version is not SemVer-compatible: ${productVersionRaw}`);
    }
    if (productVersionRaw !== PRODUCT_VERSION) {
        report(`${SOURCE_NAME}: @version must omit the v prefix: ${productVersionRaw}`);
    }
    if (PRODUCT_VERSION !== EXPECTED_PRODUCT_VERSION) {
        report(`${SOURCE_NAME}: @version is ${PRODUCT_VERSION}, expected ${EXPECTED_PRODUCT_VERSION}`);
    }
    if (packageVersion && PRODUCT_VERSION !== packageVersion) {
        report(`${SOURCE_NAME}: @version "${PRODUCT_VERSION}" does not match package.json "${packageVersion}"`);
    }

    const runtimeVersionMatches = [...source.matchAll(/^\s*const VERSION = '([^']+)';$/gm)];
    if (runtimeVersionMatches.length !== 1) {
        report(`${SOURCE_NAME}: expected exactly one VERSION declaration, found ${runtimeVersionMatches.length}`);
    }
    const runtimeVersion = runtimeVersionMatches[0]?.[1] || '';
    if (runtimeVersion !== PRODUCT_VERSION) {
        report(`${SOURCE_NAME}: VERSION ${runtimeVersion} does not match @version ${productVersionRaw}`);
    }

    const runtimeRecord = source.match(/const runtimeRecord = \{[\s\S]*?^\s*\};/m)?.[0] || '';
    if (!runtimeRecord) {
        report(`${SOURCE_NAME}: runtimeRecord declaration not found`);
    } else {
        if (!/\bversion:\s*VERSION\b/.test(runtimeRecord)) {
            report(`${SOURCE_NAME}: runtimeRecord.version must derive from VERSION`);
        }
        if (/\bversion:\s*['"]/.test(runtimeRecord)) {
            report(`${SOURCE_NAME}: runtimeRecord.version must not duplicate the product version literal`);
        }
    }
    if (runtimeVersionMatches[0] && source.indexOf(runtimeVersionMatches[0][0]) > source.indexOf('const runtimeRecord = {')) {
        report(`${SOURCE_NAME}: VERSION must be initialized before runtimeRecord`);
    }

    const runtimeKeyMatches = [...source.matchAll(/^\s*const RUNTIME_KEY = '([^']+)';$/gm)];
    if (runtimeKeyMatches.length !== 1) {
        report(`${SOURCE_NAME}: expected exactly one RUNTIME_KEY declaration, found ${runtimeKeyMatches.length}`);
    }
    const RUNTIME_KEY = runtimeKeyMatches[0]?.[1] || '';
    if (RUNTIME_KEY !== EXPECTED_RUNTIME_KEY) {
        report(`${SOURCE_NAME}: runtime singleton key is "${RUNTIME_KEY}", expected "${EXPECTED_RUNTIME_KEY}"`);
    }
    if (/\d/.test(RUNTIME_KEY) || /__hhApplyAssistantV\d+Runtime/.test(source)) {
        report(`${SOURCE_NAME}: runtime singleton key must be independent from the product version`);
    }

    const storageSchemaMatches = [...source.matchAll(/^\s*const STORAGE_SCHEMA_VERSION = (\d+);$/gm)];
    if (storageSchemaMatches.length !== 1) {
        report(`${SOURCE_NAME}: expected exactly one STORAGE_SCHEMA_VERSION declaration, found ${storageSchemaMatches.length}`);
    }
    const STORAGE_SCHEMA_VERSION = Number(storageSchemaMatches[0]?.[1]);
    if (!Number.isSafeInteger(STORAGE_SCHEMA_VERSION) || STORAGE_SCHEMA_VERSION <= 0) {
        report(`${SOURCE_NAME}: STORAGE_SCHEMA_VERSION must be a positive integer`);
    } else if (STORAGE_SCHEMA_VERSION !== EXPECTED_STORAGE_SCHEMA_VERSION) {
        report(`${SOURCE_NAME}: STORAGE_SCHEMA_VERSION is ${STORAGE_SCHEMA_VERSION}, expected ${EXPECTED_STORAGE_SCHEMA_VERSION}`);
    }

    const expectedStoragePrefixDeclaration = /^\s*const STORAGE_PREFIX = `hh_apply_assistant_s\$\{STORAGE_SCHEMA_VERSION\}_`;$/m;
    const storagePrefixDeclarations = [...source.matchAll(new RegExp(expectedStoragePrefixDeclaration.source, 'gm'))];
    if (storagePrefixDeclarations.length !== 1) {
        report(`${SOURCE_NAME}: STORAGE_PREFIX must derive exactly once from STORAGE_SCHEMA_VERSION`);
    }
    if (/hh_apply_assistant_v\d+_/.test(source)) {
        report(`${SOURCE_NAME}: storage namespace must not use a product-version prefix`);
    }
    if (/hh_apply_assistant_s\d+_/.test(source)) {
        report(`${SOURCE_NAME}: storage keys must derive from STORAGE_SCHEMA_VERSION, not duplicate its value`);
    }
    const STORAGE_PREFIX = Number.isSafeInteger(STORAGE_SCHEMA_VERSION)
        ? `hh_apply_assistant_s${STORAGE_SCHEMA_VERSION}_`
        : '';
    if (STORAGE_PREFIX !== EXPECTED_STORAGE_PREFIX) {
        report(`${SOURCE_NAME}: storage prefix is ${STORAGE_PREFIX}, expected ${EXPECTED_STORAGE_PREFIX}`);
    }
    return { PRODUCT_VERSION, TAG_VERSION, STORAGE_SCHEMA_VERSION, STORAGE_PREFIX, RUNTIME_KEY };
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
    for (const name of ISSUE_FORM_NAMES) {
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
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'vitest.config.ts',
        'scripts/build.mjs',
        'LICENSE',
        'README.md',
        'README.en.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'CONTRIBUTING.en.md',
        'SECURITY.md',
        'SECURITY.en.md',
        'PRIVACY.md',
        'PRIVACY.en.md',
        'CODE_OF_CONDUCT.md',
        '.nvmrc',
        ...ISSUE_FORM_NAMES.map(name => `.github/ISSUE_TEMPLATE/${name}`),
        '.github/ISSUE_TEMPLATE/config.yml',
        '.github/pull_request_template.md',
        '.github/workflows/ci.yml',
        'docs/README.md',
        'docs/installation.md',
        'docs/installation.en.md',
        'docs/usage.md',
        'docs/usage.en.md',
        'docs/architecture.md',
        'docs/storage.md',
        'docs/lifecycle.md',
        'docs/diagnostics.md',
        'docs/development.md',
        'docs/troubleshooting.md',
        'docs/troubleshooting.en.md',
        'docs/release-process.md'
    ];
    for (const name of required) {
        if (!existsSync(path.join(ROOT, name))) report(`${name}: required repository file is missing`);
    }
}

const allFiles = await walk(ROOT);
validateRequiredFiles();
const packageVersion = await validatePackageAndViteVersions();
if (!existsSync(SOURCE_PATH)) report(`${SOURCE_NAME}: production userscript is missing`);
const source = existsSync(SOURCE_PATH) ? await readFile(SOURCE_PATH, 'utf8') : '';
const versionContract = source ? await validateMetadata(source, packageVersion) : null;

if (versionContract) {
    const { PRODUCT_VERSION, TAG_VERSION } = versionContract;
    // These markers guard version-file presence only. They do not prove semantic
    // equivalence between languages or between documentation and runtime behavior.
    const versionFiles = [
        ['README.md', `version-${PRODUCT_VERSION}`],
        ['README.en.md', `version-${PRODUCT_VERSION}`],
        ['CHANGELOG.md', `## [${PRODUCT_VERSION}]`],
        [`docs/release-notes/${TAG_VERSION}.md`, `# ${PRODUCT_NAME} ${TAG_VERSION}`]
    ];
    for (const [name, marker] of versionFiles) {
        const file = path.join(ROOT, name);
        if (!existsSync(file)) {
            report(`${name}: required version file is missing`);
            continue;
        }
        const content = await readFile(file, 'utf8');
        if (!content.includes(marker)) report(`${name}: version marker "${marker}" does not match ${PRODUCT_VERSION}`);
    }

    const migrationPlanPath = path.join(ROOT, 'docs', 'migration-plan.md');
    if (existsSync(migrationPlanPath)) {
        const migrationPlan = await readFile(migrationPlanPath, 'utf8');
        for (const marker of [
            `${PRODUCT_NAME} ${TAG_VERSION}`,
            `tag \`${TAG_VERSION}\``,
            `docs/release-notes/${TAG_VERSION}.md`
        ]) {
            if (!migrationPlan.includes(marker)) {
                report(`docs/migration-plan.md: current cutover marker "${marker}" is missing`);
            }
        }
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

const legacySourceName = 'script' + '.js';
for (const file of allFiles.filter(file => /\.(?:md|mjs|html|ya?ml)$/.test(file))) {
    const content = await readFile(file, 'utf8');
    const name = relative(file);
    if (content.includes(legacySourceName)) {
        report(`${name}: references removed production path ${legacySourceName}`);
    }
}
const workflow = await readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
for (const action of ['actions/checkout', 'actions/setup-node']) {
    const escaped = action.replace('/', '\\/');
    const match = workflow.match(new RegExp(`uses:\\s*${escaped}@([^\\s#]+)`));
    if (!match) {
        report(`.github/workflows/ci.yml: missing ${action} action`);
    } else if (!/^(?:v\d+|[a-f0-9]{40})$/.test(match[1])) {
        report(`.github/workflows/ci.yml: ${action} has an unsupported ref "${match[1]}"`);
    }
}

for (const command of [
    'npm ci',
    'npm run check',
    'npm run test',
    'npm run build',
    'node scripts/validate-repository.mjs'
]) {
    if (!workflow.includes(command)) report(`.github/workflows/ci.yml: missing command "${command}"`);
}

const nvmVersion = (await readFile(path.join(ROOT, '.nvmrc'), 'utf8')).trim();
if (!/^\d+(?:\.\d+){0,2}$/.test(nvmVersion)) {
    report(`.nvmrc: invalid Node.js version "${nvmVersion}"`);
}
const workflowNodeVersions = [...workflow.matchAll(/^\s*node-version:\s*["']?([^\s"'#]+)["']?\s*$/gm)].map(match => match[1]);
if (workflowNodeVersions.length !== 1) {
    report(`.github/workflows/ci.yml: expected exactly one node-version, found ${workflowNodeVersions.length}`);
} else if (workflowNodeVersions[0] !== nvmVersion) {
    report(`.github/workflows/ci.yml: node-version ${workflowNodeVersions[0]} does not match .nvmrc ${nvmVersion}`);
}

if (errors.length) {
    console.error(`Repository validation failed with ${errors.length} problem(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
} else {
    console.log(`Repository validation passed: ${markdownFiles.length} Markdown files, ${yamlFiles.length} YAML files, required files and userscript metadata checked.`);
}
