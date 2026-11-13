# Booth server API contract

Single Node process: HTTP API + SSE + static files. Zero dependencies. This is the source of truth for frontend code. Config files (`menu.json`, `rewards.json`, `tables.json`) are read once at boot.

## 1. Base path, pages, static files

`BASE` = env `BASE_PATH` (default `""`, production `/booth`). nginx forwards the full path unchanged, so every route below lives under `BASE`.

**The frontend learns the base path from the server.** In every served `.html`, `.js` and `.css` file the literal token `__BASE__` is replaced with `BASE` (`""` or `/booth`, never a trailing slash). Write:

```html
<script src="__BASE__/static/base.js"></script>   <!-- public/base.js is exactly: window.BASE = "__BASE__"; -->
<script src="__BASE__/static/guest.js"></script>
<link rel="stylesheet" href="__BASE__/static/guest.css">
```

and call the API as `fetch(window.BASE + '/api/...')`. Never hard-code `/booth` or an absolute `/api`. Use relative-to-BASE URLs for `EventSource` too.

| Route (prefix with BASE) | Served file in `public/` | Notes |
|---|---|---|
| `/` (and `BASE` without slash) | built-in landing text | "scan the table QR" |
| `/t/<token>` | `guest.html` | 404 page for unknown token. Sets the `booth_d` device cookie. The token is the last path segment: `location.pathname.split('/').pop()` |
| `/wait` | `wait.html` | sets `booth_d` cookie |
| `/staff` | `staff.html` | page is public; it must show a PIN form and call login |
| `/staff/qr` | `qr.html` | page is public; data comes from `GET /api/staff/tables` (needs login) |
| `/kitchen` | `kitchen.html` | page is public; data needs the staff session |
| `/board` | `board.html` | public |
| `/static/<path>` | `public/<path>` | any file under `public/` (also `guest.html` etc.). Allowed extensions: html js mjs css json svg png jpg jpeg gif webp ico woff woff2 txt mp3 ogg wav webmanifest. Dotfiles and `..` -> 404. `Cache-Control: public, max-age=60` (HTML pages: `no-cache`). Put games at e.g. `public/games/pour.js` -> `__BASE__/static/games/pour.js` |

If a page file is missing the server answers a 404 page.

Security headers on everything: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`. So: **no inline `<script>` and no inline event handlers (`onclick=` etc.) — scripts must be separate `.js` files from `__BASE__/static/`** (put `window.BASE` in `public/base.js`, loaded first). Inline `<style>`/`style=` is still allowed. No external scripts/fonts/CDNs; images may be `data:`/`blob:`.

## 2. Conventions

- All API paths are `BASE/api/...`. All bodies/responses are JSON UTF-8. Times are epoch milliseconds. Money is integer won.
- **Every POST must send `Content-Type: application/json`** (even with body `{}`), otherwise 415. Body limit 16 KB (413).
- Error response (any non-2xx): `{ "error": "<code>", "message": "<Korean text safe to show>", ...extra }`. Switch on `error`, not on `message`.
- Common errors: 400 `bad_json`, 401 `unauthorized`, 403 `bad_origin`, 404 `not_found`/`no_table`, 413 `too_large`, 415 `unsupported_media_type`, 429 rate/limit codes, 500 `internal`, 503 `busy`.
- `table` is always the table number (1..N). Table numbers are also their ids.
- Cookies (both `HttpOnly`, `SameSite=Lax`, `Path=BASE||"/"`, `Secure` when `COOKIE_SECURE=1`): `booth_d` = anonymous device id, server-signed (`<id>.<signature>`; opaque to pages — never parse or forge it; an old or invalid value is silently replaced by a new one, so after an upgrade a browser just becomes a "new" device) (set automatically on guest pages/APIs, 3 days; used for nicknames, play limits, wait list), `booth_s` = staff session (default 72 h, env `SESSION_HOURS`), `booth_k` = staff trusted-device key (30 days, set on a successful login; see login). Names are prefixed so they cannot collide with the main site's cookies; if the browser sends duplicates of a name (different Paths), the server accepts any valid `booth_s` and the first well-formed `booth_d`. `fetch` on the same origin sends them automatically; no `credentials` option needed.
- Staff POSTs are rejected with 403 `bad_origin` when `Sec-Fetch-Site` is present and not `same-origin`/`none`, or (if that header is absent) when `Origin` is present and differs from `PUBLIC_ORIGIN`/`Host`. Normal same-origin `fetch` is fine.

## 3. Shared object shapes

**Menu item**: `{ id, name, price, cat, desc, soldOut }`. **Menu** (guest view): `{ categories: string[], items: MenuItem[] }` — items and categories come in the menu's display order; **hidden items never appear**, and a category with no visible item is omitted. The menu lives in the database and staff can edit it at any time (section 6, "Menu management"): re-render from every new `state`/`GET`, never cache prices for long. `price` is a multiple of 100 won. New item ids look like `m` + 10 hex chars; items seeded from `menu.json` keep their ids.
**Staff menu view** (inside staff `state` and in every menu-management response, as `menu`): same shape but includes hidden items, each item additionally has `hidden: boolean`, `sortOrder: number`, `categoryId: number`, `inUse: boolean` (it appears in some order, so it cannot be deleted), and `categoryList: [ { id, name, sortOrder, itemCount } ]` lists every category including empty ones.

**Order**
```json
{ "id": 12, "table": 3, "seat": 1, "status": "pending|cooking|served|cancelled", "paid": false,
  "items": [ { "id": "tteokbokki", "name": "떡볶이", "qty": 2, "unitPrice": 8000 } ],
  "subtotal": 16000, "memberDiscount": 1600, "couponDiscount": 1000, "discount": 2600, "total": 13400,
  "member": true, "couponCode": "K3F9X2",
  "note": "", "createdAt": 1731480000000, "updatedAt": 1731480000000, "cookingAt": null }
