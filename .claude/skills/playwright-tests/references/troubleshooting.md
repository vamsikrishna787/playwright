# When a generated test fails

Read the failure before changing anything. Every one of these has a correct fix
and a tempting wrong one, and the wrong one always looks faster.

## `strict mode violation ... resolved to N elements`

The locator matches more than one element.

- Add `{ exact: true }` to a `getByRole` name that is a prefix of another.
- Scope it: `page.getByRole('listitem').filter({ hasText: 'Backpack' }).getByRole('button')`.
- `.first()` only when the elements are genuinely interchangeable, such as
  autocomplete suggestions.

Wrong fix: swapping to a CSS or XPath selector.

## `Timeout ... waiting for locator`

The element never appeared. Two causes, and they need different fixes:

- **The locator is wrong.** Check it against the capture. Anything marked
  *appears only after interaction* needs the revealing step first.
- **A previous step did not complete.** An autocomplete needs click → `fill()` →
  click the option, in that order. A form whose submit stays disabled until a
  suggestion is committed will time out here even though the locator is perfect.

Wrong fix: `waitForTimeout`. It hides the cause and makes the suite slow and
flaky at the same time.

## `expect(received).toHaveURL(expected)` with a string

`toHaveURL('/inventory.html')` must match the whole URL, so it fails against
`https://site.com/inventory.html`. Always pass a regex:

```ts
await expect(page).toHaveURL(/inventory/);
```

## An assertion on text that was never observed

`getByText('Flights from Dallas to Phoenix')` invented from the scenario will
fail. Assert on the URL, or on a role with a short name fragment. Reserve
exact-text assertions for strings that appear in the capture.

Avoid asserting on landmark roles (`getByRole('main')`, `getByRole('navigation')`)
unless the capture lists them — plenty of real pages have neither, and the test
then fails for a reason unrelated to the scenario.

## The file does not run at all

A TypeScript or import error. Check the import path of the locators file (no
`.ts` extension), that `@axe-core/playwright` is installed, and that the config's
`testDir` actually covers where you wrote the files.

## Only the accessibility test fails

The functional test is fine and the page genuinely violates WCAG. Report the
rules that fired and leave the assertion alone. See
[ada-checks.md](ada-checks.md) — weakening it is never the fix.

## It passes locally and fails in CI

Usually headed-versus-headless, viewport size, or timing on a slower machine.
Re-run the capture with `--headed` off, check the config's viewport, and replace
any implicit timing assumption with a web-first assertion.

## The test is flaky

Flaky almost always means a missing wait that a web-first assertion would have
supplied. `await expect(locator).toBeVisible()` before acting on something that
arrives asynchronously. Retries hide the problem rather than fixing it; a fixed
`waitForTimeout` does both.
