# Установка и обновление

Основной документированный сценарий — настольный Google Chrome с актуальным Tampermonkey. Другие userscript managers и мобильные браузеры в текущую test matrix не входят.

## 1. Установите Tampermonkey

Установите расширение с [официальной страницы Tampermonkey](https://www.tampermonkey.net/) и убедитесь, что оно включено в Chrome.

Для Tampermonkey 5.3+ в Chromium требуется отдельное разрешение User Scripts API. Порядок зависит от версии браузера:

- **Chrome 138 и новее:** откройте `chrome://extensions`, найдите Tampermonkey, нажмите **Details / Сведения** и включите **Allow User Scripts / Разрешить пользовательские скрипты**;
- **Chrome до 138 и старые Chromium-сборки:** на странице `chrome://extensions` включите общий **Developer mode / Режим разработчика**.

Эта разница описана в [документации Chrome User Scripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts#enable-usage-of-the-userscripts-api) и [Tampermonkey FAQ Q209](https://www.tampermonkey.net/faq.php?locale=en&q=Q209). В Chrome 138+ включать Developer mode только ради Tampermonkey не требуется.

## 2. Проверьте Site access

Откройте **Details / Сведения** Tampermonkey. Для самого простого и предсказуемого варианта выберите **On all sites / На всех сайтах**. Это позволяет менеджеру запускать установленные userscripts на их `@match`-адресах и проверять update URL.

Если вы намеренно используете **On specific sites**, разрешите как минимум домены hh.ru, указанные в metadata, и `raw.githubusercontent.com` для установки/обновлений. Ограниченный Site access может блокировать update checks; это отдельно отмечено в [Tampermonkey FAQ Q306](https://www.tampermonkey.net/faq.php?locale=en&q=Q306).

Широкое разрешение относится к расширению Tampermonkey. Сам HH Apply Assistant ограничен тремя группами `@match`, работает с `@grant none` и не содержит внешнего runtime transport.

## 3. Установите userscript

Откройте ссылку:

**[Установить HH Apply Assistant](https://raw.githubusercontent.com/tgeruzov/hh-auto-responder/main/hh-apply-assistant.user.js)**

Tampermonkey должен показать страницу установки с именем **HH Apply Assistant v4.0.0**. Просмотрите metadata и нажмите **Install / Установить**. Установка raw-файла с окончанием `.user.js` является штатным способом Tampermonkey; см. [FAQ Q102](https://www.tampermonkey.net/faq.php?locale=en&q=Q102).

Если вместо окна Tampermonkey браузер показывает исходный текст:

1. проверьте, что расширение включено;
2. включите Allow User Scripts или Developer mode по инструкции выше;
3. повторно откройте install URL;
4. при необходимости используйте ручной способ из следующего раздела.

## 4. Проверьте запуск

1. Войдите в hh.ru.
2. Откройте `https://hh.ru/search/vacancy` с нужными фильтрами.
3. Обновите страницу после установки.
4. Справа должна появиться панель **HH Apply Assistant**. На узком окне виден свёрнутый переключатель, который открывает overlay.
5. Откройте **Диагностика** и запустите Healthcheck. Отсутствующий элемент формы вне открытой формы может быть помечен как неприменимый; ошибка обязательного селектора на текущей странице требует проверки.

Metadata запускает скрипт только на:

- `*://*.hh.ru/search/vacancy*`;
- `*://*.hh.ru/vacancy/*`;
- `*://*.hh.ru/applicant/vacancy_response*`.

На главной странице hh.ru, в списке избранного или на другом пути панель не обязана появляться.

## Ручная установка

Этот способ полезен для development-копии или если raw URL не перехватывается:

1. Откройте Tampermonkey Dashboard.
2. Создайте новый script.
3. Откройте [hh-apply-assistant.user.js](../hh-apply-assistant.user.js), скопируйте файл целиком и замените шаблон редактора.
4. Сохраните (`Ctrl+S`) и включите запись.
5. Обновите поддерживаемую страницу hh.ru.

Не держите одновременно две включённые копии с разными именами: singleton защищает один document от повторной инъекции текущего runtime, но две независимо изменённые копии затрудняют диагностику и обновление.

## Обновление

Metadata содержит:

- `@updateURL` для проверки доступной версии;
- `@downloadURL` для загрузки обновления;
- `@version`, по которому Tampermonkey сравнивает версии.

Tampermonkey выполняет update checks по собственному расписанию и настройкам. Для ручной проверки используйте функцию проверки обновлений в Dashboard либо снова откройте install URL. Если обновление не находится, сначала проверьте Site access к `raw.githubusercontent.com`.

Обновление файла в рамках namespace v4 не удаляет настройки или очередь. Если будущий релиз изменит storage namespace или migration policy, это будет указано в changelog и release notes.

## Удаление

Удалите HH Apply Assistant в Tampermonkey Dashboard. Browser storage на hh.ru может остаться после удаления userscript. Способы выборочной очистки приведены в [storage-документации](storage.md#очистка).