```
`couponCode` is `null` when none. `total = subtotal - memberDiscount - couponDiscount` (never below 0); `discount = memberDiscount + couponDiscount` is kept for older code. `member` is true when the order was placed by a verified COMS club member (the club id is never exposed). Amounts and item names/prices are frozen when the order is created: later menu edits, renames or price changes never alter an existing order. Status flow: `pending` (waiting for staff accept) -> `cooking` -> `served`; `cancelled` is terminal.

**Coupon**
```json
{ "code": "K3F9X2", "rewardId": "d1000", "source": "score|hour", "type": "discount|item",
  "amount": 1000, "item": null, "label": "안주 1,000원 할인", "status": "issued|used",
  "table": 3, "seat": 1, "orderId": null, "usedAt": null, "createdAt": 1731480000000 }
```
`amount` is set for `discount`, `item` (string) for `item` coupons. Code alphabet has no `I O 0 1`; codes are upper-case, matching is case-insensitive.

**Game config** (`games` map in guest snapshot / `gameInfo` on board): `{ "pour": { "label", "maxScore", "minDurationMs" }, "cheers": {...} }`. Valid game ids: `pour`, `cheers`.

## 4. Guest API (`BASE/api/t/<token>/...`)

Unknown token -> 404 `no_table`. Tokens are 16 chars of `[A-Za-z0-9_-]`. A guest only ever sees the table's **current seat** (round); staff "clear table" increments the seat, so old orders/coupons/calls disappear.

### `GET /api/t/<token>` — full snapshot (also the polling fallback; poll every ~5 s)
```json
{ "table": { "number": 3, "seat": 1 },
  "orderingOpen": true,
  "memberDiscountPct": 10,                   // new: current member discount percent (0 = none); see GET .../member for whether THIS visitor is a member
  "menu": { "categories": [...], "items": [ MenuItem ] },   // hidden items are never included
  "orders": [ Order ],                       // current seat, newest first; cancelled orders: only the newest 5 are included
  "coupons": [ Coupon ],                     // current seat, oldest first
  "calls": [ { "id": 5, "type": "물", "createdAt": 0 } ],   // open staff calls
  "nick": "맥주왕",                          // this device's nickname for this seat, or null
  "rewards": [ { "id": "d1000", "game": "cheers", "label": "...", "type": "discount", "amount": 1000, "item": null,
                 "threshold": 700, "soldOut": false, "got": false } ],
  "games": { "pour": { "label": "...", "maxScore": 500, "minDurationMs": 8000 }, "cheers": {...} },
  "callTypes": ["물", "수저", "치워주세요", "기타"],
  "pay": { "bank": "", "account": "", "holder": "" } }   // env PAY_BANK/PAY_ACCOUNT/PAY_HOLDER; empty strings if unset
