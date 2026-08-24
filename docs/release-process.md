# Выпуск версии

Production-источником установки и автоматических обновлений является `main` canonical repository:

`https://github.com/tgeruzov/hh-auto-responder`

Metadata, install links и support links заранее указывают на этот адрес. GitHub redirects не считаются частью update contract.

## Сейчас

Release candidate готовится и проверяется в development repository на ветке `dev`. До отдельного разрешения нельзя переносить состояние в canonical repository, создавать там commits, branches, tags или Releases либо менять его настройки.

До миграции canonical raw URL может возвращать старую версию или не содержать `hh-apply-assistant.user.js`. Это ожидаемое внешнее состояние: корректность подготовленной конфигурации проверяется статически, а production installation smoke выполняется только после публикации в canonical `main`.

Текущий этап заканчивается готовым release commit/state, зелёными локальными проверками, release notes и [migration plan](migration-plan.md). Tag и GitHub Release на этом этапе не создаются.

## Где хранится версия

Для release нужно синхронизировать:

- `@name` и `@version` в metadata (`v4.0.0` для текущей версии);
- `runtimeRecord.version` и константу `VERSION` (`4.0.0` без `v`);
- badges и факты в `README.md`/`README.en.md`;
- `CHANGELOG.md`;
- release notes в `docs/release-notes/`.

`scripts/validate-repository.mjs` проверяет metadata/runtime/README/changelog consistency, production URLs и обязательные release-файлы. Номер не хранится в отдельном `VERSION`, чтобы не добавлять ещё одно неиспользуемое runtime-дублирование.

## SemVer для проекта

- **MAJOR:** несовместимый storage namespace/schema, существенное изменение automation contract или обязательной установки.
- **MINOR:** новая пользовательская возможность или поддержанный response/UI flow с обратной совместимостью.
- **PATCH:** исправление selectors, confirmation, lifecycle, UI или документации без изменения публичного контракта.

Version bump должен происходить только при подготовке публикации, а не в каждом feature commit.

## Подготовка release candidate

1. Убедитесь, что changelog содержит только подтверждённые изменения с текущего tag/release boundary. Не восстанавливайте старую историю по памяти.
2. Перенесите пункты из **Unreleased** в новый version section и поставьте release date.
3. Создайте или обновите `docs/release-notes/vX.Y.Z.md`.
4. Синхронизируйте все version locations выше.
5. Проверьте defaults, limits, timings, storage keys, permissions, network/privacy claims и install URLs по production source.
6. Просмотрите diff на временные files, dumps, screenshots с персональными данными и dev-only metadata.
7. Зафиксируйте точный release commit SHA; перенос незакоммиченного working tree запрещён.

## Локальные проверки

```bash
node --check hh-apply-assistant.user.js
node --test
node scripts/validate-repository.mjs
git diff --check
git status --short
```

Browser smoke development-копии описан в [development.md](development.md#browser-smoke). До миграции проверяется локальная установка через редактор Tampermonkey и синтаксис metadata; canonical Raw install остаётся pending.

## Будущий production flow

Только после отдельной команды на migration/release:

1. Перенести точный проверенный release commit/state в `tgeruzov/hh-auto-responder/main` по [migration plan](migration-plan.md), без force-push.
2. Дождаться успешного CI на canonical `main`.
3. Открыть `https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js` и убедиться, что metadata находится в начале файла, а `@version` равен `v4.0.0`.
4. Установить production Raw URL в чистую запись Tampermonkey и выполнить минимальный hh.ru smoke.
5. Создать annotated tag `v4.0.0` на уже проверенном production commit.
6. Создать GitHub Release из [release-notes/v4.0.0.md](release-notes/v4.0.0.md).
7. Проверить tag-specific Raw URL и update mechanism Tampermonkey без fake version bump.

Пример команд для будущего этапа после разрешения и проверки production commit:

```bash
git tag -a vX.Y.Z -m "HH Apply Assistant vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "HH Apply Assistant vX.Y.Z" --notes-file docs/release-notes/vX.Y.Z.md --verify-tag
```

Репозиторий не создаёт tag или Release автоматически.

## После публикации

- Проверьте install URL из `main` и tag-specific Raw URL.
- В существующей записи выполните update check с предыдущей версией, если она доступна.
- Проверьте README badges, changelog, release links и CI release commit.
- Убедитесь, что GitHub Release помечен как latest stable, а не draft/prerelease, если это обычный релиз.
- Оставьте новый пустой **Unreleased** section для следующих изменений.

Если после release обнаружена documentation-only ошибка, исправьте её отдельным commit. Если меняется userscript source или metadata так, что установленные пользователи должны получить обновление, выпустите новый PATCH вместо перезаписи опубликованного tag.
