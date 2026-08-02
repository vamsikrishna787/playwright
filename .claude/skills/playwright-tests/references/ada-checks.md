# ADA / accessibility checks

Accessibility checks live in `<feature>.a11y.spec.ts`, separate from the
functional spec, for one reason: a WCAG failure is a product defect, and it
should say so by name instead of showing up as "checkout test failed".

## What the checks assert

axe-core against WCAG 2.1 level A and AA — the level US ADA guidance and EN 301
549 both point at:

```ts
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
```

Assert on rule summaries, not raw violation objects:

```ts
const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}`)).toEqual([]);
```

A failure then reads `Expected [] but received ['color-contrast (serious): …']`
instead of a hundred lines of DOM diff.

## One test per page state

axe only sees what is rendered right now. A single audit of the landing page says
nothing about the page behind the login, and nothing about the modal that opens
on click. Write a test per page the journey reached — the capture already
audited each one, so you know what to expect before you run.

Audit meaningful intermediate states too, not just URLs: an open modal, an
expanded menu, a form showing validation errors. Those are where keyboard and
focus defects live.

```ts
test('checkout modal meets WCAG 2.1 A/AA', async ({ page }) => {
  await page.goto(URLS.cart);
  await cartPage(page).checkoutButton.click();
  await expect(cartPage(page).modal).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
```

## When violations are real

The capture reports what axe found before any test exists, so a red a11y spec on
the first run is expected on most real sites. That is a finding, not a bug in the
test.

Report the violations, with rule id, impact and node count, and leave the
assertion alone. Never do any of these to get to green:

- delete or `test.skip` the accessibility test
- filter the violations array down to the ones that pass
- swap `toEqual([])` for a length threshold
- drop `wcag2aa` from the tag list

If the team has formally accepted a defect, exclude that one rule explicitly and
say why in the code:

```ts
// APP-1423: brand palette fails contrast, accepted until the Q3 rebrand.
const results = await new AxeBuilder({ page })
  .withTags(WCAG)
  .disableRules(['color-contrast'])
  .analyze();
```

A named ticket in a comment is the difference between a documented exception and
a quietly weakened test.

## What axe cannot check

Roughly a third of WCAG is machine-checkable. axe finds no violations on plenty
of pages that are unusable with a keyboard, so add the checks it cannot make when
the flow warrants them:

```ts
test('the form is operable by keyboard alone', async ({ page }) => {
  await page.goto(URLS.login);
  await page.keyboard.press('Tab');
  await expect(loginPage(page).username).toBeFocused();
  // …tab through to the submit control and activate it with Enter
});
```

Focus order, focus visibility, focus trapping in a modal, and Escape closing a
dialog are all worth a test on any flow that matters.

## Scoping

Audit the whole page by default. Scope only to keep third-party content from
failing your build, and name what you excluded:

```ts
new AxeBuilder({ page }).include('main').exclude('#vendor-chat-widget')
```

## Dependency

The a11y spec needs `@axe-core/playwright` in the repo under test:

```bash
npm install -D @axe-core/playwright axe-core
```

If it is missing, install it before writing the spec — or say plainly that the
accessibility file was not written and why. Do not silently drop it.
