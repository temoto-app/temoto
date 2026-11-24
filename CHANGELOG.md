# Changelog

All notable changes to Temoto (called aios before 0.92.0) that you can see as a user are listed here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.103.1] - 2026-11-25

### Changed

- Maintenance release. It publishes the changes listed under 0.103.0 as a build; there are no other user-visible changes.

## [0.103.0] - 2026-11-25

### Changed

- Automatic backups, and Export / Import in Settings, no longer have an overall size limit. Before, a backup could not be written at all once your conversations passed about 384 MiB. Files written by earlier versions can still be read.
- Conversations being imported stay hidden until the whole file has been read and checked, then appear together. If the import fails or you quit partway, nothing is left behind.
- The local model panel in Settings and in the new-conversation dialog now notes that a folder which defines its own Ollama provider uses that provider as it is, without the context length Temoto would otherwise set.

### Added

- A "Backup failed" notice in the bottom bar when the last automatic backup did not succeed, with the reason (for example, not enough disk space). It goes away after the next successful backup.

### Fixed

- Images whose classification timed out while the index was being built are now retried once instead of being left unsearchable until the next update.

## [0.102.1] - 2026-11-24

### Changed

- Maintenance release. It publishes the changes listed under 0.102.0 as a build; there are no other user-visible changes.

## [0.102.0] - 2026-11-23

### Changed

