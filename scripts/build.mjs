import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT, 'dist');
const OUTPUT_FILE = path.join(DIST_DIR, 'hh-apply-assistant.user.js');
const ROOT_OUTPUT_FILE = path.join(ROOT, 'hh-apply-assistant.user.js');

if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
}

const MODULES = [
    'core/runtime.ts',
    'dom/selectors.ts',
    'storage/storage-service.ts',
    'i18n/dictionaries.ts',
    'i18n/i18n.ts',
    'core/utils.ts',
    'core/concurrency.ts',
    'core/state-manager.ts',
    'dom/dom-adapter.ts',
    'core/automation-engine.ts',
    'core/watchdog.ts',
    'ui/icons.ts',
    'ui/styles.ts',
    'ui/layout.ts',
    'ui/slider.ts',
    'ui/diagnostics.ts',
    'ui/localization-binder.ts',
    'ui/queue.ts',
    'ui/stats.ts',
    'ui/autosave.ts',
    'ui/help.ts',
    'ui/export.ts',
    'ui/panel.ts',
    'main.ts'
];

function mergeEdits(rawEdits) {
    if (rawEdits.length === 0) return [];
    const sorted = [...rawEdits].sort((a, b) => a.start !== b.start ? a.start - b.start : b.end - a.end);
    const merged = [];
    let current = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i++) {
        const next = sorted[i];
        if (next.start <= current.end) {
            current.end = Math.max(current.end, next.end);
        } else {
            merged.push(current);
            current = { ...next };
        }
    }
    merged.push(current);
    return merged;
}

function stripTypeScript(code) {
    const sf = ts.createSourceFile('file.ts', code, ts.ScriptTarget.ES2022, true);
    const rawEdits = [];

    function visit(node) {
        if (ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isExportDeclaration(node)) {
            rawEdits.push({ start: node.pos, end: node.end });
            return;
        }
        if (node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
            rawEdits.push({ start: node.pos, end: node.end });
            return;
        }
        if (ts.isTypeParameterDeclaration(node)) {
            return;
        }
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node)) {
            if (node.typeParameters && node.typeParameters.length > 0 && node.name) {
                const start = node.name.end;
                const end = code.indexOf('(', start);
                if (end !== -1) rawEdits.push({ start, end });
            }
        }
        if (ts.isArrowFunction(node) && node.typeParameters && node.typeParameters.length > 0) {
            const start = code.indexOf('<', node.pos);
            const end = code.indexOf('(', start);
            if (start !== -1 && end !== -1) rawEdits.push({ start, end });
        }
        if ((ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) && node.typeArguments && node.typeArguments.length > 0) {
            const start = node.expression.end;
            const end = code.indexOf('(', start);
            if (end !== -1) {
                rawEdits.push({ start, end });
                visit(node.expression);
                if (node.arguments) {
                    for (const arg of node.arguments) {
                        visit(arg);
                    }
                }
                return;
            }
        }
        if (ts.isTypeNode(node)) {
            let start = node.pos;
            const parent = node.parent;
            if (parent && (
                ts.isParameter(parent) ||
                ts.isPropertyDeclaration(parent) ||
                ts.isPropertySignature(parent) ||
                ts.isFunctionDeclaration(parent) ||
                ts.isArrowFunction(parent) ||
                ts.isMethodDeclaration(parent) ||
                ts.isVariableDeclaration(parent)
            ) && parent.type === node) {
                if (parent.questionToken) {
                    start = parent.questionToken.pos;
                } else {
                    const colonPos = code.lastIndexOf(':', node.pos);
                    if (colonPos !== -1) start = colonPos;
                }
            }
            rawEdits.push({ start, end: node.end });
            return;
        }
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
            rawEdits.push({ start: node.expression.end, end: node.end });
            visit(node.expression);
            return;
        }
        ts.forEachChild(node, visit);
    }

    visit(sf);
    const mergedEdits = mergeEdits(rawEdits);
    mergedEdits.sort((a, b) => b.start - a.start);

    let out = code;
    for (const e of mergedEdits) {
        out = out.slice(0, e.start) + out.slice(e.end);
    }
    out = out.replace(/^[ \t]*export\s+default\s+/gm, '');
    out = out.replace(/^[ \t]*export\s+(const|let|var|function|async function|class)\s+/gm, '$1 ');
    out = out.replace(/if\s*\(\s*existingRuntime\s*&&\s*existingRuntime\.active\s*\)\s*\{[\s\S]*?\}/, 'if (existingRuntime && existingRuntime.active) return;');
    return out.trim();
}

function processModule(relPath) {
    const fullPath = path.join(ROOT, 'src', relPath);
    const tsCode = readFileSync(fullPath, 'utf8');
    return stripTypeScript(tsCode);
}

console.log('[build] Compiling and assembling userscript from typed modules in src/...');

const USER_SCRIPT_HEADER = `// ==UserScript==
// @name         HH Apply Assistant
// @namespace    http://tampermonkey.net/
// @version      4.0.0
// @description  HH Apply Assistant — инструмент автоматизации откликов на вакансии hh.ru (HeadHunter)
// @author       Timur Geruzov
// @license      GPL-3.0-only
// @homepageURL  https://github.com/tgeruzov/hh-apply-assistant
// @supportURL   https://github.com/tgeruzov/hh-apply-assistant/issues
// @updateURL    https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
`;

const processedChunks = [];
for (const mod of MODULES) {
    const chunk = processModule(mod);
    if (chunk) {
        processedChunks.push(chunk);
    }
}

// Indent each line by 4 spaces for IIFE
const indentedBody = processedChunks
    .join('\n\n')
    .split('\n')
    .map(line => line.trim() ? (line.startsWith('    ') ? line : '    ' + line) : '')
    .join('\n');

const assembledSource = `${USER_SCRIPT_HEADER}
(function () {
    'use strict';

${indentedBody}
})();
`;

writeFileSync(OUTPUT_FILE, assembledSource, 'utf8');
writeFileSync(ROOT_OUTPUT_FILE, assembledSource, 'utf8');

console.log(`[build] Successfully generated ${OUTPUT_FILE} (${(assembledSource.length / 1024).toFixed(2)} KB)`);
