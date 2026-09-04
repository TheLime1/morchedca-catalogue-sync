#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CATALOG_COLUMNS = Object.freeze([
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
  "google_product_category",
  "fb_product_category",
  "quantity_to_sell_on_facebook",
  "sale_price",
  "sale_price_effective_date",
  "item_group_id",
  "gender",
  "color",
  "size",
  "age_group",
  "material",
  "pattern",
  "shipping",
  "shipping_weight",
  "offer_disclaimer",
  "offer_disclaimer_url",
  "video[0].url",
  "video[0].tag[0]",
  "gtin",
  "product_tags[0]",
  "product_tags[1]",
  "style[0]",
]);

export const REQUIRED_COLUMNS = Object.freeze([
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
]);

const USER_AGENT =
  "MorchedCA-Catalogue-Sync/1.0 (+https://github.com/TheLime1/morchedca-catalogue-sync)";
const PRICE_PATTERN = /^(?:0|[1-9]\d*)\.\d{2} TND$/;
const STOREFRONT_HOST = "scolaire.clubafricain.com";

export class CatalogValidationError extends Error {
  constructor(errors) {
    super(`Catalog validation failed with ${errors.length} error(s).`);
    this.name = "CatalogValidationError";
    this.errors = errors;
  }
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase("fr");
}

function isHttpsUrl(value, expectedHost) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (!expectedHost || url.hostname.toLocaleLowerCase("en") === expectedHost)
    );
  } catch {
    return false;
  }
}