```
`pay` is for the payment screen: show the account, a copy button, and a bank-app deep link.

### `POST /api/t/<token>/orders`
Body `{ "key": "<8-64 chars [A-Za-z0-9_-]>", "items": [ { "id": "tteokbokki", "qty": 2 } ], "couponCode": "K3F9X2"?, "note": "덜 맵게"?, "expectedTotal": 15000? }`.
**New — `expectedTotal`** (optional integer, the total the guest saw on screen, after discounts): if it differs from the total the server computes now, the server answers **409 `price_changed`** and creates nothing. Payload: `{ error, message, expectedTotal, total, subtotal, memberDiscount, couponDiscount, items: [ { id, name, qty, unitPrice } ] }` with the fresh values. The page shows them, asks the guest to confirm, then resends with `expectedTotal` = the fresh `total`. **Nothing was created, so the client may reuse the same `key` or send a new one — both work.** Without `expectedTotal` the current price is charged as before. A non-integer value -> 400 `bad_expected_total`. Replays of an already-created key (`duplicate: true`) are answered before this check.
Generate `key` once per cart submission (`crypto.randomUUID()`), reuse it on retries. Prices sent by the client are ignored.
- 201 `{ "order": Order, "duplicate": false, "memberDiscountSkipped": "limit"?, "couponIgnored": true? }` — **`couponIgnored: true`** (new) appears when the sent `couponCode` is valid but would discount 0 won (e.g. a free item, or nothing left after the member discount): the order is created without it, `order.couponCode` is `null` and the coupon stays unused. Tell the guest the coupon was not applied and is still available. — `memberDiscountSkipped: "limit"` appears only when the guest is a member who would have got a discount but already used it on the maximum number of orders (default 20 per club member, env `MEMBER_ORDER_MAX`); the order was created at full price. Show a short notice.
- 200 `{ "order": Order, "duplicate": true }` when this table **in its current seat** already used that key (the key is scoped to table+seat: after staff clears the table the same key creates a new order; returns the original; checked before everything else, even when ordering is closed).
- 400 `bad_key`, `bad_items` (empty / malformed), `too_many_lines` (>30 lines), `bad_qty` (not integer 1..20; `id` in payload), `dup_item` (same id twice), `unknown_item` (`ids`; also returned for hidden items), `bad_note` (>100 chars), `bad_coupon` (not found / not this table+seat), `coupon_not_discount`
- 409 `closed` (ordering switched off), `sold_out` (`ids`, `names`), `coupon_used`
- 429 `too_many_pending` (10 orders waiting for acceptance at once)
- 429 `too_many_orders` (**new**: at most 40 orders per table per seat, cancelled ones included; resets when staff clears the table). Message tells the guest to ask staff.

A discount coupon is marked used together with the order; it returns to `issued` if the order is cancelled.

**Member discount (new).** Membership is decided by the server only: it forwards the visitor's club-site login cookie to the club backend (feature off unless env `COMS_ME_URL` is set). The request body is never trusted for membership (fields like `member` are ignored). For a verified member the order gets `memberDiscount = floor(subtotal * pct / 100 / 100) * 100` won (rounded DOWN to 100 won; e.g. 8,500 won at 10% = 800, at 15% = 1,200; 900 won at 10% = 0), applied to the subtotal **first**; a coupon discount is then applied to what is left; the total never goes below 0. `pct` is the staff setting (0..50, default 10). Cancelling an order restores its coupon and frees its member-discount slot.

### `GET /api/t/<token>/member`
-> `{ "enabled": boolean, "member": boolean, "pct": number }`. `enabled` is false when the feature is off (no outbound request is made then). `member` is true when the browser's club login is valid right now (cached 60 s). Only these three fields are returned: never a name, id or role. Use it to show "COMS 회원 N% 할인 적용" before ordering; the actual discount is always decided again at order time. Cheap to call; do not poll faster than every ~30 s. Not logged in / expired / banned / club server down all simply give `member: false`.
**Rules the page must know (new):** (1) a lookup needs a `booth_d` device cookie that already existed when the request arrived — the first request of a brand-new browser (which only mints the cookie) answers `member: false`; load the guest snapshot first (every guest page does), then call `/member`, and call it again once the first answer was `false` while a club login cookie is present only if you want a retry. The same applies to the member discount at order time. (2) Each device gets at most 6 uncached lookups per minute; beyond that it is simply treated as a non-member until the minute passes. (3) Only definitive answers are cached for 60 s: a valid member, or the club saying 401/403. Timeouts, 5xx, 429, redirects and unreadable answers are never cached (the next call asks again). (4) Any logged-in club account counts as a member, including the `ASSOCIATE` role. (5) A guest who logs out of the club site keeps the discount for up to 60 s (cache).

### `POST /api/t/<token>/orders/<orderId>/cancel` — body `{}`
Only own-table, current-seat, `pending` and unpaid orders. 200 `{ order }`. 404 `no_order`, 409 `not_cancellable`.

### `POST /api/t/<token>/nick` — body `{ "nick": "맥주왕" }`
Control, zero-width, bidi, Hangul-filler (U+3164, U+115F, U+1160, U+FFA0), braille-blank and lone-surrogate characters are stripped, whitespace collapsed; at least one visible character (checked after NFKC) and 1..10 characters are required; profanity blocklist. The stored nick keeps the typed form. 200 `{ "nick": "<cleaned>" }`. 400 `bad_nick`. Per device per seat. Shown on the board. **New errors:** 400 `no_device` (the request did not carry an existing valid `booth_d` cookie — a cookie minted by this very response does not count; load `GET /api/t/<token>` first, which every guest page does; after a `no_device` just retry), 429 `too_many_nicks` (30 nicknames per table seat; existing devices can still rename).

### `POST /api/t/<token>/plays/start` — body `{ "game": "pour" }`
200 `{ "playId": 41, "game": "pour", "startedAt": 0, "maxScore": 500 }`. Server records the start time. 400 `bad_game`; 429 `rate_limited` (`retryAfterMs`; max 1 start per 3 s per device **and, new, 1 start per 1 s per table seat** — friends at the same table starting together may need to retry after `retryAfterMs`), `device_limit` (200 plays per device total), `seat_limit` (**new**: 300 plays per table seat in total), `too_many_open` (**new**: 20 started-but-unfinished plays (younger than 10 min) per seat).

### `POST /api/t/<token>/plays/finish` — body `{ "playId": 41, "score": 430 }`
`score` must be an integer. Accepted once per play.
200:
```json
{ "score": 430,
  "coupons": [ Coupon ],                       // newly issued by this finish
  "rewards": [ { "rewardId": "drink", "label": "음료 1잔",
                 "result": "issued|low_score|already_got|sold_out", "coupon": Coupon /* only when issued */ } ] }
