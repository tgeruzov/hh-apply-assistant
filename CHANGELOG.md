# Changelog

Значимые пользовательские изменения HH Apply Assistant фиксируются в этом файле. История до первого публичного стабильного релиза не реконструируется задним числом.

## [4.0.0] - 2026-08-24

### Основные возможности

- Панель управления для автоматизации стандартных откликов на текущей странице hh.ru.
- Четыре Work Mode: Safe, Balanced, Fast и Turbo.
- Настраиваемое сопроводительное письмо и лимит успешных откликов.
- Manual Queue для вопросов работодателя, предупреждений и неподтверждённых сценариев.
- Diagnostics с журналом, метриками, Healthcheck и локальным экспортом.
- Русский и английский интерфейс, responsive dock/overlay layout.

### Надёжность и безопасность

- v4 storage namespace, сохранение состояния между навигациями и защита от повторной обработки.
- Generation-aware cross-tab lease с commit guards перед необратимыми действиями.
- SPA/reload lifecycle, trap expiration и контролируемый возврат к выдаче.
- Остановка на CAPTCHA и fail-closed поведение при критических ошибках persistence.
- Отсутствие внешних runtime-зависимостей и сетевого transport API; экспорты формируются локально.

### Release quality

- Regression coverage для core flow, persistence, concurrency, performance и responsive docking.
- Проверены RU/EN, browser flow, accessibility smoke и сценарии чистой установки/обновления.
