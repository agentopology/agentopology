# Compatibility policy

How agentopology changes what it accepts and what it generates, so that an upgrade that turns a working project red, or changes what runs, always comes with a warning or, in the one exception below, a fix named in the CHANGELOG.

## What counts as a break

A release breaks a project when a `.at` file, or a project scaffolded from one, that worked with the previous release:

- fails `validate`, `scaffold`, `guard --target` or `import` (a new error, or an exit code that went from 0 to non-zero), or
- gets different generated files that change what runs: a hook added, removed or rewired, or a script that now blocks or now passes.

These are not breaks: new warnings, new output lines, wording changes, and generated files that change only in text no one runs (comments, ordering, hashes).

## The rule: warn first, then refuse

A new check that can fail a project the previous release accepted ships in two steps:

1. **As a warning for at least one release.** The warning names the file, the line and the node, says what will change, and gives the fix. When the fix can be applied mechanically, a command applies it, with a dry run first that changes nothing.
2. **As an error in a later release.** That release's CHANGELOG lists it first under "Changed behaviour", with the same fix and the same command.

A check never goes straight to an error unless letting the project pass would claim enforcement that does not exist: a step reported as refusing when nothing refuses it. Then it can be an error at once, and the CHANGELOG says so and why, with the fix. (0.12.5's V135 is such a case.)

A change to generated files that changes what runs (a script that now exits differently, commands now written where they were dropped) is not a check and has no warning step. It ships in a release whose CHANGELOG lists it under "Changed behaviour" with the before and after, so a project can be checked before upgrading.

## How each release reports it

- The CHANGELOG's "Changed behaviour" section names every break first, with what fails, the message, and the fix.
- A behaviour that differs from the previous release is pinned by a test.
- Known issues in the current release are listed in the README under "Known issues in <version>", with what to write instead.

## Releases before 1.0

agentopology is before 1.0. A minor release (0.x.0) may include breaks; a patch release (0.x.y) should not refuse what the previous patch accepted, except by the warn-then-refuse path above or the enforcement exception. Either way, the CHANGELOG names it.
