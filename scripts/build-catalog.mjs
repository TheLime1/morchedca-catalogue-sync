#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CATALOG_COLUMNS,
  CatalogValidationError,
  csvTextToRows,
  validateCatalog,
  validateRows,
} from "./validate-catalog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTS_ENDPOINT = "https://morchedca.store/api/v1/products";
const CATEGORIES_ENDPOINT = "https://morchedca.store/api/v1/categories";
const MAPPING_PATH = resolve(ROOT, "data/variant-image-mapping.json");
const PUBLIC_PATH = resolve(ROOT, "public/catalog_products.csv");
const TEMP_PATH = resolve(ROOT, ".catalog-products.pending.csv");
const PAGE_LIMIT = 100;
const USER_AGENT =
  "MorchedCA-Catalogue-Sync/1.0 (+https://github.com/TheLime1/morchedca-catalogue-sync)";

const OPTION_FIELDS = new Map([
  ["couleur", "color"],
  ["color", "color"],
  ["taille", "size"],
  ["size", "size"],
  ["matiere", "material"],
  ["material", "material"],
  ["motif", "pattern"],
  ["pattern", "pattern"],
]);

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase("fr");
}

function nonEmpty(value) {
  if (value === null || value === undefined) return undefined;
  const string = String(value).trim();
  return string ? value : undefined;
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

async function fetchJson(url, { retries = 3, timeout = 25_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      if (!body.trim() || /^\s*</.test(body)) {
        throw new Error("received an empty or HTML response instead of JSON");
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        throw new Error(`invalid JSON: ${error.message}`);
      }
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) {
        throw new Error('JSON response is missing its "data" array');
      }
      if (parsed.success === false) {
        throw new Error("JSON API explicitly reported success=false");
      }
      if (!Number.isInteger(parsed.count) || parsed.count < 0) {
        throw new Error('JSON response is missing a valid non-negative "count"');
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt <= retries) await delay(700 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Unable to fetch ${url}: ${lastError?.message ?? "unknown error"}`);
}

export async function fetchAllPages(endpoint) {
  const items = [];
  const seenIds = new Set();
  let expectedCount;

  for (let page = 1; page <= 1_000; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(PAGE_LIMIT));
    const payload = await fetchJson(url);

    expectedCount ??= payload.count;
    if (payload.count !== expectedCount) {
      throw new Error(
        `${endpoint}: count changed from ${expectedCount} to ${payload.count} during pagination; retry later.`,
      );
    }

    for (const item of payload.data) {
      const id = nonEmpty(item?._id) ?? nonEmpty(item?.id);
      if (!id) throw new Error(`${endpoint}: an API item has no stable id.`);
      if (seenIds.has(String(id))) {
        throw new Error(`${endpoint}: duplicate item id "${id}" across paginated responses.`);
      }
      seenIds.add(String(id));
      items.push(item);
    }

    if (items.length >= expectedCount) break;
    if (payload.data.length === 0) {
      throw new Error(
        `${endpoint}: pagination ended at ${items.length} items but count reports ${expectedCount}.`,
      );
    }
  }

  if (items.length !== expectedCount) {
    throw new Error(`${endpoint}: fetched ${items.length} items but count reports ${expectedCount}.`);
  }
  return items;
}

function decodeEntities(value) {
  const named = new Map([
    ["nbsp", " "],
    ["amp", "&"],
    ["quot", '"'],
    ["apos", "'"],
    ["#39", "'"],
    ["lt", "<"],
    ["gt", ">"],
  ]);
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLocaleLowerCase("en");
    if (named.has(key)) return named.get(key);
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return match;
  });
}

export function cleanDescription(html) {
  let text = String(html ?? "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  text = decodeEntities(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u00a0\t ]+/g, " ")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:!?])(?:\s*\1)+/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/(?:\.\s*){2,}/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text.replace(/^\.+|\.+$/g, "").trim();
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function bestImage(image) {
  if (typeof image === "string") return isHttpUrl(image) ? image : "";
  if (!image || typeof image !== "object") return "";
  for (const size of ["lg", "md", "sm"]) {
    if (isHttpUrl(image[size])) return image[size];
  }
  if (isHttpUrl(image.url)) return image.url;
  return "";
}

function galleryUrls(product) {
  const urls = new Set();
  for (const image of product.images ?? []) {
    if (typeof image === "string" && isHttpUrl(image)) urls.add(image);
    if (image && typeof image === "object") {
      for (const value of Object.values(image)) {
        if (typeof value === "string" && isHttpUrl(value)) urls.add(value);
      }
    }
  }
  return urls;
}

function assetKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname.replace(/_(?:lg|md|sm)(?=\.[^.]+$)/i, "")}`;
  } catch {
    return url;
  }
}

function makeMappingLookup(mappingForProduct, slug) {
  if (!mappingForProduct || typeof mappingForProduct !== "object" || Array.isArray(mappingForProduct)) {
    return undefined;
  }
  const lookup = new Map();
  for (const [color, url] of Object.entries(mappingForProduct)) {
    const key = normalize(color);
    if (lookup.has(key)) {
      throw new Error(`${slug}: mapping contains duplicate normalized color "${color}".`);
    }
    lookup.set(key, { color, url });
  }
  return lookup;
}

function validateMappingEntry(slug, mappingLookup, gallery) {
  if (!mappingLookup) return;
  for (const { color, url } of mappingLookup.values()) {
    if (!isHttpUrl(url)) {
      throw new Error(`${slug} / ${color}: mapped image is not a valid HTTP URL.`);
    }
    if (!gallery.has(url)) {
      throw new Error(`${slug} / ${color}: mapped image is no longer part of the API gallery.`);
    }
  }
}

function valueAsText(value) {
  if (value && typeof value === "object") return String(value.value ?? value.name ?? value.id ?? "").trim();
  return String(value ?? "").trim();
}

function optionSelections(product, variant) {
  const options = Array.isArray(product.options) ? product.options : [];
  const selected = Array.isArray(variant.selectedValues) ? variant.selectedValues : [];
  if (selected.length !== options.length) {
    throw new Error(
      `${product.slug} / ${variant.id}: selectedValues has ${selected.length} entries but options has ${options.length}.`,
    );
  }
  return options.map((option, index) => ({
    name: valueAsText(option.name),
    value: valueAsText(selected[index]),
    field: OPTION_FIELDS.get(normalize(option.name)),
  }));
}

function numberOverride(variant, product, key) {
  const value = firstDefined(variant?.[key], product?.[key]);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${product.slug}${variant ? ` / ${variant.id}` : ""}: invalid ${key} "${value}".`);
  }
  return number;
}

function money(value) {
  return `${value.toFixed(2)} TND`;
}

function pricing(product, variant) {
  const current = numberOverride(variant, product, "price");
  const comparisonValue = firstDefined(variant?.comparePrice, product?.comparePrice, 0);
  const comparison = Number(comparisonValue);
  if (!Number.isFinite(comparison) || comparison < 0) {
    throw new Error(
      `${product.slug}${variant ? ` / ${variant.id}` : ""}: invalid comparePrice "${comparisonValue}".`,
    );
  }
  if (comparison > current) return { price: money(comparison), salePrice: money(current) };
  return { price: money(current), salePrice: "" };
}

function effectiveStock(product, variant) {
  return firstDefined(variant?.stock, variant?.newStock, product.newStock, product.stock) ?? {};
}

function availability(product, variant) {
  const stock = effectiveStock(product, variant);
  if (
    product.status === "outOfStock" ||
    (stock.outOfStock === true && stock.continueSellingWhenOutOfStock !== true)
  ) {
    return "out of stock";
  }
  return "in stock";
}

function quantity(product, variant) {
  const stock = effectiveStock(product, variant);
  const value = firstDefined(variant?.quantity, stock.quantity, product.quantity);
  if (value === undefined) return "";
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? String(number) : "";
}

function categoryHierarchy(product, categoriesById) {
  const paths = [];
  for (const categoryId of product.categories ?? []) {
    const seen = new Set();
    const names = [];
    let category = categoriesById.get(String(categoryId));
    if (!category) throw new Error(`${product.slug}: unknown category id "${categoryId}".`);
    while (category) {
      if (seen.has(String(category._id))) {
        throw new Error(`${product.slug}: category hierarchy contains a cycle.`);
      }
      seen.add(String(category._id));
      names.unshift(String(category.name ?? "").trim());
      category = category.parentId ? categoriesById.get(String(category.parentId)) : undefined;
    }
    paths.push(names.filter(Boolean).join(" > "));
  }
  return paths.filter(Boolean).join(" | ");
}

function baseRow(product, categoryTag) {
  const parentId = String(nonEmpty(product.reference) ?? nonEmpty(product._id) ?? "");
  if (!parentId) throw new Error(`${product.slug}: product has no reference or _id.`);
  if (!String(product.slug ?? "").trim()) throw new Error(`product ${parentId}: slug is empty.`);
  const name = cleanDescription(product.name);
  if (!name) throw new Error(`${product.slug}: product name is empty.`);
  const description =
    cleanDescription(product.description) || cleanDescription(product.seo?.description) || name;
  return {
    parentId,
    name,
    description,
    row: {
      id: parentId,
      title: name,
      description,
      availability: "",
      condition: "new",
      price: "",
      link: `https://morchedca.store/product/${encodeURIComponent(product.slug)}`,
      image_link: "",
      brand: "El Morched",
      google_product_category: "Office Supplies",
      fb_product_category: "",
      quantity_to_sell_on_facebook: "",
      sale_price: "",
      sale_price_effective_date: "",
      item_group_id: "",
      gender: "",
      color: "",
      size: "",
      age_group: "",
      material: "",
      pattern: "",
      shipping: "",
      shipping_weight: "",
      offer_disclaimer: "",
      offer_disclaimer_url: "",
      "video[0].url": "",
      "video[0].tag[0]": "",
      gtin: "",
      "product_tags[0]": categoryTag,
      "product_tags[1]": "morchedca.store",
      "style[0]": "",
    },
  };
}

