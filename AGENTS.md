# Agent Instructions

## Bible import control is a permanent product surface

The app must always provide a visible **Import Bible Translation** button in
`User Preferences > Bible`. Do not remove it, hide it behind an experimental
flag, or replace it with an unreachable import tab.

Keep the shared `src/components/Bible/BibleImportButton.jsx` control wired into
both:

- `src/components/UserPreferencesModal.jsx`
- `src/components/Bible/BibleControlPanel.jsx`

The control must continue to accept `.xml` and `.json` files, parse supported
Bible formats, persist imported translations through `BibleStore`, select the
imported translation, and show success or failure feedback. Any refactor that
touches either surface must retain the button and the regression coverage in
`src/components/Bible/__tests__/BibleImportButton.test.jsx` and
`tests/UserPreferencesModal.test.jsx`.

## Sermon Assist code belongs directly in the app

Everything we control for Sermon Assist must live in this desktop app: `src/`,
`main/`, `shared/`, `speech-engine/`, `tests/` and `docs/`. Do not create an
external plugin project, a separate installer, or a zip of loose executables
that a volunteer has to unzip, locate, copy, configure or run by hand. The app
owns the whole setup in one in-app action, including probing the machine,
verifying downloads, and selecting a model. Runtime assets may be downloaded
and checked by the app, but the code and the orchestration stay in this repo.
No setup step may assume the volunteer knows what an executable, a model file,
a driver or a checksum is. Any agent working on Sermon Assist follows this rule
and does not merge its own work.
