# Lolz — Фильтр раздач

> Userscript для Tampermonkey / Greasemonkey. Фильтрует темы на **lolz.live / lolz.guru / zelenka.guru** на основе официального API — скрывает ненужные раздачи по гибким правилам.

---

## Установка

### 1. Установи Tampermonkey

| Браузер | Ссылка |
|---|---|
| Chrome / Edge / Brave | [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/) |
| Safari | [App Store](https://apps.apple.com/app/tampermonkey/id1482490089) |

### 2. Установи скрипт

Нажми на ссылку ниже — Tampermonkey автоматически откроет диалог установки:

**[→ Установить скрипт (lolz-filter.user.js)](https://raw.githubusercontent.com/FTPLabs/Lolzhide/main/lolz-filter.user.js)**

Нажми **«Install»** / **«Установить»** в появившемся окне.

### 3. Получи API токен

1. Войди на [lolz.live](https://lolz.live)
2. Перейди в **Настройки → API** (прямая ссылка: `lolz.live/account/api`)
3. Создай новый токен — скопируй его

### 4. Введи токен в скрипт

1. Открой любой раздел с раздачами, например [lolz.live/forums/840/](https://lolz.live/forums/840/)
2. На панели скрипта нажми **⚙**
3. Вставь токен в поле «API токен»
4. Нажми **«📡 Проверить токен»** — скрипт подтянет твой username и group_id
5. Нажми **«💾 Сохранить»**

---

## Что умеет

| Фильтр | Условие скрытия |
|---|---|
| 🚫 **Нет ответа** | `permissions.reply = false` — КД, лимит постов, закрытые темы |
| 🔒 **Закрыта** | `thread_is_closed = true` — все закрытые |
| 👥 **Группа** | `thread_reply_group_id > 0` и твоя группа ниже требуемой |
| ✅ **Участвовал** | `contest.already_participate = true` |
| 🏁 **Завершена** | `contest.is_finished > 0` |
| ⛔ **Нельзя участв.** | `contest.permissions.can_participate = false` |
| 🔤 **Ключевые слова** | Название содержит одно из заданных слов (напр. `кд, cooldown`) |
| 👁 **Peek-режим** | Вместо скрытия — затемняет тему (opacity 12%) |

Дополнительно:
- **↺** — принудительное обновление без перезагрузки страницы
- **⚙ → 🔎 Проверить тред** — покажет все поля API для конкретной темы и объяснит почему она видима/скрыта
- **📤 Экспорт / 📥 Импорт** — перенос настроек между браузерами
- **🔍 Диагностика** — показывает DOM-структуру и данные из кэша

---

## Технические детали

- **Язык:** JavaScript (ES2020+, без зависимостей)
- **Платформа:** Tampermonkey / Greasemonkey
- **API:** `prod-api.lolz.live` — официальный API Lolzteam
- **Поддержка:** XenForo 1 (lolz.live) и XenForo 2
- **Кэш:** `sessionStorage`, TTL 5 минут
- **Rate limit:** очередь 220 мс между запросами + exponential backoff retry при 429/5xx
- **Безопасность:** обработка 401/403, экранирование HTML, токен не отображается в полях формы

---

## Группы пользователей (lolz.live)

| ID | Название |
|---|---|
| 21 | Local |
| 22 | Resident |
| 23 | Expert |
| 60 | Guru |
| 351 | AI |

---

## Автор

**FTPDev** — [lolz.live/ftpdev](https://lolz.live/ftpdev)