export function parseCsv(text) {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\r" && input[index + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      index += 1;
    } else if (character === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new Error("CSV ends inside a quoted field.");
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

export function csvTextToRows(text, { requireBom = true } = {}) {
  const errors = [];

  if (requireBom && !text.startsWith("\uFEFF")) {
    errors.push("CSV must start with a UTF-8 BOM.");
  }
  if (/^\s*</.test(text.replace(/^\uFEFF/, ""))) {
    errors.push("CSV content looks like HTML instead of a product feed.");
  }
  if (!text.endsWith("\r\n")) {
    errors.push("CSV must end with a CRLF record terminator.");
  }
  const withoutCrLf = text.replace(/\r\n/g, "");
  if (/[\r\n]/.test(withoutCrLf)) {
    errors.push("CSV uses inconsistent record endings; expected CRLF only.");
  }

  let records = [];
  try {
    records = parseCsv(text);
  } catch (error) {
    errors.push(error.message);
  }

  if (records.length === 0) {
    errors.push("CSV is empty.");
    return { errors, rows: [] };
  }

  const [header, ...dataRecords] = records;
  if (
    header.length !== CATALOG_COLUMNS.length ||
    header.some((column, index) => column !== CATALOG_COLUMNS[index])
  ) {
    errors.push(
      `CSV header must contain exactly ${CATALOG_COLUMNS.length} columns in the required order.`,
    );
  }

  const rows = dataRecords.map((values, rowIndex) => {
    if (values.length !== CATALOG_COLUMNS.length) {
      errors.push(
        `CSV row ${rowIndex + 2} has ${values.length} columns; expected ${CATALOG_COLUMNS.length}.`,
      );
    }
    return Object.fromEntries(
      CATALOG_COLUMNS.map((column, columnIndex) => [column, values[columnIndex] ?? ""]),
    );
  });

  return { errors, rows };
}

export function validateRows(rows, context = {}) {
  const errors = [];
  const seenIds = new Set();
  const rowsByGroup = new Map();

  if (!Array.isArray(rows) || rows.length === 0) {
    return ["Catalog must contain at least one real product row."];
  }

  for (const [index, row] of rows.entries()) {
    const label = `row ${index + 2}${row.id ? ` (id ${row.id})` : ""}`;

    for (const field of REQUIRED_COLUMNS) {
      if (!String(row[field] ?? "").trim()) {
        errors.push(`${label}: required field "${field}" is empty.`);
      }
    }

    const id = String(row.id ?? "").trim();
    if (id && seenIds.has(id)) {
      errors.push(`${label}: duplicate id "${id}".`);
    }
    seenIds.add(id);

    if (!["in stock", "out of stock"].includes(row.availability)) {
      errors.push(`${label}: availability must be "in stock" or "out of stock".`);
    }
    if (row.condition !== "new") {
      errors.push(`${label}: condition must be "new".`);
    }
    if (!PRICE_PATTERN.test(row.price)) {
      errors.push(`${label}: price "${row.price}" is not formatted as 0.00 TND.`);
    }
    if (row.sale_price && !PRICE_PATTERN.test(row.sale_price)) {
      errors.push(`${label}: sale_price "${row.sale_price}" is not formatted as 0.00 TND.`);
    }
    if (!isHttpsUrl(row.link, STOREFRONT_HOST)) {
      errors.push(`${label}: link must be an HTTPS ${STOREFRONT_HOST} URL.`);
    }
    if (!isHttpsUrl(row.image_link)) {
      errors.push(`${label}: image_link must be an HTTPS URL.`);
    }
    if (row.color && !row.item_group_id) {
      errors.push(`${label}: a color variant must have item_group_id.`);
    }

    if (row.item_group_id) {
      const group = rowsByGroup.get(row.item_group_id) ?? [];
      group.push(row);
      rowsByGroup.set(row.item_group_id, group);
    }
  }

  for (const [groupId, groupRows] of rowsByGroup) {
    if (!groupRows.some((row) => row.color)) continue;
    const colors = new Set();
    for (const row of groupRows) {
      if (!row.color) {
        errors.push(`variant group ${groupId}: every color variant must populate color.`);
        continue;
      }
      const key = normalize(row.color);
      if (colors.has(key)) {
        errors.push(`variant group ${groupId}: duplicate color "${row.color}".`);
      }
      colors.add(key);
    }
  }

  if (context.rowMetadata && context.activeProducts) {
    validateApiCoverage(rows, context, errors);
  }

  return errors;
}

function validateApiCoverage(rows, context, errors) {
  const metadataById = new Map(
    context.rowMetadata.map((metadata) => [String(metadata.id), metadata]),
  );
  const activeSlugs = new Set(context.activeProducts.map((product) => product.slug));
  const representedSlugs = new Set();
  const variantsBySlug = new Map();

  for (const row of rows) {
    const metadata = metadataById.get(String(row.id));
    if (!metadata) {
      errors.push(`id ${row.id}: missing internal API validation metadata.`);
      continue;
    }
    representedSlugs.add(metadata.parentSlug);
    if (metadata.isVariant) {
      const ids = variantsBySlug.get(metadata.parentSlug) ?? new Set();
      ids.add(String(row.id));
      variantsBySlug.set(metadata.parentSlug, ids);
      if (!row.item_group_id) {
        errors.push(`variant id ${row.id}: item_group_id is empty.`);
      }
    }
  }

  for (const slug of activeSlugs) {
    if (!representedSlugs.has(slug)) {
      errors.push(`active API product "${slug}" is missing from the feed.`);
    }
  }
  for (const slug of representedSlugs) {
    if (!activeSlugs.has(slug)) {
      errors.push(`feed contains stale parent product "${slug}" not present in the API.`);
    }
  }

  for (const product of context.activeProducts) {
    if (!Array.isArray(product.newVariants) || product.newVariants.length === 0) continue;
    const expectedIds = new Set(product.newVariants.map((variant) => String(variant.id)));
    const actualIds = variantsBySlug.get(product.slug) ?? new Set();
    for (const id of expectedIds) {
      if (!actualIds.has(id)) {
        errors.push(`variant group "${product.slug}" is missing API variant id "${id}".`);
      }
    }
    for (const id of actualIds) {
      if (!expectedIds.has(id)) {
        errors.push(`variant group "${product.slug}" contains stale variant id "${id}".`);
      }
    }
    if (actualIds.size !== expectedIds.size) {
      errors.push(
        `variant group "${product.slug}" has ${actualIds.size} rows; API returned ${expectedIds.size}.`,
      );
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeImage(url, attempt) {
  const headers = { Accept: "image/*", "User-Agent": USER_AGENT };
  let headStatus = "request failed";
  try {
    const headResponse = await fetch(url, {
      method: "HEAD",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    headStatus = String(headResponse.status);
    await headResponse.body?.cancel();
    if (headResponse.ok) return;
  } catch (error) {
    headStatus = error.message;
  }

  const getResponse = await fetch(url, {
    method: "GET",
    headers: { ...headers, Range: "bytes=0-1023" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  await getResponse.body?.cancel();
  if (!getResponse.ok) {
    throw new Error(
      `HEAD returned ${headStatus}; ranged GET returned ${getResponse.status} (attempt ${attempt}).`,
    );
  }
}

async function verifyOneImage(url, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      await probeImage(url, attempt);
      return;
    } catch (error) {
      lastError = error;
      if (attempt <= retries) await delay(500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${url}: ${lastError?.message ?? "request failed"}`);
}

export async function verifyImageUrls(
  urls,
  { concurrency = 6, retries = 2 } = {},
) {
  const uniqueUrls = [...new Set(urls)];
  const errors = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uniqueUrls.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await verifyOneImage(uniqueUrls[index], retries);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueUrls.length) }, () => worker()),
  );
  return { errors, uniqueImageCount: uniqueUrls.length };
}

export async function validateCatalog({ rows, context = {}, checkImages = true }) {
  const errors = validateRows(rows, context);
  let uniqueImageCount = new Set(rows.map((row) => row.image_link)).size;

  if (checkImages && errors.length === 0) {
    const imageResult = await verifyImageUrls(rows.map((row) => row.image_link));
    errors.push(...imageResult.errors.map((error) => `image check failed: ${error}`));
    uniqueImageCount = imageResult.uniqueImageCount;
  }

  if (errors.length > 0) throw new CatalogValidationError(errors);
  return { uniqueImageCount };
}

async function runCli() {
  const path = process.argv[2] ?? "public/catalog_products.csv";
  const text = await readFile(path, "utf8");
  const { errors, rows } = csvTextToRows(text);
  errors.push(...validateRows(rows));

  if (errors.length > 0) throw new CatalogValidationError(errors);
  console.log(`Validated ${rows.length} catalog rows in ${path}.`);
}

function reportFailure(error) {
  if (error instanceof CatalogValidationError) {
    console.error(error.message);
    for (const detail of error.errors) console.error(`- ${detail}`);
  } else {
    console.error(error?.stack ?? error);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(reportFailure);
}
