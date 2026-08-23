# Участие в разработке

Спасибо за интерес к HH Apply Assistant. Проект намеренно остаётся обычным userscript без build system и npm-зависимостей.

## Окружение

- Git;
- Node.js 24 LTS рекомендуется для совпадения с CI;
- браузер с Tampermonkey нужен только для ручной browser-проверки.

Никакой `npm install` не требуется.

## Перед изменением

1. Опишите bug или use case достаточно узко.
2. Не меняйте business behavior, storage contract, timing profiles или irreversible-action guards без причины и regression test.
3. Для UI и текстов сохраняйте симметрию RU/EN, keyboard access и responsive behavior.
4. Не добавляйте внешнюю зависимость, сетевой вызов или новое разрешение userscript без явного обоснования privacy/security последствий.

## Проверки

```bash
node --check script.js
node --test
git diff --check
```

Для UI-изменений дополнительно проверьте Tampermonkey flow на hh.ru, RU/EN, узкую ширину и console errors. Не включайте в fixtures или screenshots реальные персональные данные.

## Pull request

- Делайте PR небольшим и сфокусированным.
- Объясните пользовательский эффект и причину изменения.
- Укажите выполненные проверки.
- Отдельно отметьте влияние на UI, RU/EN, storage, timing или automation behavior.
- Обновите документацию и тесты, если изменился публичный контракт.

Security issues сообщайте по [SECURITY.md](SECURITY.md), а не через подробный публичный bug report.