function isEligible(product) {
  return (
    product?.isDeleted !== true &&
    product?.deleted !== true &&
    product?.linkOnly !== true &&
    product?.isLinkOnly !== true &&
    product?.landingPageOnly !== true &&
    product?.isLandingPageOnly !== true &&
    ["shown", "outOfStock"].includes(product?.status)
  );
}

export function buildRows(products, categories, mapping) {
  const activeProducts = products.filter(isEligible);
  const categoriesById = new Map(categories.map((category) => [String(category._id), category]));
  const rows = [];
  const rowMetadata = [];
  let standaloneRows = 0;
  let variantProducts = 0;
  let variantRows = 0;
  let outOfStockRows = 0;

  for (const product of activeProducts) {
    const categoryTag = categoryHierarchy(product, categoriesById);
    const base = baseRow(product, categoryTag);
    const variants = Array.isArray(product.newVariants) ? product.newVariants : [];
    const gallery = galleryUrls(product);

    if (gallery.size === 0) throw new Error(`${product.slug}: product gallery is empty.`);

    if (variants.length === 0) {
      const image = bestImage(product.images?.[0]);
      if (!image) throw new Error(`${product.slug}: first product image is missing or invalid.`);
      const prices = pricing(product);
      const row = {
        ...base.row,
        availability: availability(product),
        price: prices.price,
        image_link: image,
        quantity_to_sell_on_facebook: quantity(product),
        sale_price: prices.salePrice,
        gtin: String(nonEmpty(product.barcode) ?? ""),
      };
      rows.push(row);
      rowMetadata.push({ id: row.id, parentSlug: product.slug, isVariant: false });
      standaloneRows += 1;
      if (row.availability === "out of stock") outOfStockRows += 1;
      continue;
    }

    variantProducts += 1;
    const mappingLookup = makeMappingLookup(mapping[product.slug], product.slug);
    if (!mappingLookup) {
      throw new Error(
        `${product.slug}: new variant product or missing image mapping requires verification.`,
      );
    }
    validateMappingEntry(product.slug, mappingLookup, gallery);
    const groupImageKeys = new Map();
    const currentColors = new Set();
    let groupHasColor = false;

    for (const variant of variants) {
      if (!nonEmpty(variant.id)) throw new Error(`${product.slug}: a variant has no stable id.`);
      const selections = optionSelections(product, variant);
      const optionValues = selections.map(({ value }) => value);
      if (optionValues.some((value) => !value)) {
        throw new Error(`${product.slug} / ${variant.id}: an option selection is empty.`);
      }

      const fields = Object.fromEntries(
        selections.filter(({ field }) => field).map(({ field, value }) => [field, value]),
      );
      const color = fields.color ?? "";
      if (selections.some(({ field }) => field === "color")) {
        groupHasColor = true;
        if (!color) throw new Error(`${product.slug} / ${variant.id}: color selection is empty.`);
        const colorKey = normalize(color);
        if (currentColors.has(colorKey)) {
          throw new Error(`${product.slug}: duplicate color variant "${color}".`);
        }
        currentColors.add(colorKey);
      }

      let image = bestImage(variant.image);
      if (!image) {
        if (!color) {
          throw new Error(
            `${product.slug} / ${variant.id}: no explicit image and no color available for verified mapping.`,
          );
        }
        if (!mappingLookup) {
          throw new Error(
            `${product.slug} / ${color}: new variant product or missing image mapping requires verification.`,
          );
        }
        image = mappingLookup.get(normalize(color))?.url ?? "";
        if (!image) {
          throw new Error(`${product.slug} / ${color}: missing verified image mapping.`);
        }
      }
      if (!gallery.has(image)) {
        throw new Error(`${product.slug} / ${color || variant.id}: selected image is not in the gallery.`);
      }

      if (color) {
        const key = assetKey(image);
        const previousColor = groupImageKeys.get(key);
        if (previousColor && normalize(previousColor) !== normalize(color)) {
          throw new Error(
            `${product.slug}: colors "${previousColor}" and "${color}" use the same image.`,
          );
        }
        groupImageKeys.set(key, color);
      }

      const prices = pricing(product, variant);
      const optionLabel = selections.map(({ name, value }) => `${name}: ${value}`).join(", ");
      const row = {
        ...base.row,
        id: String(variant.id),
        title: `${base.name} – ${optionValues.join(" – ")}`,
        description: `${base.description}. Options: ${optionLabel}.`
          .replace(/\.{2,}/g, ".")
          .trim(),
        availability: availability(product, variant),
        price: prices.price,
        image_link: image,
        quantity_to_sell_on_facebook: quantity(product, variant),
        sale_price: prices.salePrice,
        item_group_id: base.parentId,
        color,
        size: fields.size ?? "",
        material: fields.material ?? "",
        pattern: fields.pattern ?? "",
        gtin: String(nonEmpty(variant.barcode) ?? nonEmpty(product.barcode) ?? ""),
      };
      rows.push(row);
      rowMetadata.push({ id: row.id, parentSlug: product.slug, isVariant: true });
      variantRows += 1;
      if (row.availability === "out of stock") outOfStockRows += 1;
    }

    if (!groupHasColor) {
      throw new Error(`${product.slug}: variant product has no recognized color option to verify.`);
    }
    for (const colorKey of currentColors) {
      if (!mappingLookup.has(colorKey)) {
        throw new Error(`${product.slug}: new color is missing from the verified image mapping.`);
      }
    }
    for (const { color } of mappingLookup.values()) {
      if (!currentColors.has(normalize(color))) {
        throw new Error(`${product.slug} / ${color}: mapping contains a stale color.`);
      }
    }
  }

  return {
    activeProducts,
    rows,
    rowMetadata,
    summary: {
      apiParentProducts: activeProducts.length,
      standaloneRows,
      variantProducts,
      variantRows,
      totalRows: rows.length,
      variantGroups: variantProducts,
      outOfStockRows,
    },
  };
}

