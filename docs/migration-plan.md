# Temporary: первый публичный cutover HH Apply Assistant 2.0.0

> [!IMPORTANT]
> Это одноразовый migration runbook для первой публикации HH Apply Assistant 2.0.0 в `tgeruzov/hh-auto-responder/main`. Он не относится к последующим релизам и не разрешает внешние write-операции. Обычные версии выпускаются по [release process](release-process.md).

Документ намеренно не фиксирует public tip, число commits или состояние working tree: эти данные устаревают после любого изменения. Их нужно получить заново непосредственно перед migration.

## Цель и стратегия

Предпочтительный результат — точный проверенный release commit HH Apply Assistant 2.0.0 в canonical `main` без force-push и без потери review history.

Нормализация historical public tags/releases — отдельная контролируемая операция до или вместе с final public cutover. Этот dev-only runbook не определяет окончательный список операций с опубликованными tags/releases, не разрешает их выполнять в текущем pass и не предполагает переписывание Git commit history.

Если актуальный public `main` является предком release commit, допустим controlled non-force fast-forward. Если repository rules требуют pull request, используйте review-preserving migration branch без squash и повторно проверьте итоговый merge SHA. Если histories разошлись, автоматический fast-forward больше не считается безопасным: migration останавливается до отдельного conflict, security и release review.

## Снимок состояния непосредственно перед migration

Сначала зафиксируйте release SHA и убедитесь, что локальный gate выполнен на чистом commit:

```bash
git status --short
git rev-parse HEAD
node --check hh-apply-assistant.user.js
node --test
node scripts/validate-repository.mjs
git diff --check
```

Затем read-only получите актуальный canonical `main`. В примере `canonical` — локальный remote, указывающий на `https://github.com/tgeruzov/hh-auto-responder.git`:

```bash
git remote get-url canonical
git fetch canonical main
git rev-parse canonical/main
git merge-base --is-ancestor canonical/main HEAD
git rev-list --count canonical/main..HEAD
git diff --name-status canonical/main...HEAD
```

Успешный `merge-base --is-ancestor` не заменяет review. Просмотрите полный diff, rename production-файла, license/metadata, Raw URLs, community files, CI и отсутствие приватных development artifacts.

## Последовательность cutover

1. Запишите exact release SHA и актуальный SHA `canonical/main` из только что выполненной проверки.
2. Убедитесь, что public `main` не изменился после снимка. При изменении повторите fetch, ancestry check, diff и local gate.
3. Получите отдельное разрешение на external write и выбранный способ доставки: non-force fast-forward либо pull request.
4. Перед реальной записью выполните dry run выбранной операции. Для прямого fast-forward: `git push --dry-run canonical HEAD:main`.
5. Доставьте exact проверенный commit без force-push. Не переносите незакоммиченный working tree, локальные refs, credentials или repository settings.
6. Дождитесь CI на canonical `main`, затем проверьте production Raw URL и чистую установку в Tampermonkey.
7. Только после production smoke создайте tag `v2.0.0` и GitHub Release **HH Apply Assistant v2.0.0** из `docs/release-notes/v2.0.0.md`.

## Stop conditions

- `canonical/main` не является предком release commit;
- public tip изменился после последней проверки;
- working tree не чист или release SHA отличается от проверенного;
- diff содержит неожиданные файлы, credentials, dumps, dev-only metadata или неподтверждённую license/URL замену;
- CI, production Raw install или минимальный hh.ru smoke не проходит;
- операция требует force-push, переписывания опубликованного tag или неразрешённого изменения repository settings.

После успешного первого cutover этот документ становится историческим и удаляется из активной навигации. Для последующих версий используется только переиспользуемый [release process](release-process.md).
