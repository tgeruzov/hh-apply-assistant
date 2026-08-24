# План будущей миграции

Этот документ описывает только будущий controlled migration в `tgeruzov/hh-auto-responder/main`. Он не разрешает и не выполняет внешние write-операции.

## Проверенное исходное состояние

Read-only аудит 24 августа 2026 года показал:

- canonical public `main` указывает на commit `3e30d854` и содержит публичную v3.3-структуру (`LICENSE`, `README.md`, `script.js`);
- текущая committed development history содержит этот commit как прямого предка;
- merge base равен `3e30d854`; относительно него в public history нет отдельных commits, а в development history есть 26 committed commits до текущего pre-release pass;
- текущие незакоммиченные изменения должны сначала стать отдельным проверенным release commit.

Публичный tip мог измениться после аудита, поэтому ancestry необходимо проверить повторно непосредственно перед migration.

## Рекомендуемая стратегия

Использовать **controlled non-force fast-forward** exact release commit в canonical `main`. Обычный merge или cherry-pick сейчас не нужны: они добавят лишний merge commit либо потеряют полезную v4-историю, хотя public tip уже является её предком.

Если правила canonical repository требуют pull request, создайте migration branch от текущего public `main`, fast-forward доведите её до release commit и проведите PR без squash. Итоговый production SHA должен быть заранее известным проверенным SHA либо явно повторно проверенным merge SHA.

## Будущая последовательность

1. Закоммитить release-ready working tree в development history и записать exact SHA.
2. Повторить полный local gate на чистом commit.
3. Read-only получить актуальный canonical `main` и проверить `git merge-base --is-ancestor <public-main> <release-sha>`.
4. Просмотреть tree diff: ожидаются замена `script.js` на `hh-apply-assistant.user.js` и добавление docs, tests, CI и support files.
5. Выполнить разрешённый non-force fast-forward или review-preserving PR в canonical `main`.
6. Прогнать CI и production Raw/Tampermonkey smoke.
7. Только после smoke создать tag `v4.0.0` и GitHub Release.

## Риски и stop conditions

- Если canonical `main` получит новые commits, не входящие в release history, остановиться и выполнить новый conflict/security review.
- Не переносить незакоммиченные файлы, локальные refs, credentials или repository settings.
- Не использовать force-push и не переписывать опубликованные tags.
- Особое внимание при review уделить rename production-файла, GPL metadata, Raw URLs и сохранению canonical README/issue links.