```
`rewards` lists every reward of this game so the UI can say "재고 소진" / "점수 부족" / "이미 받음".
Errors: 400 `bad_play`, 400 `bad_score` (non-integer, or outside `0..maxScore`), 400 `too_fast` (shorter than the game's `minDurationMs`), 400 `too_slow` (>10 min), 404 `no_play` (unknown play / other device / other table / seat was cleared or the table was moved away), 409 `already_finished`. A play rejected for `bad_score` (range) / `too_fast` / `too_slow` is burned: it cannot be resubmitted (further finish -> 409). Malformed values (`bad_play`, non-integer score) do not burn it. Games must therefore run at least `minDurationMs` of real time (default `pour` 8000 ms, `cheers` 10000 ms) and never exceed `maxScore` (`pour` 500 = 5 glasses x 100, `cheers` 1000 = 10 taps x 100).
Coupon rule: score >= reward `threshold`, stock left, and this table+seat has not already received that reward.

### `POST /api/t/<token>/calls` — body `{ "type": "물" }`
(**New:** 429 `too_many_calls` — at most 50 calls per table seat in total, resolved ones included.)
`type` in `물`, `수저`, `치워주세요`, `기타`. 200 `{ "call": { id, type, createdAt }, "duplicate": false }`; `duplicate: true` if the same type is already open for this table. 400 `bad_call` (`allowed`).

### `GET /api/t/<token>/events` — SSE, see section 7.

## 5. Public API

| Endpoint | Response |
|---|---|
| `GET /api/health` | `{ ok: true, time }` |
| `GET /api/menu` | `{ categories, items: [MenuItem], orderingOpen }` (hidden items excluded) |
| `GET /api/board` | board snapshot (below) |
| `GET /api/board/events` | SSE, event `state` = same JSON |

**Board snapshot**
```json
{ "hour": { "start": 1731478800000, "end": 1731482400000, "awarded": false,
            "ranking": [ { "table": 4, "score": 1650, "games": { "pour": 450, "cheers": 1200 }, "nick": "맥주왕" } ] },
  "prevHour": { "start": 0, "winner": { "table": 4, "score": 1650, "games": {}, "nick": "..." } , "awarded": true },
  "hourly": { "label": "안주 1개 서비스", "item": "안주 1개" },
  "games": { "pour": [ { "rank": 1, "table": 4, "nick": "맥주왕", "score": 450 } ], "cheers": [ ... ] },
  "gameInfo": { "pour": { "label", "maxScore", "minDurationMs" }, "cheers": {...} },
  "rewards": [ { "id": "drink", "label": "음료 1잔", "remaining": 16, "stock": 20 } ] }   // stock left per reward; only these 4 fields
