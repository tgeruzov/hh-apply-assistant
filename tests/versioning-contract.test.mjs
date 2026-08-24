import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SCRIPT_SOURCE = readFileSync(new URL('../hh-apply-assistant.user.js', import.meta.url), 'utf8');
const EXPECTED_PRODUCT_VERSION = '4.0.0';
const EXPECTED_STORAGE_SCHEMA_VERSION = 1;
const EXPECTED_STORAGE_PREFIX = 'hh_apply_assistant_s1_';
const EXPECTED_RUNTIME_KEY = '__hhApplyAssistantRuntime';

function metadataValue(key) {
    const values = [...SCRIPT_SOURCE.matchAll(new RegExp(`^//\\s+@${key}\\s+(.+)$`, 'gm'))]
        .map(match => match[1].trim());
    assert.equal(values.length, 1, `expected exactly one @${key}`);
    return values[0];
}

test('product metadata, runtime VERSION and runtime record share one product version', () => {
    assert.equal(metadataValue('name'), 'HH Apply Assistant');
    assert.equal(metadataValue('version'), EXPECTED_PRODUCT_VERSION);

    const runtimeVersions = [...SCRIPT_SOURCE.matchAll(/^\s*const VERSION = '([^']+)';$/gm)];
    assert.equal(runtimeVersions.length, 1, 'expected exactly one VERSION declaration');
    assert.equal(runtimeVersions[0][1], EXPECTED_PRODUCT_VERSION);

    const runtimeRecord = SCRIPT_SOURCE.match(/const runtimeRecord = \{[\s\S]*?^\s*\};/m)?.[0] || '';
    assert.match(runtimeRecord, /\bversion:\s*VERSION\b/);
    assert.doesNotMatch(runtimeRecord, /\bversion:\s*['"]/);
    assert.ok(
        SCRIPT_SOURCE.indexOf(runtimeVersions[0][0]) < SCRIPT_SOURCE.indexOf('const runtimeRecord = {'),
        'VERSION must be initialized before runtimeRecord uses it'
    );
});

test('runtime singleton identity is stable across product versions', () => {
    const declarations = [...SCRIPT_SOURCE.matchAll(/^\s*const RUNTIME_KEY = '([^']+)';$/gm)];
    assert.equal(declarations.length, 1, 'expected exactly one RUNTIME_KEY declaration');
    assert.equal(declarations[0][1], EXPECTED_RUNTIME_KEY);
    assert.doesNotMatch(declarations[0][1], /\d/);
    assert.doesNotMatch(SCRIPT_SOURCE, /__hhApplyAssistantV\d+Runtime/);
});

test('storage schema and namespace are independent from product SemVer', () => {
    const declarations = [...SCRIPT_SOURCE.matchAll(/^\s*const STORAGE_SCHEMA_VERSION = (\d+);$/gm)];
    assert.equal(declarations.length, 1, 'expected exactly one STORAGE_SCHEMA_VERSION declaration');
    const schemaVersion = Number(declarations[0][1]);
    assert.equal(schemaVersion, EXPECTED_STORAGE_SCHEMA_VERSION);
    assert.ok(Number.isSafeInteger(schemaVersion) && schemaVersion > 0);

    const prefixDeclaration = SCRIPT_SOURCE.match(
        /^\s*const STORAGE_PREFIX = `hh_apply_assistant_s\$\{STORAGE_SCHEMA_VERSION\}_`;$/m
    )?.[0] || '';
    assert.ok(prefixDeclaration, 'STORAGE_PREFIX must derive from STORAGE_SCHEMA_VERSION');
    assert.doesNotMatch(prefixDeclaration, /\bVERSION\b/);
    assert.equal(`hh_apply_assistant_s${schemaVersion}_`, EXPECTED_STORAGE_PREFIX);
    assert.doesNotMatch(SCRIPT_SOURCE, /hh_apply_assistant_v\d+_/);
    assert.doesNotMatch(SCRIPT_SOURCE, /hh_apply_assistant_s\d+_/);
    const productMajor = EXPECTED_PRODUCT_VERSION.split('.')[0];
    assert.equal(SCRIPT_SOURCE.includes(`hh_apply_assistant_v${productMajor}_`), false);
    assert.equal(SCRIPT_SOURCE.includes('hh_apply_assistant_v4_'), false);
    assert.equal(SCRIPT_SOURCE.includes('__hhApplyAssistantV4Runtime'), false);
});
