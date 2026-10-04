# Password blocklists (security review #12)

Read offline by `geotandem.auth.password_policy`; no external service is asked.

- `common-passwords.txt`: 10 000 common passwords, one per line, as provided
  for the project on 2026-10-04 (SHA-256
  `4adb3f0afb4a10cf19ebe48d8c69a46f934bbc8d77c694c210564f9583e7f4ba`).
  Believed to be SecLists' `Passwords/Common-Credentials/10k-most-common.txt`
  (danielmiessler/SecLists, MIT License), compiled by Mark Burnett.
- `german-passwords.txt`: compiled by hand for this project: common German
  passwords, Swiss places and brands, and words of this application. Umlauts
  as ae, oe, ue (the check folds them the same way).

The check compares a normalized form of the password with these entries, so
an entry also blocks its variants: `P@ssw0rd2024!` is `password`.