```
`hour.ranking` = top 5 tables of the current clock hour (table score = sum over games of the table's best score in that hour). `prevHour.winner` is `null` if nobody played. `games.<id>` = top 10 tables by best score all event long (`nick` may be `null`; show "N번 테이블"). Hours are epoch-aligned (same as KST hours). The board SSE also refreshes every 20 s so the hour rollover appears.

### Waitlist (public, per device cookie)
- `POST /api/wait` body `{ "nick": "손님", "size": 3 }` (size 1..10) -> 201 `{ "id": 7, "secret": "<keep in localStorage>" }`. 400 `bad_nick`/`bad_size`; 429 `too_many` (3 active entries per device), 429 `wait_rate` (**new**: at most 30 registrations per minute server-wide), 503 `wait_full`. Seated/cancelled rows are deleted after 3 h.
- `GET /api/wait/<id>?secret=<secret>` -> `{ "id", "nick", "size", "status": "waiting|called|seated|cancelled", "ahead": 2, "position": 3, "waitingTotal": 9, "open": true }` (`position`/`ahead` are for `waiting`; `position` is `null` otherwise). Wrong id/secret -> 404 `no_wait`.
- `GET /api/wait/<id>/events?secret=<secret>` SSE, event `state` = same JSON as above.
- `POST /api/wait/<id>/cancel` body `{ "secret": "..." }` -> `{ ok: true }`.
- **New:** `GET /api/wait/info` (public, no secret) -> `{ "open": true, "waitingTotal": 9 }`. When staff closed the waitlist, `open` is `false`: show "지금은 대기 등록을 받지 않아요" instead of the form. `POST /api/wait` then returns **403 `wait_closed`**. The per-entry status JSON (`GET /api/wait/<id>` and its SSE `state`) also carries `"open": boolean`.
Show "입장하세요" when `status === "called"`.

## 6. Staff API (needs `booth_s` cookie; otherwise 401 `unauthorized`)

### Auth
- `POST /api/staff/login` body `{ "pin": "..." }` -> 200 `{ ok: true }` + `booth_s` cookie. 401 `bad_pin` (`attemptsLeft`). 429 `locked` (`retryAfterSec`, also `Retry-After` header): the lockout is **global** (not per IP): after 5 consecutive failures logins are refused for a **flat 60 s** (changed: no more doubling); when the lock expires the failure counter starts over at 0, and a success resets it. While locked even the right PIN is refused. Show the countdown. (`STAFF_PIN` must be >= 6 characters in production.)
  **New — `booth_k`:** the first successful login also sets a long-lived `booth_k` cookie. A login request that carries a valid `booth_k` is exempt from the global lock (it is neither refused with 429 nor counted toward it) but must still send the right PIN: a wrong PIN returns 401 `bad_pin` with `attemptsLeft` counted for that key, and the 5th consecutive wrong PIN revokes the key (cookie cleared, back to the normal global rule). Logout keeps `booth_k`. The UI needs no change beyond handling 401/429 as before; staff should log in once on each staff device before the event.
- `POST /api/staff/logout` -> `{ ok: true }`.
- `GET /api/staff/me` -> `{ ok: true }` or 401. Use on page load to choose login form vs board.

### `GET /api/staff/state` — full snapshot (same JSON as SSE `state` on `/api/staff/events`)
```json
{ "orderingOpen": true,
  "waitOpen": true,               // new: waitlist registrations open
  "orders": [ Order ],            // all orders of every table's CURRENT seat, oldest first (id asc); cancelled orders only for 10 minutes after cancelling
  "tables": [ { "number": 1, "seat": 1, "status": "empty|occupied", "orderCount": 2, "unpaidTotal": 17000,
                "minutesSeated": 42, "openCalls": 1 } ],     // minutesSeated null when empty; unpaidTotal ignores cancelled
  "calls": [ { "id": 5, "table": 3, "type": "물", "createdAt": 0 } ],
  "waitlist": [ { "id": 7, "nick": "손님", "size": 3, "status": "waiting|called", "createdAt": 0, "calledAt": null } ],
  "coupons": [ Coupon ],          // issued-but-unused coupons of current seats, newest first
  "rewards": [ { "id", "game", "label", "type", "amount", "item", "threshold", "stock": 20, "issued": 4, "remaining": 16 } ],
  "hourly": { "label": "안주 1개 서비스", "item": "..." },
  "hour":     { "start", "end", "ranking": [...], "top": { "table", "score", "games", "nick" } | null, "awarded": false },
  "prevHour": { same shape for the previous clock hour },
  "memberDiscountPct": 10,        // new
  "memberEnabled": true,          // new: true when the server has COMS_ME_URL set (member discount feature on); hide member-discount UI when false
  "menu": { "categories": [...], "items": [ MenuItem + hidden, sortOrder, categoryId, inUse ], "categoryList": [ { "id", "name", "sortOrder", "itemCount" } ] } }   // staff menu view: includes hidden items
