# Translating PokéCollector

Help with a few labels or a whole language. Partial translations are welcome: text that has not been translated yet stays in English.

Translate in your browser through [PokéCollector's Weblate](https://pokecollector.romerg.de/translations/projects/pokecollector/frontend/). You can also edit the translation files and open a GitHub pull request.

## Contribute through Weblate

1. Open the [Frontend translation project](https://pokecollector.romerg.de/translations/projects/pokecollector/frontend/).
2. Sign in with GitHub or register a Weblate account.
3. Choose your language and an untranslated string or wording you would like to improve. English is the reference text and cannot be edited through Weblate.
4. Translate the text, keeping placeholders such as `{name}` and `{count}` unchanged, then save.

Your translations are saved immediately. Weblate checks pending changes once an hour and sends edits that are at least one hour old to a GitHub pull request. Depending on when you save, delivery can take nearly two hours. You do not need to open a pull request yourself; later batches update the existing translation PR while it remains open.

The version bot adds the required patch version and keeps the same suitable version when more translations arrive. Automated checks run on the updated PR, but the project owner still reviews and merges it. Saving a translation does not immediately change the released application: merged translations are bundled into a release, which an installation then needs to update to use.

Weblate retains translator attribution. If you would like credit under a particular public GitHub handle, make it clear in your contribution so it can be checked before merge.

## Contribute through GitHub

1. Find your language in `frontend/src/i18n/locales/`.
2. Edit the wording in that JSON file, keeping the existing keys and nesting.
3. Keep placeholders unchanged. For example, translate `{count} cards` but leave `{count}` intact so the app can insert the number.
4. Run `npm run check:translations` from `frontend/`.
5. Update the application version using the [shared version command](VERSIONING.md) and open a focused pull request. The automatic bump applies only to the configured Weblate branch, not to manually opened translation PRs.

Use `en.json` to look up the meaning of a label. Do not fill untranslated entries with copied English text just to make a file complete. Leave the key absent to use the English fallback. Empty strings are rejected because they would hide a label instead of falling back.

Keys describe where text belongs. For example, `sets.releaseDate` is the release-date label on a set card. If the meaning is unclear, include the page or a screenshot in your PR so the wording can be reviewed in context. A glossary should keep recurring terms such as Binder, Deck, Holo and Reverse Holo consistent without changing their meaning.

Translations remain part of the repository and use its [license](../LICENSE). Existing contributor credit is retained. Translation PRs should preserve translator attribution; reviewers should also check whether a new translator needs adding to `CONTRIBUTORS.csv` without duplicating an existing credit.

## File layout and fallback

- `frontend/src/i18n/locales/en.json` is the source text.
- Other JSON files contain translations, which may be incomplete.
- The small `.js` files one directory above load that data. Edit the JSON, not those import wrappers.
- Existing language settings and lazy loading are unchanged.
- `es-mx.json` and `zh-tw.json` are independent regional catalogues.
- `pt-br` and `pt-pt` currently reuse `pt.json`; `zh-cn` reuses `zh.json`. They remain selectable but must not be imported into Weblate as duplicate translation files. The `zh` catalogue currently supplies simplified Chinese.

Adding a file alone does not add a selectable language. A new language needs an explicit loader, language-picker entry, any required locale mapping and tests. Discuss that change in an issue or PR before enabling it in Weblate.

The translation check rejects invalid JSON, duplicate keys, blank text, invalid value types and missing or unexpected `{placeholder}` names. It also checks literal translation keys in the interface against English. It does not grade translation quality or claim a language is fully translated. Some older catalogues retain legacy keys that are no longer in English; those are not silently deleted.

## Maintainer integration

The active service uses one application-interface component:

- Repository: `https://github.com/Git-Romer/pokecollector`
- Upstream branch: `main`
- Dedicated PR branch: `weblate-translations`
- File format: **JSON nested structure file** (`json-nested`), not i18next or ICU JSON
- File mask: `frontend/src/i18n/locales/*.json`
- Monolingual base file: `frontend/src/i18n/locales/en.json`
- Source language: English, with source editing disabled
- New-language creation restricted until application support has been reviewed
- **Remove blank strings** add-on (`weblate.cleanup.blank`) so untranslated JSON entries stay absent and use English fallback
- Automatic push after committing enabled, push on upstream-only updates disabled
- One-hour minimum pending age and an hourly pending-commit task
- GitHub PR delivery, with automatic merging disabled

Keep the JSON formatting, regional mappings and contributor history intact. Do not prefill missing entries with English, delete legacy keys in bulk or enable paid machine translation as part of routine synchronization. Weblate checks supplement, rather than replace, the repository's placeholder and catalogue validation.

The [version automation guide](VERSIONING.md) explains the dedicated version-writer credential, trusted-main execution, required version check and handling of later Weblate branch replacements. Only the project owner merges PRs. The live delivery, automatic version write, fresh checks and same-PR version restoration have been verified with real translation contributions.

The application ships translations in its frontend build. It makes no runtime requests to Weblate, needs no Weblate secret, and continues working if the translation service is unavailable. No new application API or collection-data access is involved.

Official references:

- [Nested JSON format](https://docs.weblate.org/en/latest/formats/json.html)
- [GitHub pull-request integration](https://docs.weblate.org/en/latest/admin/code-hosting.html)
- [Translation add-ons, including removal of blank strings](https://docs.weblate.org/en/latest/admin/addons.html)
