# Locator rules

The capture already picked a locator for every element and printed it as
`page.getByRole('button', { name: 'Login' })`. Copy that expression verbatim into
the locators file. These rules explain what it chose and when you need to
intervene.

## Priority

The capture emits the first of these that applies, which is Playwright's own
recommended order:

1. `getByTestId('...')` — a `data-testid`. Immune to copy changes.
2. `getByRole('button', { name: 'Login' })` — role plus accessible name. The
   default, and the one that also proves the element is reachable assistively.
3. `getByLabel('Username')` — a labelled form control.
4. `getByPlaceholder('Search')` — no label exists.
5. `getByText(...)`, `locator('[id="..."]')`, `locator('tag')` — fallbacks. If a
   locator in your test looks like this, check whether the element genuinely has
   no name; often it means the page has an accessibility defect worth reporting.

Never downgrade to a CSS or XPath selector to dodge a problem. `.locator('div >
span:nth-child(3)')` breaks on the next markup change and hides the real cause.

## Test ids that are not `data-testid`

`getByTestId` reads only the attribute the project configured. When a page uses
`data-test`, `data-qa` or `data-cy`, the capture emits an explicit attribute
selector instead:

```ts
page.locator('[data-test="login-button"]')
```

That always works. If the repo standardises on that attribute, the better fix is
in `playwright.config.ts`:

```ts
use: { testIdAttribute: 'data-test' }
```

Then re-run the capture with `--test-id-attribute data-test` and you get clean
`getByTestId('login-button')` calls.

## Strict mode

A locator that matches more than one element fails the run — Playwright refuses
to guess. The capture handles two cases for you:

- **Substring collisions.** `getByRole('textbox', { name: 'Password' })` also
  matches "Confirm Password". The capture adds `{ exact: true }` when it sees a
  sibling whose name contains this one.
- **Genuine repeats.** A list of products each with an "Add to cart" button is
  annotated `matches N elements — needs .first()/.nth()`.

For a genuine repeat, scope it rather than reaching for `.first()` blindly:

```ts
// vague — which product?
page.getByRole('button', { name: 'Add to cart' }).first()

// says what it means
page.getByRole('listitem').filter({ hasText: 'Backpack' })
    .getByRole('button', { name: 'Add to cart' })
```

Autocomplete suggestions are the exception where `.first()` is right: a search
phrase legitimately matches several options.

```ts
await page.getByRole('option', { name: 'Dallas' }).first().click();
```

## Elements that appear only after interaction

Anything the inventory marks `appears only after interaction` does not exist on
page load. The test must perform the interaction that reveals it first, or it
will time out on a locator that is perfectly correct.

The same applies to an autocomplete flagged in the **Observed behaviour**
section: click the field, `fill()` it, then click the option. Clicking the option
without typing finds nothing, because the list is empty until text is entered.
Many forms keep their submit control disabled until a suggestion is committed.

## Elements that were never observed

If the scenario needs a control the capture never saw, one of these is true:

- It only appears after a step the scraper would not take (it never submits) —
  record the journey instead.
- It is inside an iframe. Use `page.frameLocator('...')` and re-capture from
  inside the frame if possible.
- It is behind auth — record.

Say which. Do not invent the selector and hope.

## Naming

```ts
// bad — describes the pixels
blueButton, div3, input1

// good — describes the job
submitButton, usernameInput, cartBadge, validationError
```

The name is read far more often than the selector; when the UI moves, a good name
is what tells the next person which line to fix.