```
Clearing a table makes its orders vanish from `orders` (they stay in sales). A table is `occupied` if its current seat has any non-cancelled order or any game started.

### Order actions
- `POST /api/staff/orders/<id>/status` body `{ "status": "pending|cooking|served|cancelled" }` -> `{ order }`. Any change between the first three is allowed (undo a mis-tap); accept = `cooking`, done = `served`. `cancelled` restores an applied discount coupon and is terminal (409 `order_cancelled` afterwards). 400 `bad_status`, 404 `no_order`.
- `POST /api/staff/orders/<id>/paid` body `{ "paid": true }` -> `{ order }`. (Cancelling a paid order keeps `paid: true`; staff refunds manually.)

### Menu management (new)
The menu is stored in the database. On the very first boot (empty menu tables, also when upgrading an older database) it is seeded once from `menu.json` and a `menu_seeded` flag is stored; after that the database is the source of truth and `menu.json` is never read again — not even if staff later delete every item and category, and not after a reset. All endpoints below need the staff session, same-origin and JSON; success responses are `{ ok: true, menu: <staff menu view>, item?: <staff item>, category?: { id, name } }` (re-render from `menu`). Every edit is pushed over SSE to guests and staff.
Rules: item `name` 1..30 characters after control/invisible-character stripping (zero-width, bidi, Hangul fillers) and trimming, must contain at least one visible character (else 400 `bad_name`), stored exactly as typed (trimmed, inner whitespace collapsed), and unique among all items **on a normalised key** (NFKC, collapsed whitespace, case-insensitive: "Beer", "beer" and fullwidth "Ｂｅｅｒ" are the same name -> 409 `name_taken`; same rule for category names, and an item sent with `category: "dessert"` goes into the existing "Dessert" category); `price` integer 0..1,000,000 and a **multiple of 100**; `desc` 0..60 characters; category name 1..12 characters, unique; at most **100 items** and **12 categories**. Hidden items are not shown to guests and cannot be ordered (400 `unknown_item`, same as a nonexistent id); sold-out items are shown greyed and cannot be ordered (409 `sold_out`).
- `POST /api/staff/menu/items` body `{ "name", "price", "category": "안주", "desc"?: "", "hidden"?: false }` (**new `hidden`**: create an item already hidden so guests never see it; non-boolean -> 400 `bad_hidden`) -> `{ ok, item, menu }`. `category` is a category NAME; it is created if missing. 400 `bad_name` / `bad_price` / `bad_desc` / `bad_category`, 409 `name_taken` / `too_many_items` / `too_many_categories`.
- `POST /api/staff/menu/items/<id>` body: any of `{ "name", "price", "category" (name), "desc", "hidden": boolean, "sortOrder": integer 0..100000 }` -> `{ ok, item, menu }`. 400 `nothing_to_update` (empty body), `bad_hidden`, `bad_sort` and the validation codes above, 404 `no_item`, 409 `name_taken` / `too_many_categories`. Moving an item to another category never deletes the old category.
- `POST /api/staff/menu/items/<id>/delete` body `{}` -> `{ ok, menu }`. **409 `in_use`** when the item was ever ordered since the last reset: hide it instead. 404 `no_item`.
- `POST /api/staff/menu/reorder` body `{ "items"?: [ "<itemId>", ... ], "categories"?: [ <categoryId>, ... ] }` -> `{ ok, menu }`. Each listed id's `sortOrder` becomes its index in the list (send the complete list in the desired order; guests see categories in category order and items by sort order within their category). 400 `bad_reorder` (not a list / duplicates / non-ids), 404 `no_item` (unknown id).
- `POST /api/staff/menu/categories` body `{ "name" }` -> `{ ok, category: { id, name }, menu }`. 400 `bad_category`, 409 `name_taken` / `too_many_categories`.
- `POST /api/staff/menu/categories/<id>` body `{ "name" }` (rename) -> `{ ok, category, menu }`. 404 `no_category`, 409 `name_taken`.
- `POST /api/staff/menu/categories/<id>/delete` body `{}` -> `{ ok, menu }`. **409 `category_not_empty`** while it still holds items (hidden ones count); 404 `no_category`. Empty categories are not removed automatically (staff delete them), but guests never see a category without visible items.
- Existing `POST /api/staff/menu/<itemId>/soldout` now returns the staff menu view in `menu`.

### Member discount setting (new)
- `POST /api/staff/member-discount` body `{ "pct": 10 }` (integer 0..50; 0 turns the discount off) -> `{ ok, pct }`. 400 `bad_pct`. Current value: `memberDiscountPct` in staff state and in the guest snapshot. It is a setting: it survives `reset`.

### Menu / ordering switch
- `POST /api/staff/menu/<itemId>/soldout` body `{ "soldOut": true }` -> `{ ok, menu }`. 404 `no_item`.
- `POST /api/staff/ordering` body `{ "open": false }` -> `{ ok, orderingOpen }`. Games keep working when closed.

### Coupons / rewards
- `POST /api/staff/coupons/redeem` body `{ "code": "K3F9X2" }` -> `{ coupon }` where `coupon` is a Coupon (now `used`) plus `stale: boolean` (true when it belongs to a table's previous seat; staff decides). 404 `no_coupon`, 409 `already_used` (`usedAt`, `orderId`). Works for both types; discount coupons normally get used by the guest at ordering.
- `POST /api/staff/award-hour` body `{}` or `{ "hourStart": <epoch ms of an earlier/current hour start> }` -> `{ coupon, table, score, hourStart }`: issues an `item` coupon (label `hourly.label`) to the top table of that hour, in its current seat. 404 `no_ranking`, 409 `already_awarded` (once per hour), 400 `bad_hour`.
- `POST /api/staff/rewards/<rewardId>/stock` body `{ "stock": 30 }` (total stock, not remaining; `issued` is kept) -> `{ ok }`. 400 `bad_stock`, 400 `stock_below_issued` (**new**, `issued` in payload: a value below the number already issued is refused), 404 `no_reward`.

### Tables
- `POST /api/staff/tables/<n>/clear` body `{}` or `{ "force": true }` -> `{ ok, table, seat }`: seat+1, guests' orders/coupons/nicknames/calls for that table disappear, open calls resolved.
  **New:** if the current seat still has non-cancelled orders that are unpaid or not yet served (`pending`/`cooking`) and the body does not contain the literal `"force": true`, nothing happens and the server answers **409** `{ "error": "unsettled", "message": "...", "unpaid": <count of unpaid non-cancelled orders>, "unserved": <count of pending/cooking non-cancelled orders>, "unpaidTotal": <won> }`. The staff UI shows a confirm with those numbers and, if staff agrees, resends the same request with `{ "force": true }`.
- `POST /api/staff/tables/move` body `{ "from": 3, "to": 7 }` -> `{ orders, coupons, plays, fromSeat }` (counts moved; `fromSeat` = the source table's new seat). Moved orders get their idempotency key rewritten (`<key>~m<id>`), so equal keys in both seats can no longer make the move fail (500). Moves the current-seat orders, coupons and plays of `from` into `to`'s current seat (merging if `to` is occupied). **New:** the source table `from` also starts a new seat (seat+1) and its open calls are resolved, exactly like a clear; guests still on `from` see an empty table and in-flight plays there can no longer finish (404 `no_play`). **New:** the source table's guest streams receive a `cleared` hint (`{ seat: fromSeat }`), like a clear. 400 `bad_tables`, 404 `no_table`.
- `GET /api/staff/tables` -> `{ tables: [ { number, token, url } ], waitUrl, origin, base }` for the QR page. `url` = `PUBLIC_ORIGIN + BASE + "/t/" + token` (just `BASE/t/<token>` when `PUBLIC_ORIGIN` is unset: then prefix `location.origin` yourself). `waitUrl` likewise. Generate the QR image client-side.
- `POST /api/staff/calls/<id>/resolve` body `{}` -> `{ ok }`. 404 `no_call`.

### Waitlist
- **New:** `POST /api/staff/waitlist/open` body `{ "open": false }` (boolean required, else 400 `bad_open`) -> `{ ok, waitOpen }`. Closing makes `POST /api/wait` answer 403 `wait_closed`; existing entries stay. State is `waitOpen` in the staff state and `open` in `GET /api/wait/info`. A reset re-opens it.
- **New:** `POST /api/staff/waitlist/clear` body `{}` -> `{ ok, cancelled }`: sets every `waiting`/`called` entry to `cancelled` (guests see `status: "cancelled"`). Use it to flush junk entries.
- `POST /api/staff/wait/<id>/call` | `/seat` | `/cancel` body `{}` -> `{ ok }`. 404 `no_wait`, 409 `wait_closed`. `call` sets status `called` (guest sees "입장하세요"); `seat`/`cancel` remove it from the staff list.

### Sales
- `GET /api/staff/sales` ->
```json
{ "totals": { "orders": 40, "revenue": 380000, "discount": 5000, "memberDiscount": 3200, "memberOrders": 11, "paidRevenue": 350000, "unpaidRevenue": 30000 },
  "byHour": [ { "hour": 1731478800000, "label": "2026-11-13 18:00", "orders": 12, "revenue": 90000, "discount": 1000 } ],
  "byItem": [ { "id", "name", "qty", "gross" } ],
  "coupons": [ { "rewardId": "d1000|hour", "label", "type", "issued", "used" } ] }
