# Translating PokéCollector

Help with a few labels or a whole language. Partial translations are welcome: text that has not been translated yet stays in English.

Hosted Weblate is the selected platform for browser-based contributions. The project has not been connected yet. Until a verified translation-project link is published here, use a GitHub pull request. No Weblate account is needed for that route.

## Contribute through GitHub

1. Find your language in `frontend/src/i18n/locales/`.
2. Edit the wording in that JSON file, keeping the existing keys and nesting.
3. Keep placeholders unchanged. For example, translate `{count} cards` but leave `{count}` intact so the app can insert the number.
4. Run `npm run check:translations` from `frontend/` and open a focused pull request.

Use `en.json` to look up the meaning of a label. Do not fill untranslated entries with copied English text just to make a file complete. Leave the key absent to use the English fallback. Empty strings are rejected because they would hide a label instead of falling back.

Keys describe where text belongs. For example, `sets.releaseDate` is the release-date label on a set card. If the meaning is unclear, include the page or a screenshot in your PR so the wording can be reviewed in context. A glossary should keep recurring terms such as Binder, Deck, Holo and Reverse Holo consistent without changing their meaning.

Translations remain part of the repository and use its [license](../LICENSE). Existing contributor credit is retained during migration. Translation PRs should preserve translator attribution; reviewers should also check whether a new translator needs adding to `CONTRIBUTORS.csv`. If you would like credit under a particular public GitHub handle, include it in the contribution.

## File layout and fallback

- `frontend/src/i18n/locales/en.json` is the source text.
- Other JSON files contain translations, which may be incomplete.
- The small `.js` files one directory above load that data. Edit the JSON, not those import wrappers.
- Existing language settings and lazy loading are unchanged.
- `es-mx.json` and `zh-tw.json` are independent regional catalogues.
- `pt-br` and `pt-pt` currently reuse `pt.json`; `zh-cn` reuses `zh.json`. They remain selectable but should not be imported into Weblate as duplicate translation files. The `zh` catalogue currently supplies simplified Chinese.

Adding a file alone does not add a selectable language. A new language needs an explicit loader, language-picker entry, any required locale mapping and tests. Discuss that change in an issue or PR before enabling it in Weblate.

The translation check rejects invalid JSON, duplicate keys, blank text, invalid value types and missing or unexpected `{placeholder}` names. It also checks literal translation keys in the interface against English. It does not grade translation quality or claim a language is fully translated. Some older catalogues retain legacy keys that are no longer in English; this migration preserves them rather than silently deleting contributor text.

## Maintainer setup for Hosted Weblate

This is the intended setup, not a claim that hosting or repository access is active. The project owner must request and receive hosting approval and authorize the GitHub integration. Do not start a paid plan automatically if free hosting is unavailable.

Use one application-interface component:

- Repository: `https://github.com/Git-Romer/pokecollector`
- Upstream branch: `main`
- File format: **JSON nested structure file** (`json-nested`), not i18next or ICU JSON
- File mask: `frontend/src/i18n/locales/*.json`
- Monolingual base file: `frontend/src/i18n/locales/en.json`
- Source language: English
- Template for new translations: empty
- Import existing translations and retain their history and attribution.
- Verify language mapping before enabling synchronization, especially `es-mx`, `zh-tw` and the simplified-Chinese `zh` file. Do not create duplicate files for the three aliases above.
- Restrict new-language creation until the corresponding application support has been reviewed.
- Enable Weblate's **Remove blank strings** add-on (`weblate.cleanup.blank`) so untranslated JSON entries stay absent and use English fallback. Do not prefill missing entries with English or enable automatic cleanup of legacy keys during initial import.
- Check placeholders in Weblate where supported; repository validation remains the required safeguard for this app's single-brace placeholders.
- Use GitHub pull-request integration, not direct pushes to `main`. Prefer a dedicated translation branch with batched updates. Grant only the repository access the chosen integration requires.
- Keep automatic merging disabled. Translation PRs must run the normal checks and receive human review; only the project owner merges.
- Do not enable paid machine translation, external AI services or automatic source-text edits as part of setup.

Before publishing the contributor link, verify an actual round trip: import the existing files, change a harmless label through Weblate, receive a PR on the intended branch, run checks, inspect the file diff and translator credit, and confirm that no unrelated files or source strings changed. Review the initial import for empty entries, rewritten keys, regional mappings and unexpected formatting churn. Do not merge a smoke-test change automatically.

After that verification, replace the pending-status paragraph at the top with the actual project link and add the same link to the repository's contributor entry points. Do not publish a guessed project URL or a badge for a project that does not exist yet.

The application ships translations in its frontend build. It makes no runtime requests to Weblate, needs no Weblate secret, and continues working if the translation service is unavailable. No new application API or collection-data access is involved.

Official references:

- [Hosted Weblate and libre-project hosting](https://weblate.org/en/hosting/)
- [Nested JSON format](https://docs.weblate.org/en/latest/formats/json.html)
- [GitHub pull-request integration](https://docs.weblate.org/en/latest/admin/code-hosting.html)
- [Translation add-ons, including removal of blank strings](https://docs.weblate.org/en/latest/admin/addons.html)
