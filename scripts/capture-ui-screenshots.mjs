import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'assets', 'screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function createServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const reqPath = req.url.split('?')[0];
            let filePath = path.join(ROOT, reqPath.replace(/^\//, ''));
            if (reqPath === '/') filePath = path.join(ROOT, 'tests', 'hh-docking-browser-fixture.html');

            if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }

            const ext = path.extname(filePath);
            const mimeTypes = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.png': 'image/png',
                '.svg': 'image/svg+xml'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port });
        });
    });
}

async function capture() {
    const { server, port } = await createServer();
    console.log(`[screenshots] Local fixture server running on http://127.0.0.1:${port}`);

    let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch (e) {
        browser = await chromium.launch({ headless: true });
    }

    try {
        // 1. 01-dock-wide-desktop.png (1920x1080, Wide Dock 410px, Active Running State, Balanced preset)
        {
            console.log('[screenshots] Rendering 01-dock-wide-desktop.png (1920x1080 @2x)...');
            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 },
                deviceScaleFactor: 2
            });
            const page = await context.newPage();
            await page.addInitScript(() => {
                localStorage.setItem('hh_apply_assistant_s1_ui_open', '1');
                localStorage.setItem('hh_apply_assistant_s1_settings', JSON.stringify({
                    coverText: 'Здравствуйте! Ознакомился с требованиями к позиции. Имею профильный коммерческий опыт разработки более 5 лет. Буду рад обсудить задачи проекта на интервью.',
                    useCover: true,
                    applyOnRejectWarning: false,
                    limit: 50,
                    preset: 'balanced',
                    lang: 'ru'
                }));
                sessionStorage.setItem('hh_apply_assistant_s1_sent_count', '14');
                sessionStorage.setItem('hh_apply_assistant_s1_is_active', '1');
                sessionStorage.setItem('hh_apply_assistant_s1_run_stats', JSON.stringify({
                    attempts: 18,
                    success: 14,
                    manual: 2,
                    skipped: 2
                }));
                localStorage.setItem('hh_apply_assistant_s1_manual_queue', JSON.stringify([
                    { vid: '1355693974', title: 'Senior Frontend Developer (TypeScript / React)', url: 'https://hh.ru/vacancy/1355693974', ts: Date.now() - 1000 * 60 * 12 },
                    { vid: '135550694', title: 'Lead JavaScript / Fullstack Engineer', url: 'https://hh.ru/vacancy/135550694', ts: Date.now() - 1000 * 60 * 45 }
                ]));
            });

            await page.goto(`http://127.0.0.1:${port}/tests/hh-docking-browser-fixture.html`);
            await page.waitForSelector('#ar-main-panel');
            await page.evaluate(() => {
                const startBtn = document.getElementById('ar-start-btn');
                const stopBtn = document.getElementById('ar-stop-btn');
                if (startBtn) startBtn.style.display = 'none';
                if (stopBtn) stopBtn.style.display = 'inline-flex';
                const status = document.getElementById('ar-status-text');
                if (status) {
                    status.className = 'ar-status ar-status--running';
                    status.textContent = 'Отправка отклика #15...';
                }
            });
            await page.waitForTimeout(400);
            await page.screenshot({
                path: path.join(SCREENSHOTS_DIR, '01-dock-wide-desktop.png'),
                fullPage: false
            });
            await context.close();
        }

        // 2. 02-dock-compact.png (1320x800, Compact Dock 340px, Populated Manual Queue)
        {
            console.log('[screenshots] Rendering 02-dock-compact.png (1320x800 @2x)...');
            const context = await browser.newContext({
                viewport: { width: 1320, height: 800 },
                deviceScaleFactor: 2
            });
            const page = await context.newPage();
            await page.addInitScript(() => {
                localStorage.setItem('hh_apply_assistant_s1_ui_open', '1');
                localStorage.setItem('hh_apply_assistant_s1_settings', JSON.stringify({
                    coverText: 'Здравствуйте! Готов обсудить детали вакансии и выполнить тестовое задание.',
                    useCover: true,
                    applyOnRejectWarning: false,
                    limit: 30,
                    preset: 'fast',
                    lang: 'ru'
                }));
                sessionStorage.setItem('hh_apply_assistant_s1_sent_count', '8');
                sessionStorage.setItem('hh_apply_assistant_s1_is_active', '0');
                sessionStorage.setItem('hh_apply_assistant_s1_run_stats', JSON.stringify({
                    attempts: 12,
                    success: 8,
                    manual: 3,
                    skipped: 1
                }));
                localStorage.setItem('hh_apply_assistant_s1_manual_queue', JSON.stringify([
                    { vid: '1355693974', title: 'Product Manager / SaaS платформа', url: 'https://hh.ru/vacancy/1355693974', ts: Date.now() - 1000 * 60 * 8 },
                    { vid: '135550694', title: 'Senior Software Engineer (Node.js / Go)', url: 'https://hh.ru/vacancy/135550694', ts: Date.now() - 1000 * 60 * 32 },
                    { vid: '135512345', title: 'Frontend Developer (React / Next.js)', url: 'https://hh.ru/vacancy/135512345', ts: Date.now() - 1000 * 60 * 110 }
                ]));
            });

            await page.goto(`http://127.0.0.1:${port}/tests/hh-docking-browser-fixture.html`);
            await page.waitForSelector('#ar-main-panel');
            await page.waitForTimeout(400);
            await page.screenshot({
                path: path.join(SCREENSHOTS_DIR, '02-dock-compact.png'),
                fullPage: false
            });
            await context.close();
        }

        // 3. 03-overlay-mobile.png (768x1024, Overlay Mode, Diagnostic Log View)
        {
            console.log('[screenshots] Rendering 03-overlay-mobile.png (768x1024 @2x)...');
            const context = await browser.newContext({
                viewport: { width: 768, height: 1024 },
                deviceScaleFactor: 2
            });
            const page = await context.newPage();
            await page.addInitScript(() => {
                localStorage.setItem('hh_apply_assistant_s1_ui_open', '1');
                localStorage.setItem('hh_apply_assistant_s1_settings', JSON.stringify({
                    coverText: 'Добрый день!',
                    useCover: false,
                    applyOnRejectWarning: false,
                    limit: 25,
                    preset: 'balanced',
                    lang: 'ru'
                }));
                const now = Date.now();
                localStorage.setItem('hh_apply_assistant_s1_diagnostic_log', JSON.stringify([
                    { t: now - 35000, lvl: 'INFO', msg: 'Инициализация HH Apply Assistant v4.0.0 завершена' },
                    { t: now - 30000, lvl: 'INFO', msg: 'Селекторы проверены: 6/6 элементов активны на странице' },
                    { t: now - 24000, lvl: 'INFO', msg: 'Отклик отправлен: вакансия #1355693974 (Senior Frontend)' },
                    { t: now - 19000, lvl: 'WARN', msg: 'Обнаружено предупреждение о несоответствии критериям (отклик пропущен)' },
                    { t: now - 14000, lvl: 'INFO', msg: 'Вакансия сохранена в ручную очередь: #135550694' },
                    { t: now - 9000, lvl: 'OK', msg: 'Подтверждение отклика получено успешно' },
                    { t: now - 5000, lvl: 'ERR', msg: 'Временный сбой сети при открытии вакансии #135599881' },
                    { t: now - 2000, lvl: 'INFO', msg: 'Возобновление цикла поиска вакансий на странице...' }
                ]));
            });

            await page.goto(`http://127.0.0.1:${port}/tests/hh-docking-browser-fixture.html`);
            await page.waitForSelector('#ar-toggle-btn');
            await page.click('#ar-toggle-btn');
            await page.waitForSelector('#ar-main-panel');
            await page.click('#ar-health-btn');
            await page.waitForSelector('#ar-view-diag');
            await page.waitForTimeout(400);
            await page.screenshot({
                path: path.join(SCREENSHOTS_DIR, '03-overlay-mobile.png'),
                fullPage: false
            });
            await context.close();
        }

        // 4. 04-turbo-mode-active.png (Turbo Mode with dynamic animated wave canvas/strip)
        {
            console.log('[screenshots] Rendering 04-turbo-mode-active.png (1440x900 @2x)...');
            const context = await browser.newContext({
                viewport: { width: 1440, height: 900 },
                deviceScaleFactor: 2
            });
            const page = await context.newPage();
            await page.addInitScript(() => {
                localStorage.setItem('hh_apply_assistant_s1_ui_open', '1');
                localStorage.setItem('hh_apply_assistant_s1_settings', JSON.stringify({
                    coverText: 'Здравствуйте! Готов максимально оперативно включиться в работу над проектом.',
                    useCover: true,
                    applyOnRejectWarning: true,
                    limit: 100,
                    preset: 'turbo',
                    lang: 'ru'
                }));
                sessionStorage.setItem('hh_apply_assistant_s1_sent_count', '42');
                sessionStorage.setItem('hh_apply_assistant_s1_is_active', '1');
                sessionStorage.setItem('hh_apply_assistant_s1_run_stats', JSON.stringify({
                    attempts: 48,
                    success: 42,
                    manual: 4,
                    skipped: 2
                }));
                localStorage.setItem('hh_apply_assistant_s1_manual_queue', JSON.stringify([
                    { vid: '1355693974', title: 'Tech Lead / Staff Engineer (Distributed Systems)', url: 'https://hh.ru/vacancy/1355693974', ts: Date.now() - 1000 * 60 * 5 }
                ]));
            });

            await page.goto(`http://127.0.0.1:${port}/tests/hh-docking-browser-fixture.html`);
            await page.waitForSelector('#ar-main-panel');
            await page.evaluate(() => {
                const startBtn = document.getElementById('ar-start-btn');
                const stopBtn = document.getElementById('ar-stop-btn');
                if (startBtn) startBtn.style.display = 'none';
                if (stopBtn) stopBtn.style.display = 'inline-flex';
                const status = document.getElementById('ar-status-text');
                if (status) {
                    status.className = 'ar-status ar-status--running';
                    status.textContent = 'Турбо-отклик #43...';
                }
            });
            await page.waitForTimeout(600);
            await page.screenshot({
                path: path.join(SCREENSHOTS_DIR, '04-turbo-mode-active.png'),
                fullPage: false
            });
            await context.close();
        }

        // 5. 05-queue-empty-and-populated.png (Empty State with vector icon)
        {
            console.log('[screenshots] Rendering 05-queue-empty-and-populated.png (1440x900 @2x)...');
            const context = await browser.newContext({
                viewport: { width: 1440, height: 900 },
                deviceScaleFactor: 2
            });
            const page = await context.newPage();
            await page.addInitScript(() => {
                localStorage.setItem('hh_apply_assistant_s1_ui_open', '1');
                localStorage.setItem('hh_apply_assistant_s1_settings', JSON.stringify({
                    coverText: 'Добрый день! Ознакомился с описанием позиции.',
                    useCover: true,
                    applyOnRejectWarning: false,
                    limit: 50,
                    preset: 'balanced',
                    lang: 'ru'
                }));
                sessionStorage.setItem('hh_apply_assistant_s1_sent_count', '0');
                sessionStorage.setItem('hh_apply_assistant_s1_is_active', '0');
                sessionStorage.setItem('hh_apply_assistant_s1_run_stats', JSON.stringify({
                    attempts: 0,
                    success: 0,
                    manual: 0,
                    skipped: 0
                }));
                localStorage.setItem('hh_apply_assistant_s1_manual_queue', JSON.stringify([]));
            });

            await page.goto(`http://127.0.0.1:${port}/tests/hh-docking-browser-fixture.html`);
            await page.waitForSelector('#ar-main-panel');
            await page.waitForTimeout(400);
            await page.screenshot({
                path: path.join(SCREENSHOTS_DIR, '05-queue-empty-and-populated.png'),
                fullPage: false
            });
            await context.close();
        }

        // 6. 06-popover-help-i18n.png (Open Help Popover in English)
        {
            console.log('[screenshots] Rendering 06-popover-help-i18n.png (1440x900 @2x)...');
            const context = await browser.newContext({
                viewport: { width: 1440, height: 900 },
                deviceScaleFactor: 2
            });
            const page = await context.newPage();
            await page.addInitScript(() => {
                localStorage.setItem('hh_apply_assistant_s1_ui_open', '1');
                localStorage.setItem('hh_apply_assistant_s1_settings', JSON.stringify({
                    coverText: 'Hello! I have relevant commercial development experience and would be glad to discuss the role.',
                    useCover: true,
                    applyOnRejectWarning: false,
                    limit: 50,
                    preset: 'balanced',
                    lang: 'en'
                }));
                sessionStorage.setItem('hh_apply_assistant_s1_sent_count', '5');
                sessionStorage.setItem('hh_apply_assistant_s1_is_active', '0');
                sessionStorage.setItem('hh_apply_assistant_s1_run_stats', JSON.stringify({
                    attempts: 6,
                    success: 5,
                    manual: 1,
                    skipped: 0
                }));
                localStorage.setItem('hh_apply_assistant_s1_manual_queue', JSON.stringify([
                    { vid: '1355693974', title: 'Senior Software Engineer (Frontend / UI)', url: 'https://hh.ru/vacancy/1355693974', ts: Date.now() - 1000 * 60 * 15 }
                ]));
            });

            await page.goto(`http://127.0.0.1:${port}/tests/hh-docking-browser-fixture.html`);
            await page.waitForSelector('#ar-main-panel');
            await page.click('.ar-lang-btn[data-lang="en"]');
            await page.waitForTimeout(200);
            await page.click('#ar-work-mode-help-btn');
            await page.waitForSelector('#ar-work-mode-popover');
            await page.waitForTimeout(400);
            await page.screenshot({
                path: path.join(SCREENSHOTS_DIR, '06-popover-help-i18n.png'),
                fullPage: false
            });
            await context.close();
        }

        console.log(`[screenshots] All 6 screenshots successfully rendered and saved to: ${SCREENSHOTS_DIR}`);
    } finally {
        await browser.close();
        server.close();
    }
}

capture().catch((err) => {
    console.error('[screenshots] Error:', err);
    process.exit(1);
});
