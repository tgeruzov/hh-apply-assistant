# Выпуск версии

Production-источником установки и автоматических обновлений является `main` canonical repository:

`https://github.com/tgeruzov/hh-auto-responder`

Metadata, install links и support links должны указывать именно на этот адрес. GitHub redirects не считаются частью update contract. Этот документ описывает переиспользуемый выпуск любой версии `X.Y.Z`; одноразовый перенос первого публичного выпуска HH Apply Assistant 2.0.0 вынесен в [temporary migration plan](migration-plan.md).

## Источники версии

При подготовке `X.Y.Z` синхронизируются:

- `@name` в metadata: стабильное `HH Apply Assistant` без версии;
- `@version` в metadata: `X.Y.Z` без префикса `v`;
- `runtimeRecord.version` и константа `VERSION`: `X.Y.Z` без префикса `v`;
- version badge и факты в `README.md`/`README.en.md`;
- section `X.Y.Z` в `CHANGELOG.md`;
- `docs/release-notes/vX.Y.Z.md`.

`scripts/validate-repository.mjs` получает текущую версию из metadata, сверяет с ней runtime-константу `VERSION` и проверяет остальные locations. Отдельного файла `VERSION` в repository нет: source of truth для release tooling — userscript metadata.

## SemVer начиная с 2.0.0

- **MAJOR:** несовместимое изменение пользовательского compatibility contract, включая обязательный несовместимый переход данных или установки.
- **MINOR:** новая пользовательская возможность или поддержанный сценарий с обратной совместимостью.
- **PATCH:** исправление поведения, совместимости с hh.ru, интерфейса или документации без несовместимого изменения.

Версия 2.0.0 начинает нормализованную SemVer-линию HH Apply Assistant: backwards-compatible bugfix выпускается как 2.0.1, backwards-compatible feature — как 2.1.0, а breaking user-facing compatibility change — как 3.0.0. Большой diff, UI redesign, refactor или количество строк сами по себе не требуют MAJOR. Legacy-поколение HH.ru Auto Responder относится к линии 1.x; нормализация его historical public tags/releases выполняется отдельно без переписывания Git commit history. Version bump выполняется при подготовке публикации, а не в каждом feature commit.

Storage schema version движется независимо от product SemVer и увеличивается только тогда, когда текущие persisted data нельзя корректно прочитать без migration. Поэтому, например, HH Apply Assistant 2.5.0 может продолжать использовать storage schema 1.

## Подготовка release candidate

1. Определите тип изменения по SemVer и выберите версию `X.Y.Z`.
2. Определите предыдущий опубликованный tag и проверьте изменения после него.
3. Оставьте в `CHANGELOG.md` только подтверждённые пользовательские изменения. Перенесите их из **Unreleased** в section `X.Y.Z` и поставьте дату выпуска.
4. Создайте `docs/release-notes/vX.Y.Z.md`: кратко опишите пользовательский эффект, совместимость, установку и обновление.
5. Синхронизируйте все version locations из списка выше.
6. Сверьте defaults, limits, storage compatibility, permissions, privacy/network claims и install URLs с production source.
7. Просмотрите diff на временные файлы, dumps, dev-only metadata и персональные данные в fixtures или screenshots.
8. Зафиксируйте точный release commit SHA. Незакоммиченный working tree не переносится в production.

## Локальные проверки

```bash
node --check hh-apply-assistant.user.js
node --test
node scripts/validate-repository.mjs
git diff --check
git status --short
```

Browser smoke описан в [development.md](development.md#browser-smoke). Перед публикацией проверьте release candidate в отдельной development-записи Tampermonkey с минимальным безопасным сценарием.

## Ручная смысловая проверка

Validator проверяет только детерминированные факты и не подтверждает смысловую эквивалентность документации. Перед публикацией вручную выполните:

- проверку фактической синхронизации русской и английской документации;
- выборочную сверку поведения из README с production-кодом;
- проверку текущих требований Chrome и Tampermonkey по их официальной документации.

## Публикация

External write-операции выполняются только после явного разрешения maintainer и на точном проверенном release commit.

1. Доставьте release commit в canonical `main` через принятый repository workflow, без force-push и переписывания истории.
2. Дождитесь успешного CI на canonical `main`.
3. Откройте `https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js` и проверьте имя, `@version`, `@updateURL` и `@downloadURL`.
4. Установите production Raw URL в чистую запись Tampermonkey и выполните минимальный hh.ru smoke.
5. Создайте annotated tag `vX.Y.Z` на уже проверенном production commit.
6. Создайте GitHub Release из `docs/release-notes/vX.Y.Z.md`.
7. Проверьте tag-specific Raw URL и обычный userscript update с предыдущей опубликованной версии, если она доступна.

В примере `canonical` — отдельный remote с точным URL production repository. Команды выполняются только после подстановки фактической версии, проверки production SHA и сверки remote:

```bash
git remote get-url canonical
git tag -a vX.Y.Z -m "HH Apply Assistant vX.Y.Z"
git push canonical vX.Y.Z
gh release create vX.Y.Z --repo tgeruzov/hh-auto-responder --title "HH Apply Assistant vX.Y.Z" --notes-file docs/release-notes/vX.Y.Z.md --verify-tag
```

`git remote get-url canonical` должен вывести `https://github.com/tgeruzov/hh-auto-responder.git`. Если remote отсутствует или URL отличается, остановите выпуск до явной проверки конфигурации.

Tag и GitHub Release не создаются автоматически.

## После публикации

- Проверьте install URL из `main`, tag-specific Raw URL и update path.
- Проверьте README badges, changelog, release links и CI для release commit.
- Убедитесь, что обычный стабильный GitHub Release помечен как latest, а не draft или prerelease.
- Оставьте новый пустой **Unreleased** section.

Опубликованный tag не переписывается. Если userscript source или metadata должны обновиться у установленных пользователей, выпускается новый PATCH. Documentation-only correction после релиза оформляется отдельным commit, если она не меняет устанавливаемый artifact.
