# MorchedCA Meta catalog sync

This repository builds a validated Facebook/Meta product catalog from the public JSON APIs at [morchedca.store](https://morchedca.store) and deploys the result with GitHub Pages.

The public feed URL is:

**https://thelime1.github.io/morchedca-catalogue-sync/catalog_products.csv**

## Data flow

1. GitHub Actions reads every page of the public products and categories APIs.
2. `scripts/build-catalog.mjs` keeps visible and out-of-stock products, expands variants, cleans descriptions, resolves categories, applies verified color images, and formats Meta fields.
3. The builder validates API coverage, variant sets, IDs, prices, links, image mappings, and every unique live image URL before writing a temporary CSV.
4. Only after all checks pass is the temporary file moved to `public/catalog_products.csv`.
5. The official GitHub Pages actions publish `public/`, and Meta downloads the stable URL on its own schedule.

No store credentials, Converty OAuth, browser scraping, or GitHub Secrets are used.

## Enable GitHub Pages

1. Open **Settings → Pages** in this repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open **Actions → Catalog sync** and choose **Run workflow** for the first deployment.
4. After the run succeeds, GitHub shows the deployment URL in the `github-pages` environment and on the workflow summary.

The workflow also runs at minute 17 of 04:00 UTC approximately every three days. GitHub cron expressions use UTC, and scheduled runs can start late when GitHub Actions is busy.

## Manual refresh and local checks

Use **Actions → Catalog sync → Run workflow** to refresh immediately.

With Node.js 22 or newer, the same checks can be run locally:

```bash
npm test
npm run build
npm run validate
```

The build uses retries with exponential backoff, request timeouts, a descriptive User-Agent, paginated API reads, and limited-concurrency image checks. `SKIP_IMAGE_CHECKS=1 npm run build` exists only for isolated development; the production workflow never skips image validation.

## Connect the feed to Meta Commerce Manager

1. Open the relevant catalog in **Commerce Manager**.
2. Go to **Data sources → Add items → Data feed**.
3. Select **Use a URL or Google Sheets**.
4. Enter `https://thelime1.github.io/morchedca-catalogue-sync/catalog_products.csv`.
5. No username or password is required.
6. Choose a Meta fetch schedule after the GitHub schedule—for example, every three days later in the day—so Meta normally reads the newest deployment.
7. Confirm the currency and market settings expected by the catalog. Feed prices are explicitly formatted in TND.

The URL returns the CSV directly and remains unchanged between deployments.

## Verify a new color or variant product

The store API currently does not assign images directly to its color variants. Their verified association is therefore versioned in `data/variant-image-mapping.json`:

```json
{
  "product-slug": {
    "Color name": "https://cdn.converty.shop/..._lg.webp"
  }
}
```

When a new color or variant product is added:

1. Open the product on the storefront and verify which gallery image represents each color. Do not infer the association from gallery order.
2. Copy the preferred `lg` URL returned for that exact gallery image by the public product API (fall back to `md`, then `sm`, only if needed).
3. Add the product slug and every current color to `data/variant-image-mapping.json`.
4. Run `npm run build`. The build must succeed before merging.

The build deliberately fails with the exact product slug and color when a mapping is missing, its image leaves the gallery, two colors share an image, a color is duplicated, or the API adds an unverified variant. This protects Meta from silently receiving an incorrect catalog.

## Failure safety

Generation happens in `.catalog-products.pending.csv`. Fetching, schema validation, catalog validation, serialized CSV validation, and live image checks all finish before that temporary file replaces the local public file. In GitHub Actions, the Pages artifact and deployment steps are after every validation step.

If any check fails, the job exits nonzero and no Pages deployment is attempted. GitHub Pages continues serving the previous successful deployment.

## API caveat

The storefront APIs are public but unofficial:

- `https://morchedca.store/api/v1/products`
- `https://morchedca.store/api/v1/categories`

The sync validates response shape, pagination totals, stable IDs, category references, option/variant alignment, and catalog coverage so a schema change fails safely instead of publishing HTML, a login response, an empty file, or a partial feed. Review the scripts if the storefront API schema intentionally changes.