```
Cancelled orders are excluded; covers every seat since the last reset. `label` is KST. `discount` = member discount + coupon discount; `memberDiscount` = won given as member discount, `memberOrders` = number of orders that got one. `revenue` is after all discounts. `byItem.name` is the name recorded on the most recent order of that item id. The CSV summary row gained two columns: 회원할인액, 회원할인 건수.
- `GET /api/staff/sales.csv` -> `text/csv; charset=utf-8` attachment `booth-sales.csv`, starts with a UTF-8 BOM, sections: 요약, 시간대별 매출, 메뉴별 판매, 쿠폰. Use a plain link / `location.href`, it is a normal GET with the cookie.
- `POST /api/staff/reset` body `{ "confirm": "초기화" }` -> `{ ok }`. Wipes orders, coupons, plays, nicknames, calls, waitlist, sold-out flags (the flags only: **the menu itself — items, prices, hidden flags, categories — and the member-discount percent are kept**), resets seats to 1, ordering open, reward stock to `rewards.json` values. Table tokens are kept. A backup copy is taken right before the wipe (the server first waits for any backup already running, then takes its own). 400 `confirm_required`.

### Kitchen (same staff session)
`GET /api/kitchen` ->
```json
{ "items": [ { "id": "tteokbokki", "name": "떡볶이", "qty": 3 } ],        // sum over cooking orders, qty desc
  "orders": [ { "id": 12, "table": 3, "member": false, "note": "", "items": [ { "id", "name", "qty" } ], "since": 1731480000000 } ] }   // cooking orders, oldest first
