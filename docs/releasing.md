# Выпуск релиза

Короткая памятка maintainer для HH Apply Assistant. Она не автоматизирует tag или GitHub Release.

## Перед релизом

- [ ] Рабочее дерево содержит только намеренные изменения.
- [ ] Metadata `@version`, runtime `VERSION` и документация указывают одну release version.
- [ ] Defaults в README сверены с `DEFAULTS` и UI state в `script.js`.
- [ ] Privacy/security claims повторно проверены по production source.
- [ ] Branding в пользовательских и GitHub-facing файлах — **HH Apply Assistant**.
- [ ] `CHANGELOG.md` содержит только подтверждённую историю.
- [ ] Внутренние Markdown-ссылки и пути существуют.
- [ ] Нет временных файлов, персональных screenshots, dumps или release artifacts.

## Проверки

```bash
node --check script.js
node --test
git diff --check
```

Также просмотрите итоговый diff и выполните релевантный browser smoke для installation/update, Start/Stop, Manual Queue, Diagnostics, RU/EN и responsive layout.

## Публикация v4.0.0

1. Убедитесь, что CI зелёный для release commit.
2. Используйте раздел v4.0.0 из [CHANGELOG](../CHANGELOG.md) как основу коротких release notes.
3. Укажите ручной installation flow через `script.js` и отсутствие automatic update URL.
4. Создайте annotated tag `v4.0.0` только из проверенного release commit.
5. Создайте GitHub Release для этого tag и ещё раз проверьте ссылки из опубликованного README.

Tag, push и GitHub Release выполняются maintainer вручную; repository pass сам их не создаёт.
