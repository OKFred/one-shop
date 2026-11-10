# Customer event payload compatibility for EverShop 2.2.1

This core backport follows upstream fix [8c017e4](https://github.com/evershopcommerce/evershop/commit/8c017e46843d4f11b7d0111a3eb18c4fd2ed5cbe). Customer events carry the customer row without `password`. The service's returned customer and existing insertion/creation hooks retain their 2.2.1 contracts. Subscribers must not depend on receiving a password hash.

Customer migration `1.0.5` is the next migration after this branch's `1.0.4`. It replaces the existing created/updated/deleted event functions with the upstream `to_jsonb(NEW/OLD) - 'password'` projection. Existing trigger identities, event names and all other row fields remain. It does not import upstream `1.0.7` or any intervening feature migrations.

The registration service removes the field only from `customer_registered` and `account_created` payloads. Its existing transaction handling, event call arguments, returned row and hooks are unchanged. The welcome subscriber also removes a password field from older queued events before passing the customer to either welcome-email registry hook or the template. The notification enabled guard, locale and template selection remain unchanged.

The migration changes future trigger output. It does not scrub historical event rows, logs or backups, reset passwords, enable notifications, or perform an EverShop upgrade. Applying it requires a separate reviewed deployment, current backups and rehearsal against an isolated restored copy. Unit tests use mocked database/event/mail boundaries and synthetic data; their SQL assertions do not establish PostgreSQL execution or production acceptance.
