import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRows,
  cleanDescription,
  serializeCsv,
} from "../scripts/build-catalog.mjs";
import {
  CATALOG_COLUMNS,
  csvTextToRows,
  validateRows,
} from "../scripts/validate-catalog.mjs";

const IMAGE_RED = "https://images.example/red_lg.webp";
const IMAGE_RED_SM = "https://images.example/red_sm.webp";
const IMAGE_BLUE = "https://images.example/blue_lg.webp";

test("cleanDescription decodes entities and removes HTML", () => {
  assert.equal(
    cleanDescription(
      '<div><p>Cahier&nbsp;&amp; bloc<br>Format &quot;A4&quot; &#39;test&#39;!!!</p></div>',
    ),
    'Cahier & bloc. Format "A4" \'test\'!',
  );
});

test("buildRows expands variants, maps colors, prices sales, and preserves stock", () => {
  const categories = [
    { _id: "parent", name: "Papeterie", parentId: null },
    { _id: "child", name: "Classement", parentId: "parent" },
  ];
  const products = [
    {
      _id: "product-1",
      reference: 77,
      name: "Portfolio",
      slug: "portfolio",
      description: "<p>Un portfolio.</p>",
      status: "shown",
      isDeleted: false,
      categories: ["child"],
      images: [{ lg: IMAGE_RED }, { lg: IMAGE_BLUE }],
      price: 10,
      comparePrice: 12,
      newStock: { outOfStock: false, continueSellingWhenOutOfStock: false },
      options: [{ name: "Couleur", values: [{ value: "Rouge" }, { value: "Bleu" }] }],
      newVariants: [
        {
          id: "variant-red",
          selectedValues: ["Rouge"],
          price: 9,
          comparePrice: 12,
          image: IMAGE_BLUE,
          stock: { outOfStock: true, continueSellingWhenOutOfStock: false },
        },
        {
          id: "variant-blue",
          selectedValues: ["Bleu"],
          price: 10,
          comparePrice: 10,
          image: "",
          stock: { outOfStock: true, continueSellingWhenOutOfStock: true },
        },
      ],
    },
  ];
  const mapping = {
    portfolio: {
      Rouge: IMAGE_RED,
      Bleu: IMAGE_BLUE,
      Vert: "https://images.example/removed-green_lg.webp",
    },
  };

  const result = buildRows(products, categories, mapping);

  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map(({ id, color, price, sale_price, availability, item_group_id }) => ({
      id,
      color,
      price,
      sale_price,
      availability,
      item_group_id,
    })),
    [
      {
        id: "variant-red",
        color: "Rouge",
        price: "12.00 TND",
        sale_price: "9.00 TND",
        availability: "out of stock",
        item_group_id: "77",
      },
      {
        id: "variant-blue",
        color: "Bleu",
        price: "10.00 TND",
        sale_price: "",
        availability: "in stock",
        item_group_id: "77",
      },
    ],
  );
  assert.equal(result.rows[0]["product_tags[0]"], "Papeterie > Classement");
  assert.deepEqual(result.rows.map(({ color }) => color), ["Rouge", "Bleu"]);
  assert.deepEqual(result.rows.map(({ image_link }) => image_link), [IMAGE_RED, IMAGE_BLUE]);
  assert.match(result.rows[0].description, /Options: Couleur: Rouge\.$/);
});

test("buildRows discovers current colors and images directly from live variant data", () => {
  const products = [
    {
      _id: "product-live",
      reference: 88,
      name: "Produit dynamique",
      slug: "produit-dynamique",
      description: "Description",
      status: "shown",
      isDeleted: false,
      categories: [],
      images: [{ sm: IMAGE_RED_SM, lg: IMAGE_RED }],
      price: 10,
      options: [{ name: "Couleur", values: [{ value: "Rouge" }] }],
      newVariants: [
        {
          id: "variant-live-red",
          selectedValues: ["Rouge"],
          price: 10,
          image: IMAGE_RED_SM,
          stock: { outOfStock: false, continueSellingWhenOutOfStock: false },
        },
      ],
    },
  ];

  const result = buildRows(products, [], {});

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, "variant-live-red");
  assert.equal(result.rows[0].color, "Rouge");
  assert.equal(result.rows[0].image_link, IMAGE_RED);
});

test("serializeCsv emits a BOM, exact header, valid quoting, and CRLF", () => {
  const row = Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, ""]));
  Object.assign(row, {
    id: "1",
    title: 'Titre, avec "guillemets"',
    description: "Description",
    availability: "in stock",
    condition: "new",
    price: "1.00 TND",
    link: "https://scolaire.clubafricain.com/product/test",
    image_link: "https://images.example/test.webp",
    brand: "El Morched",
  });

  const csv = serializeCsv([row]);
  const parsed = csvTextToRows(csv);

  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.equal(csv.endsWith("\r\n"), true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0].title, row.title);
  assert.deepEqual(validateRows(parsed.rows), []);
});

test("validation rejects duplicate ids", () => {
  const row = {
    id: "same",
    title: "Title",
    description: "Description",
    availability: "in stock",
    condition: "new",
    price: "1.00 TND",
    link: "https://scolaire.clubafricain.com/product/test",
    image_link: "https://images.example/test.webp",
    brand: "El Morched",
    color: "",
    item_group_id: "",
    sale_price: "",
  };
  assert.match(validateRows([row, row]).join("\n"), /duplicate id/);
});

test("validation rejects product links from the previous storefront host", () => {
  const row = {
    id: "legacy-host",
    title: "Title",
    description: "Description",
    availability: "in stock",
    condition: "new",
    price: "1.00 TND",
    link: "https://morchedca.store/product/test",
    image_link: "https://images.example/test.webp",
    brand: "El Morched",
    color: "",
    item_group_id: "",
    sale_price: "",
  };

  assert.match(
    validateRows([row]).join("\n"),
    /link must be an HTTPS scolaire\.clubafricain\.com URL/,
  );
});
