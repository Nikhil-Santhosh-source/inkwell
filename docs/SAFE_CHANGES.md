# Changing Inkwell safely

How to change the code or the look of Inkwell without breaking the app on
your iPad or losing notes.

## Where things live

| What | Where | Touched by a code change? |
|---|---|---|
| The code (this folder) | Your PC, with history in Git | Yes |
| The published app | The hosting site (https address) | Only when you publish |
| Your notes | Inside the installed app on your iPad | **No** |

Your notes never leave the iPad, so changing or publishing code can't delete
them. The only code that could harm them is code that changes **how notes are
stored** (see "Changing how notes are saved" below).

## The routine

1. **Try it on the PC first.** Run `npm start` and open the address it prints
   (or open it on the iPad over the PC's hotspot). This development copy has
   its own separate storage, so experiments there never touch the notes in
   your installed app.
2. **Run the checks.** `npm test` must pass. The publish step runs the same
   checks and refuses to publish if any fail.
3. **Bump the version.** Change `VERSION` in `app/sw.js` and `APP_VERSION` in
   `app/src/version.js` to the same new number (e.g. 1.0.0 → 1.1.0).
4. **Save it in Git** (commit), then **publish** (push). The hosting site
   builds and publishes the new version.
5. **On the iPad**, the app shows "A new version of Inkwell is ready."
   Nothing changes until you tap **Update**. If you're in the middle of
   something, tap **Later**.

## If an update goes wrong

- Every published version is a commit in Git. Revert the bad commit and
  publish again; the app offers the fixed version as the next update.
- Your notes are untouched by this either way.

## Back up

The library shows a reminder when you haven't backed up for a week. Back up
before any update that changes how notes are saved, and whenever you have
important notes. Backups are a single `.json` file; save it to Files or iCloud
Drive. **Restore** adds notebooks alongside existing ones and never
overwrites.

## Changing how notes are saved (be careful)

Notes are stored in IndexedDB on the iPad (`app/src/storage.js`,
`app/src/model.js`). Rules:

- **Adding** an optional field (e.g. a new stroke setting with a sensible
  default when it's missing) is safe. Older notes simply don't have it.
- **Never rename or remove** a field that saved notes use, and never change
  what an existing field means. Old notes would be read wrongly.
- If the format really must change: increase `SCHEMA_VERSION` in
  `model.js`, write code that converts old records when they're read, and add
  a test that loads an old-format record and checks the result. Back up
  before publishing.
- New object stores need `DB_VERSION` raised in `storage.js`; existing stores
  are kept by the upgrade code.

The tests in `tests/` check saving, loading, undo, backup/restore and the
offline file list. Add a test with each change.