function quoteCsv(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function serializeCsv(rows) {
  const records = [
    CATALOG_COLUMNS.map(quoteCsv).join(","),
    ...rows.map((row) => CATALOG_COLUMNS.map((column) => quoteCsv(row[column])).join(",")),
  ];
  return `\uFEFF${records.join("\r\n")}\r\n`;
}

async function loadMapping() {
  const text = await readFile(MAPPING_PATH, "utf8");
  const mapping = JSON.parse(text);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new Error("variant-image-mapping.json must contain a JSON object.");
  }
  return mapping;
}

function reportValidationError(error) {
  if (error instanceof CatalogValidationError) {
    console.error(error.message);
    for (const detail of error.errors) console.error(`- ${detail}`);
  } else {
    console.error(error?.stack ?? error);
  }
}

export async function buildCatalog() {
  await rm(TEMP_PATH, { force: true });
  const [products, categories, mapping] = await Promise.all([
    fetchAllPages(PRODUCTS_ENDPOINT),
    fetchAllPages(CATEGORIES_ENDPOINT),
    loadMapping(),
  ]);

  const result = buildRows(products, categories, mapping);
  const validation = await validateCatalog({
    rows: result.rows,
    context: {
      activeProducts: result.activeProducts,
      rowMetadata: result.rowMetadata,
    },
    checkImages: process.env.SKIP_IMAGE_CHECKS !== "1",
  });

  const csv = serializeCsv(result.rows);
  const serialized = csvTextToRows(csv);
  const serializedErrors = [...serialized.errors, ...validateRows(serialized.rows)];
  if (serializedErrors.length > 0) throw new CatalogValidationError(serializedErrors);

  await mkdir(dirname(PUBLIC_PATH), { recursive: true });
  await writeFile(TEMP_PATH, csv, "utf8");
  await rename(TEMP_PATH, PUBLIC_PATH);

  const summary = { ...result.summary, uniqueImageUrls: validation.uniqueImageCount };
  console.log("Catalog generated and validated successfully:");
  console.log(`- API parent-product count: ${summary.apiParentProducts}`);
  console.log(`- standalone-row count: ${summary.standaloneRows}`);
  console.log(`- variant-product count: ${summary.variantProducts}`);
  console.log(`- variant-row count: ${summary.variantRows}`);
  console.log(`- total catalog rows: ${summary.totalRows}`);
  console.log(`- number of variant groups: ${summary.variantGroups}`);
  console.log(`- unique image URL count: ${summary.uniqueImageUrls}`);
  console.log(`- out-of-stock row count: ${summary.outOfStockRows}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCatalog().catch((error) => {
    reportValidationError(error);
    process.exitCode = 1;
  });
}
