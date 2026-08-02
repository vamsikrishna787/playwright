# File layout

Three files per feature. The split is not cosmetic: locators change when the UI
changes, functional tests change when the product changes, and accessibility
findings need to fail loudly on their own rather than hiding inside a checkout
test.

```
<testDir>/<feature>.locators.ts    every locator, one exported factory per page
<testDir>/<feature>.spec.ts        the functional tests
<testDir>/<feature>.a11y.spec.ts   the WCAG/ADA checks
```

## Where testDir is

In order:

1. `testDir` in the repo's `playwright.config.{ts,js,mjs}`.
2. An existing directory of specs — `e2e/`, `tests/e2e/`, `tests/`, `__tests__/e2e/`.
3. Otherwise `e2e/`, and say that you created it.

Match the naming style already in that directory. If its specs are `.js`, write
`.js`. If it uses page-object classes, follow that instead of the factory below —
an existing convention beats this one.

## `<feature>.locators.ts`

```ts
import { type Page } from '@playwright/test';

/** URLs the tests navigate to, exactly as captured. */
export const URLS = {
  login: 'https://www.saucedemo.com/',
} as const;

/**
 * A factory rather than a bare object: each test gets locators bound to its own
 * page, which is what makes the file safe to share across parallel workers.
 */
export const loginPage = (page: Page) => ({
  username: page.getByPlaceholder('Username'),
  password: page.getByPlaceholder('Password'),
  loginButton: page.getByRole('button', { name: 'Login' }),
  errorMessage: page.getByTestId('error'),
});

export const inventoryPage = (page: Page) => ({
  heading: page.getByText('Products'),
  cartLink: page.getByRole('link', { name: 'Shopping cart' }),
  // Every product card carries this button, so the test has to say which one.
  addToCart: (product: string) =>
    page.getByRole('button', { name: `Add to cart ${product}` }),
});
```

One factory per page in the journey, named for the page. Keys are camelCase and
describe the element's job (`submitButton`), not its appearance (`blueButton`).

## `<feature>.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import { URLS, loginPage, inventoryPage } from './checkout.locators';

test.describe('Checkout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URLS.login);
  });

  // A failure is far cheaper to read with the screen attached to it.
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('screenshot', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    }
  });

  test('signs in and reaches the inventory', async ({ page }) => {
    const login = loginPage(page);
    const inventory = inventoryPage(page);

    await test.step('sign in', async () => {
      await login.username.fill('standard_user');
      await login.password.fill(process.env.TEST_PASSWORD ?? '');
      await login.loginButton.click();
    });

    await test.step('lands on the inventory', async () => {
      await expect(page).toHaveURL(/inventory/);
      await expect(inventory.heading).toBeVisible();
    });
  });
});
```

Rules that matter:

- No `page.goto` inside a test — `beforeEach` did it.
- Every logical action and assertion inside `await test.step('...')`. The step
  names are what a failing run reads like.
- Web-first assertions (`await expect(x).toBeVisible()`), never `waitForTimeout`.
- At least one `expect` that encodes the scenario's actual success condition.
- `it("works")` is not a test name. Say what the user did and what should happen.

## `<feature>.a11y.spec.ts`

```ts
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { URLS, loginPage } from './checkout.locators';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Returns rule summaries rather than raw violation objects: a failure then names
 * the rules that fired instead of dumping a deep-equality diff nobody reads.
 */
async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
}

test.describe('Checkout — accessibility', () => {
  test('login page meets WCAG 2.1 A/AA', async ({ page }) => {
    await page.goto(URLS.login);
    expect(await violations(page)).toEqual([]);
  });

  test('inventory page meets WCAG 2.1 A/AA', async ({ page }) => {
    const login = loginPage(page);
    await page.goto(URLS.login);
    await login.username.fill('standard_user');
    await login.password.fill(process.env.TEST_PASSWORD ?? '');
    await login.loginButton.click();
    await expect(page).toHaveURL(/inventory/);

    expect(await violations(page)).toEqual([]);
  });
});
```

One test per page the journey reached, so a report says *which* page is
inaccessible. Details in [ada-checks.md](ada-checks.md).

## Test data

Literal values from the scenario go straight into `fill()`. Credentials do not:

```ts
await login.password.fill(process.env.TEST_PASSWORD ?? '');
```

Record the variable names in the run report so the developer knows what to set,
and never write a captured password into a file.