- Images you paste, drag in or capture are now kept at up to 1600 px on the long side (it was 256 px), so a sent image stays readable when you open it. Images sent with an earlier version stay as they are.
- Folders named `build`, `dist`, `target` or `venv` are now left out of Files and search only when the folder next to them looks like a project (it has a `package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `.git` and the like). A plain folder such as `Documents/build` now shows up. Temoto scans your folders once after this update.
- When you close a web tab, the viewer goes back to what you were looking at before in the same conversation, or shows nothing. It no longer jumps to a tab that belongs to another conversation.

### Removed

- The ✕ in the viewer's header. Close a file or a web tab with ⌘W, or close a web tab from the list of open tabs in the sidebar.

## [0.101.1] - 2026-11-23

### Changed

- Maintenance release. It publishes the changes listed under 0.101.0 as a build; there are no other user-visible changes.

## [0.101.0] - 2026-11-23

### Added

- Source control view. Right-click a folder in Files and choose "Open in Source Control" to see its staged and unstaged changes, or to compare two revisions. Click a file to open its diff. The view is read-only.
- Drill for a Teammate. Before you let a Teammate work unattended, run it once with every outward or irreversible action stopped (sending, writing files, running commands). Afterwards you get a list of what it tried to do, and you can pick the actions this Teammate may do from now on. Actions that send something outside cannot be picked and are always confirmed. A drill uses your model as a normal conversation does.

## [0.100.1] - 2026-11-22

### Changed

- Maintenance release. It publishes the changes listed under 0.100.0 as a build; there are no other user-visible changes.

## [0.100.0] - 2026-11-22

### Changed

- Local models now get their context length on every request, so Temoto no longer needs to create a separate copy of the model. The "Set context length" button is gone. Copies made by an earlier version keep working, and the settings show how to remove them once they are no longer needed. If the context length cannot be set, the settings say why.
- After the main window reloads itself following a crash, it reopens the conversation that was open.
- If the main window keeps crashing, it now shows a short page with the reason and a "Load Again" button, not a blank window.
- Opening a conversation from the menu bar brings forward the window that already shows it. The voice input item in the menu bar shows its hotkey.

### Fixed

- After restoring from a backup with a passphrase you typed in, Temoto now tells you to set the passphrase again in Settings so that backups resume.

## [0.99.1] - 2026-11-22

### Changed

- Maintenance release. It publishes the changes listed under 0.99.0 as a build; there are no other user-visible changes.

## [0.99.0] - 2026-11-22

### Added

- Automatic daily backup of your conversations and settings, encrypted with a passphrase you choose. The 3 most recent backups are kept. Set it up in Settings; until you choose a passphrase, no backup is made and a banner you can dismiss points to the setting once.
- If the conversation database is damaged, Temoto now starts anyway and offers to restore from the most recent backup. The damaged database is kept aside, not deleted.
- "Help > Report a Problem" (also in Settings > About) writes one text file with the version, the OS and the recent log, with names, home paths and email addresses masked and no conversation text or crash dump, and shows it in Finder. Nothing is sent automatically.

### Changed

- The app icon is now the Temoto hand on a white rounded tile, and the menu bar icon is a matching hand silhouette. The Help page shows a pixel-art hand next to its title.
- The main window reloads itself if it crashes (up to 3 times a minute).

## [0.98.1] - 2026-11-22

### Changed

- Maintenance release. It publishes the changes listed under 0.98.0 as a build; there are no other user-visible changes.

## [0.98.0] - 2026-11-22

### Added

- The menu bar menu now lists your recent folders (pick one to start a new conversation there), a "Choose Folder…" row, a "Recent Conversations" submenu, the conversations that are waiting for approval, running or unread (pick one to open it), a row that starts a new conversation with voice input, and the next scheduled runs.
- The menu bar icon shows a dot while a conversation is running, and the number of unread conversations and pending approvals next to it.
- The viewer's address bar suggests files in the conversation's folder as you type, with a row to search the web for what you typed.
- The file shown in the viewer is now selected in Files when you click into the viewer or open another file.
- The local model settings explain that Temoto only sets the context length and does not change the model's weights, template or prompts.

### Changed

- The viewer pane is always shown, with an empty state when nothing is open. Its close button closes the current view and returns to the previous one, like closing a browser tab. Dragging the divider to the right edge folds the pane into a narrow strip.
- The menu bar icon is on by default. If you turned it off, it stays off.
- In the prompt box, the voice input, Send Later and Send buttons moved to the right end of the text area.
- The Thinking selector no longer shows levels the selected model cannot use.
- The viewer heading and the extensions list no longer show internal extension ids; the id is listed in the extension's details.
- The AI is told that it runs inside Temoto and where to find Temoto's help, so it can answer questions about the app itself.

## [0.97.3] - 2026-11-22

### Changed

- Release pages now start with a download button that links straight to the macOS DMG.

## [0.97.2] - 2026-11-22

### Changed

- Maintenance release. It publishes the changes listed under 0.97.1 as a build; there are no other user-visible changes.

## [0.97.1] - 2026-11-21

### Changed

- Maintenance release. It publishes the changes listed under 0.97.0 as a build; there are no other user-visible changes.

## [0.97.0] - 2026-11-21

### Added

- Teammates now keep their own list of allowed actions. In a teammate's conversation, an approval can be remembered "for this teammate", and the list is shown in the teammate's settings, where each entry can be removed. Removing a teammate removes its list.
- A teammate has a "Start in strict mode" switch (off by default), and its conversations start with the OS sandbox on.
- You can move an existing conversation to a teammate, or take it out, from the conversation's right-click menu. Conversations that are running, or that were started by a scheduled run or a trigger, cannot be moved.
- The conversation list filter also matches teammate names.

### Changed

- In unattended turns (scheduled runs, triggers, and the parallel tasks they start), the AI can no longer change Temoto's settings, and opening a web page asks for your approval first, with a time limit. Turns that you start yourself by typing in the conversation behave as before.
- The table of what each agent can do now shows whether it receives a teammate's standing instructions, and the teammate's settings say so when the default agent does not.

## [0.96.0] - 2026-11-21

### Added

- Teammates: give a name, a working folder, standing instructions and a model to a recurring kind of work. Conversations you start from a teammate and scheduled runs that use it are grouped under its heading in the conversation list, and the heading can be collapsed. Conversations without a teammate work as before.
- You can ask the AI to remind you later ("remind me in 10 minutes"). It adds a one-time desktop notification, marked "Set by AI" in the scheduled runs list, where you can remove it. The AI can only add plain notifications, and only a limited number.

### Changed

- The install scripts now print English by default, and Japanese when your locale is Japanese.
- The guidance for unattended sign-in now says exactly how to restart Temoto so that the token's environment variable is seen.

### Fixed

- While waiting for you to sign in again, a conversation stopped by a rejected API key is no longer resent once the sign-in comes back.

## [0.95.0] - 2026-11-21

### Changed

- Error notices now say what failed, suggest what to try, and have "Show details" with the log file's path (copyable) and an "Open Log" button, instead of only "Something went wrong".
- When your sign-in expires, the conversation's banner now shows what to do while it waits for you to sign in again (with a time limit and a Cancel button), then sends your last message again once, automatically. If tools had already started running in that turn, it does not resend on its own and leaves the "Send again" button instead.
- Scheduled and unattended conversations no longer open a sign-in window by themselves; they show how to set up a long-lived token for unattended use instead (Settings → Account & Usage). Temoto never stores or asks for the token.
- While an extension's list (for example, the calendar) is open in the sidebar, its background refresh keeps running during a conversation, at most every 5 minutes.

### Fixed

- "Open at Login" now keeps pointing at the current version after an update.

## [0.94.1] - 2026-11-21

### Changed

- Maintenance release. It publishes the changes listed under 0.94.0 as a build; there are no other user-visible changes.

## [0.94.0] - 2026-11-20

### Added

- Reminders: a scheduled job can now be a plain notification (no AI involved), with snooze (5 minutes, 10 minutes, 1 hour). Reminders fire while Temoto is running.
- Google Calendar extension (read-only, off by default): today, tomorrow and this week in the sidebar, and the AI can look up your events. It needs the Google Calendar API enabled for your Google Cloud project.
- Settings → Application: "Show in Menu Bar" (off by default) adds a menu bar icon with Show Window, New Conversation, the number of pending approvals, and Quit.
- A global shortcut that brings Temoto forward and starts dictation (no default key; set one in Settings → Keyboard).

### Changed

- "Save as PDF" for a conversation now includes the images you pasted or attached, and images in answers.

## [0.93.1] - 2026-11-20

### Changed

- Maintenance release. It publishes the changes listed under 0.93.0 as a build; there are no other user-visible changes.

## [0.93.0] - 2026-11-20

### Added

- Audio files (WAV, MP3, M4A, OGG, FLAC) play in the viewer.
- A shortcut starts and stops dictation while the prompt has focus (default ⌘D, changeable in Settings → Keyboard).
- Settings → Application: "Start at Login", and "Keep the Computer Awake for Scheduled Jobs" (it only holds off sleep while a scheduled job is enabled and the computer is on power). Both are off by default.
- `temoto://` links open Temoto, alongside the existing `aios://` links.

### Changed

- New installations use the name Temoto everywhere you can see it: the data folder, the logs folder, the `~/Temoto/` folder, the keychain item ("Temoto Safe Storage") and the bundle identifier (`io.github.temoto-app.temoto`). Machines that already have data under the previous name keep using it, so nothing has to be moved.
- The install script is now `install-temoto.sh`, and it no longer needs the GitHub CLI (`gh`).
- Automatic updates no longer need the GitHub CLI (`gh`): Temoto checks the public releases directly and falls back to `gh` only when that fails.
- Versions 0.92 and earlier cannot update themselves to 0.93: the app's bundle identifier changed, and the old updater rejects it. Reinstall once — run `install-temoto.sh` if you installed from Terminal, or install the new DMG to the same `/Applications` location — and your conversations, settings and index carry over.

### Fixed

- Saved Gmail triggers that still carried an old default instruction now follow the current default.

## [0.92.2] - 2026-11-19

### Changed

- The license agreement (EULA) and the contributor license agreement (CLA) now name the licensor.

## [0.92.1] - 2026-11-19

### Changed

- Maintenance release. It publishes the changes listed under 0.92.0 as a build; there are no other user-visible changes.

## [0.92.0] - 2026-11-17

### Changed

- **The app is now called Temoto** (it was called aios). The app is `Temoto.app`, releases are published at
  [temoto-app/temoto](https://github.com/temoto-app/temoto), and the release files are named `Temoto-<version>-…`.
  Your conversations, settings and index stay where they are and carry over.
- **Install once more to keep getting updates.** Versions installed under the old name look for updates in a place that
  does not receive releases, so they will not update themselves to Temoto. Run the install command in the README again
  (or install the DMG), then delete the old `aios.app`.
- The Back / Forward buttons in the title bar now step through conversations only. Switching the sidebar mode or
  picking an item in Files or Search is no longer a step.

### Added

- **Back / Forward in Files.** The Files sidebar has its own ← → that step through the rows you selected, kept
  separately for each conversation. They move the selection only and do not change what the viewer shows; the file open
  in the viewer gets a quieter mark.
- **Click a conversation's name to go to it.** When the AI mentions one of your earlier conversations by name, the name
  is a link that opens that conversation.

## [0.91.1] - 2026-11-17

### Changed

- Maintenance release. It publishes the changes listed under 0.91.0 as a build; there are no other user-visible changes.

## [0.91.0] - 2026-11-15

### Changed

- **"Don't ask again in this conversation" in strict mode now covers more than shell commands, but more narrowly.**
  In a strict conversation, the approval prompt can stop asking for the same kind of action for the rest of that
  conversation: a command that starts the same way (for example `terraform plan`), writing files in the same folder,
  or a tool that only reads. It used to cover every shell command at once. Tools whose effect aios cannot tell, and
  sending things outside your computer, still ask every time. Turning strict mode off and on again asks again.
- Chained commands such as `a && b` pass without asking only when every part is already allowed. Commands that pipe
  into a shell or interpreter, or span several lines, must match exactly.

### Fixed

- Permissions you gave a scheduled job that has since been deleted are cleaned up at startup.

## [0.90.0] - 2026-11-15

### Added

- **See and remove what a scheduled job is allowed to do.** A scheduled job's edit screen now lists the actions you
  allowed for it from the approval prompt, with when each was last used. Remove a row with ✕ and the job asks again.
  Rows that expire, or that belong to a deleted job or conversation, are removed automatically.

### Changed

- For scheduled jobs, tools whose effect aios cannot tell (for example many connector tools) and web search no
  longer offer "allow from now on"; they ask every time.

### Fixed

- A third-party extension that shares an id with a built-in extension you turned off no longer starts turned off
  just because of that. Its own on/off choice is kept separately.

## [0.89.0] - 2026-11-15

### Added

- **Allow an action for a scheduled job from now on.** When a scheduled job in strict mode asks for approval, the prompt
  can now also allow that kind of action for this job only, either always, today only, or for this conversation only.
  Other jobs still ask. Sending things outside your computer and access outside the working folder still ask every time.

### Changed

- **Installs from the disk image now update themselves.** If you dragged aios from the `.dmg` into Applications, it now
  picks up new versions the same way as an `install-aios.sh` install. If aios cannot write to Applications, the Update
  section in Settings says why and nothing is changed.

## [0.88.0] - 2026-11-15

### Added

- **Disk image download.** Each release now also offers a signed and notarized `.dmg`: open it and drag aios to
  Applications. The `.zip` and `install-aios.sh` stay for automatic updates and scripted installs.

### Changed

- **Quick Open previews the top match.** In file name search (⌘P), once you stop typing the first match opens in the
  viewer on its own, so you can see it without pressing Enter. Your typing and focus stay in the search box. If the
  file open in the viewer has unsaved edits, nothing is replaced until you choose a result yourself.

## [0.87.1] - 2026-11-15

### Changed

- Maintenance release. It publishes the changes listed under 0.87.0 as a build; there are no other user-visible changes.

## [0.87.0] - 2026-11-15

### Added

- **Search inside `.xlsm` workbooks.** The text in the cells of macro-enabled Excel workbooks now shows up in content
  search, the same as `.xlsx`. Macros are not read.
- **Ask the assistant about aios itself.** The Help pages are copied to `~/aios/help/` when aios starts, so in a
  conversation you can ask where a setting lives or ask the assistant to change it.

### Changed

- **Extension settings belong to the exact extension.** If a different extension arrives with the same id, it starts
  from the default settings instead of inheriting the previous one's. An extension you turned off stays off even when
  its contents change; the detail page says so, and you can turn it on for the new contents.
  Uninstalling an extension now also removes its background task state and the documents it added to search.

### Fixed

- The Triggers permission toggle on an extension's detail page no longer fails with an error.

## [0.86.0] - 2026-11-14

### Added

- **Download progress for local models.** When you download a recommended local model from "Recommended for this PC",
  a progress bar shows how much has been downloaded so far.
- **Edit formulas in Excel workbooks, and open `.xlsm` files.** Formula cells can now be edited and saved. aios does not
  calculate formulas; Excel recalculates them when it opens the file, and cells that depend on an edit are marked as
  showing an old value. Functions that reach the network or run outside code cannot be written. `.xlsm` workbooks can
  be edited the same way; their macros are kept as they are and never run. Workbooks with signed macros stay read-only.
- **Uninstall extensions you added yourself.** An extension's detail page has an Uninstall button. The folder moves to
  the Trash, and the extension's trigger rules, settings and permissions are removed. Built-in extensions can still
  only be disabled.
- **Monospace Gmail drafts.** A setting under MCP asks the assistant to write Gmail drafts in a monospace font, for
  tables, logs and aligned columns. It applies to conversations started after the change.

### Changed

- **Damaged local model downloads are explained.** If a local model fails to load in a way that suggests an incomplete
  or damaged download, the error now says so, and "Recommended for this PC" offers a button to download it again.
  aios never deletes or re-downloads a model on its own.

### Security

- Permissions you grant an extension you added yourself now belong to that exact version of its files. If the files
  change, the extension asks for permission again.

## [0.85.1] - 2026-11-14

### Changed

- Maintenance release. It publishes the changes listed under 0.85.0 as a build; there are no other user-visible changes.

## [0.85.0] - 2026-11-14

### Added

- **Find images by the text in them (macOS).** Screenshots, receipts and photos of documents can now be found by words
  that appear in the picture. Text recognition runs in the background, newest images first, at the same low priority as
  the rest of indexing. The recognized text is not stored; it is read again from the image when needed.
- **Settings for extensions.** An extension can declare its own settings, shown in a Settings section on its detail page.
  The Gmail extension uses this for the trigger: allowed senders, whether Cc counts, and sender authentication.
- **A record of auto-picked answers.** When a recommended answer was picked automatically, the conversation shows the
  question, the options, which one was recommended, what was picked, and that it was picked automatically.

### Changed

- **Auto-pick recommended answers is now per conversation.** The global setting is gone. Turn it on with the
  `auto-pick` chip at the bottom of the prompt box; it applies to that conversation only and new conversations start with
  it off. If you had the old setting on, turn the chip on where you want it.
- **Triggered conversations can use fewer extension tools.** Read-only tools of built-in extensions still work. Tools of
  other extensions work only if you allow them in the trigger rule, and a rule is turned off when its extension changes
  or cannot be loaded, until you turn it on again.

### Fixed

- **Background PDF indexing is throttled correctly.** The CPU time used while reading PDFs now counts toward the
  low-priority pacing, so indexing many PDFs no longer runs hotter than the rest of indexing.
- **Gmail trigger: the allowed-senders list no longer falls back to "everyone".** Lines that are not an address or a
  domain are rejected when you enter them, and if the setting cannot be read the trigger does nothing for that sync.

## [0.84.0] - 2026-11-13

### Added

- **Edit values in `.xlsx` files.** Click a cell (or press F2, double-click or just type) to change its value, then save with
  ⌘S or let auto-save write it. Only the cells you changed are rewritten; everything else in the file is kept byte for byte.
  Formulas are not recalculated in aios: cells that depend on your edits are marked as stale, and Excel recalculates them
  when it opens the file. Formula cells, merged areas, table headers, protected sheets and signed workbooks stay read-only,
  and the viewer tells you why.
- **Find images by what is in them (macOS).** Searching for "dog photo" or "food" now also finds pictures whose name and
  text never mention it. Images are labelled in the background at the same low priority as the rest of indexing; tiny
  images and the Photos library are skipped. Image results show a thumbnail.
- **Full screen for web pages.** A page's own full-screen button (for example on a video) now works, and ⌃⌘F while a web
  tab is in front shows only the page, filling the screen. Press Esc or ⌃⌘F again to leave.
- **Triggers (off by default).** An extension can report an event, and aios starts one unattended conversation per event
  following a rule you set in the Scheduled view. Triggered conversations can only read: they cannot run commands, edit
  files, browse the web or send anything. Each rule has a daily limit.
- **Gmail trigger.** With the Gmail extension, a new mail addressed to you can start a conversation that summarizes it and
  drafts a reply for you to copy. Newsletters, mailing lists, no-reply senders and mail that fails sender authentication are
  skipped. Nothing is sent.
- **Bitbucket extension (off by default).** Reviews pull requests on Bitbucket Cloud where you are a reviewer, one
  conversation per pull request. Enter your email and an API token with read-only scopes in the extension's Account
  section. It never comments on or approves a pull request.
- **Local model recommendations.** When you pick a local model backend, aios suggests models that fit this computer's
  memory and GPU, with a context length. Download and setup only happen when you press the button.

### Changed

- **Thinking "Off" follows what the model supports.** Models that cannot turn thinking off no longer offer "Off"; a
  conversation that had it uses the nearest level that works.
- **Switching model or thinking level during a turn no longer restarts the agent** on the current agent CLI version.
- **Extension updates can be signed.** Releases can carry a signature for the extension checksums; once the signing key is
  set, aios refuses extension updates from releases without a valid signature.
- **Scheduled tasks can run every 5 minutes.** The shortest interval for "every n minutes" is now 5 minutes (it was 15),
  and the editor offers 5 / 15 / 30 / 60 minute buttons next to the number field. Every run starts a new turn and uses
  tokens, so the editor still shows how many times a day the task will run.

### Fixed

- **Account sign-ins belong to their own extension.** The Gmail sign-in and the new Bitbucket token can only be used by the
  bundled extension they were entered for. Before, another extension that declared the same credential name could have
  asked to use them.
- **A page's full-screen button did nothing in the web view.** It now works (see Added).

## [0.83.1] - 2026-11-12

### Changed

- Maintenance release. It publishes the changes listed under 0.83.0 as a build; there are no other user-visible changes.

## [0.83.0] - 2026-11-12

### Added

- **Table view for CSV files.** `.csv` and `.tsv` files now open as a table. Use the Table / Text switch in the viewer header to
  see the raw text, which you can edit as before. Quoted fields with commas and line breaks are handled, and switching views
  never changes the file. Large files show the first 200 rows with a button to show more.
- **"Open in default app".** The open button now sends documents, images, video and audio (for example `.xlsx`, `.docx`,
  `.pptx`, `.pdf`) to the app your system associates with them, instead of always starting the code editor. Text and code
  files still open in the editor you chose. The right-click menu offers both "Open in default app" and "Open in editor" for
  these files. If the default app cannot open a file, it opens in the editor.

### Changed

- **Update is the first item in Settings.**
- **Clearer messages when the update check fails.** Settings › Update now tells apart "no published release was found",
  a timeout, a GitHub rate limit and a network problem, instead of one generic message. When a check fails, an
  "Open log folder" button appears next to it.
- **Japanese text files in Shift_JIS or EUC-JP are readable.** Files that are not valid UTF-8 are shown with the detected
  encoding instead of replacement characters. They remain read-only.

## [0.82.2] - 2026-11-11

### Changed

- Maintenance release. It publishes the changes listed under 0.82.1 as a build; there are no other user-visible changes.

## [0.82.1] - 2026-11-11

### Changed

- Maintenance release. It publishes the changes listed under 0.82.0 as a build; there are no other user-visible changes.

## [0.82.0] - 2026-11-10

### Added

- **More thinking levels.** The thinking switch below the prompt now offers the levels the selected model reports. Models that
  support them get "Deeper" and "Max" to the right of "Deep". If you switch to a model without your current level, the nearest
  lower level is used.

### Changed

- **The model switch follows new versions.** When a newer version of a model family is available, the switch below the prompt
  shows it instead of the older default. A version you pick yourself from the ▾ list stays pinned and is not replaced when a
  newer one appears; the previous default remains available in that list.

### Fixed

- Writing a script to a scratch file with a here-document and then running it no longer asks for approval just because the
  script text mentions a settings file name. Commands that really write to startup files, hooks or settings still ask.

## [0.81.1] - 2026-11-10

### Changed

- Maintenance release. It publishes the changes listed under 0.81.0 as a build; there are no other user-visible changes.

## [0.81.0] - 2026-11-10

### Added

- **More recent-file suggestions.** The strip above the prompt that offers recently changed files now shows up to 12 of them
  (four or more wrap into a compact grid), under a "Recent files" heading with a dashed border, so suggestions are easy to tell
  apart from files you have already attached.
- **Conversation search takes precedence.** While the conversation search (⌘K) has text, the file search (⌘⇧F) and file name
  search (⌘P) fields are greyed out and their shortcuts do nothing. Their text is kept and comes back as soon as you clear the
  conversation search.

### Changed

- **Interpolation switch in the viewer header.** Nearest / Bilinear for images and videos is now a segmented control in the
  viewer header, matching the Preview / Source and model switches. The zoom bar keeps − / 100% / +.
- **The spinner follows background work.** A conversation keeps spinning while shell commands the agent moved to the background
  are still running, and stops when they finish (or after the 30-minute background limit). While the agent waits for your
  approval the spinner stops even if sub-agents are still running, so the approval mark stands on its own.

## [0.80.1] - 2026-11-09

### Changed

- Maintenance release. It publishes the changes listed under 0.78.0 to 0.80.0 as a build; there are no other user-visible changes.

## [0.80.0] - 2026-11-08

### Added

- **Auto-answer recommended choices (optional).** When an agent asks a single-choice question whose first option is marked as
  recommended, aios can pick it after a 5-second countdown; touching the prompt cancels it. Off by default. Plans and permission
  requests still wait for you, and the timeline notes every automatic answer. Recommended options now carry a small badge.
- **Global hotkey.** Press ⌃⌥Space from any app to bring aios forward with a new conversation ready to type in. Change or turn it off
  under Keyboard Shortcuts. The README explains how to add a Finder Quick Action that sends files to aios.
- **What each backend can do.** The new-conversation dialog and the Agent CLI settings show whether a backend supports approvals,
  sub-agents, rewind and MCP. Features a backend lacks are greyed out with a reason instead of disappearing.

### Changed

- The full-delegation confirmation now describes what aios still asks about: sending messages that reach people, and publishing
  after an agent has read a secret.
- Changing keyboard shortcuts through an agent's settings request now asks for your approval.

## [0.79.1] - 2026-11-08

### Fixed

- **Image and video zoom edge cases.** The initial zoom of an image is measured after it is laid out, a video larger than its pane
  is shrunk to fit (never enlarged), and reopening a viewer no longer leaves stale resize handlers behind.
- **Approval prompts for outbound actions.** aios now also asks again when an agent that has read a secret goes on to publish
  (for example `npm publish`), and chat webhook destinations are recognised more reliably, including URL variants and subdomains.
- **Release builds.** The "copy build info" text in released builds states the build date instead of a commit.

## [0.79.0] - 2026-11-08

### Added

- **Image and video zoom.** Images and videos open at actual size (one image pixel per screen pixel, also on Retina displays).
  Very small images (up to 128 px on the long side) open at the largest whole-number zoom that fits. Zoom with the +/− buttons
  or a trackpad pinch, click the zoom percentage to return to actual size, and switch between Nearest (sharp pixels) and
  Bilinear (smooth) scaling.

### Changed

- **Fewer approval prompts for outbound actions.** aios now asks only before sending a message that reaches people directly:
  connector tools such as Slack or Gmail, mail commands, `osascript` sends, and `curl`/`wget` posts to chat webhooks (Slack,
  Discord, Teams, Google Chat). Publishing (`gh`, `git push`, `npm publish`), file transfers and general HTTP requests no longer
  ask. aios runs the agent with permissions bypassed by default; see the README.
- **Build label in released builds.** Released builds show the version and build time without a commit hash.

## [0.78.0] - 2026-11-08

Initial public release.

### Added

- **Conversations as bundles of a task.** Every thread keeps its messages, approvals, opened files and viewers together. Threads
  can be branched from an earlier turn, rewound, and continued from a past transcript.
- **Runs the agent CLI you already have.** aios starts the CLI you installed and logged in to (subscription or API key) as a child
  process. It does not bundle or modify it, and never reads its credentials. Models, thinking level and slash commands are
  available from the prompt box; a second backend for free and local models is supported.
- **One approval inbox.** Tool requests and questions from the agent land in a single place above the prompt box. The default
  works without interruptions; stop patterns, strict mode, an OS sandbox and a full-delegation mode are opt-in.
- **Search the whole Mac and your past conversations.** A Japanese-aware full-text index of your files and conversations runs in
  its own process, and the agent can search it through a built-in MCP gateway.
- **File viewers built as sandboxed extensions.** Text and code editor, Markdown, images, diff, PDF, video, Office documents, HTML,
  Gmail, zip archives and Reddit. Extensions reach files and the network only through a capability broker with path and network
  policies and an audit log. Extensions can be updated one by one without updating the app.
- **Web view in the side pane.** Links in answers open in tabs next to the conversation, with per-site sign-in kept separate.
- **Prompt box.** `@` file mentions, `!` shell commands, attachments from drag and drop or recent screenshots, voice input,
  and queued prompts you can send while the agent is running.
- **Help.** Open it from the Help menu, the question mark in the Activity Bar, or Settings.
- **Release Notes.** This file is bundled with the app. Open it from Help > Release Notes or from Settings > About. After an
  update, the notes for the new version open once in the viewer pane (can be turned off in Settings).
- **Automatic updates.** aios and the extensions update themselves in the background and switch versions when you quit or when the
  Mac has been idle; the previous version can be restored.
- **English and Japanese** user interface, light and dark themes, customizable keyboard shortcuts, multiple windows, desktop
  notifications, and export / import of threads and settings.

### Notes

- macOS on Apple Silicon (arm64) only.
- aios does not intermediate or resell usage of the agent. Any cost figures are token-consumption estimates, not charges.