```
`GET /api/kitchen/events` SSE `state` = same JSON. Orders leave the kitchen view when set to `served`/`cancelled` or when the table is cleared.

## 7. Realtime (SSE)

Endpoints (all `GET`, `text/event-stream`):

| Endpoint | Auth | Channel |
|---|---|---|
| `/api/t/<token>/events` | token | that table (+ this device's nick) |
| `/api/staff/events` | staff | staff |
| `/api/kitchen/events` | staff | kitchen |
| `/api/board/events` | none | board |
| `/api/wait/<id>/events?secret=` | secret | one waitlist entry |

Each connection starts with `retry: 3000`, then an immediate `state` event, then another `state` whenever the snapshot changes (changes are coalesced ~120 ms; identical snapshots are not re-sent). `: hb` comment every 20 s. Headers: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.

**`event: state`** — `data:` is the full JSON of the matching GET endpoint: guest = `GET /api/t/<token>`, staff = `GET /api/staff/state`, kitchen = `GET /api/kitchen`, board = `GET /api/board`, wait = `GET /api/wait/<id>`. Frontends can render purely from `state` events.

**Hint events** (small, immediate, optional; use for sounds/flash). The same data also arrives in the next `state`:

| Event | Channel | Data |
|---|---|---|
| `new_order` | staff | `{ id, table }` |
| `new_call` | staff | `{ id, table, type }` |
| `new_wait` | staff | `{ id }` |
| `new_cooking` | kitchen | `{ id, table }` — an order just became `cooking` |
| `order_status` | guest | `{ id, status }` |
| `cleared` | guest | `{ seat }` — staff cleared this table or moved it away; state already shows empty lists |

Use native `EventSource` (auto-reconnects with the `retry:` delay; cookies are sent). Pattern: open `EventSource`, on `error` also start a 5 s poll of the matching GET endpoint until `open` fires again. **Connection limits.** When a limit is exceeded the server **closes the oldest stream** (so `EventSource` silently reconnects after its `retry:` delay) instead of rejecting the new one: max 5 streams per device cookie, max **12 per guest table**, max **20** on `/api/board/events`, max **60** on wait streams. Guest + board + wait streams together are capped at **300** (503 `busy` beyond that); staff + kitchen streams have their own pool of 100 (oldest closed), so public traffic cannot take their slots. Cookie rules: a guest stream always has a device (the server mints `booth_d` on the first guest request); board/wait streams without a valid `booth_d` all share one bucket per channel type, so a cookie-less client can only hold 5 of them. **Slow readers:** state events are full snapshots, so a stream that cannot keep up simply receives the latest snapshot when it drains (intermediate states are skipped); a public stream with more than 64 KB of unsent data is dropped (it reconnects). Hint events may be skipped for a slow reader. Do not open more than one stream per page, and close it (`es.close()`) on page hide/unload.

## 8. Behaviour notes the frontends must respect

1. A cleared table's guests keep the same URL; after `cleared` the page should show an empty state ("새 손님을 환영해요") and reset local cart/nickname.
2. Guests identify only by cookie `booth_d`; if the user blocks cookies, nickname/plays/wait will not work. Show a hint on 4xx from `plays/start`.
3. Orders need staff acceptance: after 201 show "접수 대기"; staff moves it to `cooking`, then `served`. `paid` is independent (staff sets after confirming the transfer).
4. Item coupons (`type: "item"`) cannot be applied to orders (`coupon_not_discount`); the guest shows the 6-char code full screen for staff to redeem.
5. Sold-out/open-close/clear changes reach guests through the `state` event; cart lines for a sold-out item should be greyed out and the 409 `sold_out` response (`ids`) used to highlight them.
6. Display `message` strings from errors directly; they are Korean and end-user safe.
7. **Storage ceiling (new).** The database has a hard 256 MB size limit. When it is reached every write answers **503 `storage_full`** (reads keep working). Show the Korean `message`; staff must be told (they can export the CSV and reset). Not expected in normal use.
8. **Board caching (new).** `GET /api/board` (and the board `state`) may be up to 1.5 s old; any play result, nickname, award, stock change, clear, move or reset refreshes it immediately.
