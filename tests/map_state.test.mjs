import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  markerHasCategoryImage,
  markerStyle,
  newsPageState,
  validateFeatureCollection,
  validateNewsItem,
  validateReport,
  validateTips,
} from "../map_state.mjs";

const imageUrl = "https://example.com/news.jpg";
const sourceUrl = "https://example.com/forum/page-3";

const expectedStyles = {
  "breaking-false": { color: "#8f211b", fillColor: "#d9483d", fillOpacity: 0.9, radius: 9, weight: 2 },
  "breaking-true": { color: "#7a120c", fillColor: "#ff3024", fillOpacity: 1, radius: 10, weight: 3 },
  "weekly-false": { color: "#184f75", fillColor: "#337dab", fillOpacity: 0.82, radius: 8, weight: 2 },
  "weekly-true": { color: "#053f73", fillColor: "#0788df", fillOpacity: 0.96, radius: 9, weight: 3 },
};

function item({ kind, withImage }) {
  const value = {
    status: kind === "breaking" ? "<strong>Breaking News (30.10.2026 04:15 Uhr)</strong>" : "<strong>This Week's News (29.10.2026 04:15 Uhr)</strong>",
    headline: "Test headline",
    summary: "Test construction progress.",
    source_url: sourceUrl,
  };
  if (withImage) {
    value.image_url = imageUrl;
  }
  return value;
}

function collection({ kind, primaryImage, olderImage }) {
  const properties = {
    name: "Test resort",
    ...item({ kind: kind, withImage: primaryImage }),
  };
  if (olderImage !== null) {
    properties.older_news = [item({ kind: "weekly", withImage: olderImage })];
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [11.0, 47.0] },
        properties: properties,
      },
    ],
  };
}

function absoluteUrls({ value }) {
  return [...new Set(value.match(/https:\/\/[^\s\"'<>;]+/g) ?? [])].sort();
}

function flattenSourceNews({ collection }) {
  // Flatten each feature to primary-then-older in server order, the exact sequence the popup paginates.
  return collection.features.flatMap((feature) => [feature.properties, ...(feature.properties.older_news ?? [])]);
}

// The marker colour and "intense" dot are the only signal a user gets before opening a popup, so the
// status-kind x image mapping must hold for every combination the two map layers can emit; a drift here
// silently mislabels breaking vs weekly news on the map. One body covers the closed 2x2x(single|carousel) matrix.
for (const scenario of [
  { id: "breaking-normal-single", kind: "breaking", primaryImage: false, olderImage: null, intense: false },
  { id: "breaking-intense-single", kind: "breaking", primaryImage: true, olderImage: null, intense: true },
  { id: "breaking-normal-carousel", kind: "breaking", primaryImage: false, olderImage: true, intense: false },
  { id: "breaking-intense-carousel", kind: "breaking", primaryImage: true, olderImage: false, intense: true },
  { id: "weekly-normal-single", kind: "weekly", primaryImage: false, olderImage: null, intense: false },
  { id: "weekly-intense-single", kind: "weekly", primaryImage: true, olderImage: null, intense: true },
  { id: "weekly-normal-carousel", kind: "weekly", primaryImage: false, olderImage: false, intense: false },
  { id: "weekly-intense-carousel", kind: "weekly", primaryImage: false, olderImage: true, intense: true },
]) {
  test(scenario.id, () => {
    const feature = validateFeatureCollection({
      value: collection({ kind: scenario.kind, primaryImage: scenario.primaryImage, olderImage: scenario.olderImage }),
    })[0];
    const hasImage = markerHasCategoryImage({ newsItems: feature.newsItems });
    assert.equal(hasImage, scenario.intense);
    assert.deepEqual(
      markerStyle({ kind: scenario.kind, hasImage: hasImage }),
      expectedStyles[scenario.kind + "-" + scenario.intense],
    );
    const first = newsPageState({ newsItems: feature.newsItems, activeIndex: 0 });
    assert.equal(first.pageCounterText, scenario.olderImage === null ? "Page 1 of 1" : "Page 1 of 2");
  });
}

// Pages 1 and 2 are published by the backend and are byte-for-byte the same shape; one parametrised body
// asserts both committed layers so an asymmetry (a field only one layer carries) cannot pass review. This
// guards the live backend->viewer contract: the renamed source_url, the new per-item headline, the lat/lon
// swap, and the preserved newest-to-oldest older_news order must survive validation exactly as served.
for (const mapFile of ["../page1_resort_news.geojson", "../page2_snow_conditions.geojson"]) {
  test("committed map data satisfies the feature contract: " + mapFile, async () => {
    const source = JSON.parse(await readFile(new URL(mapFile, import.meta.url), "utf8"));
    const features = validateFeatureCollection({ value: source });
    const sourceNewsItems = flattenSourceNews({ collection: source });
    const validatedNewsItems = features.flatMap((feature) => feature.newsItems);

    assert.equal(features.length, source.features.length);
    assert.ok(features.length > 0, "a published map layer must contain at least one feature");
    assert.deepEqual(
      features.map((feature) => feature.name),
      source.features.map((feature) => feature.properties.name),
    );
    assert.deepEqual(
      features.map((feature) => feature.coordinates),
      source.features.map((feature) => [feature.geometry.coordinates[1], feature.geometry.coordinates[0]]),
    );
    assert.deepEqual(
      features.map((feature) => feature.newsItems.length),
      source.features.map((feature) => 1 + (feature.properties.older_news?.length ?? 0)),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.headline),
      sourceNewsItems.map((newsItem) => newsItem.headline),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.summary),
      sourceNewsItems.map((newsItem) => newsItem.summary),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.sourceUrl),
      sourceNewsItems.map((newsItem) => new URL(newsItem.source_url).href),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.imageUrl),
      sourceNewsItems.map((newsItem) => (Object.hasOwn(newsItem, "image_url") ? new URL(newsItem.image_url).href : null)),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.status.text),
      sourceNewsItems.map((newsItem) => newsItem.status.slice("<strong>".length, -"</strong>".length)),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.status.kind),
      sourceNewsItems.map((newsItem) => (newsItem.status.startsWith("<strong>Breaking News (") ? "breaking" : "weekly")),
    );
  });
}

// Page 3 has no map and no schema enforcement anywhere else, so this is the only guard that the committed
// report parses, keeps its source link, and never exceeds the four-image gallery the layout is built for.
test("committed report data satisfies the report contract", async () => {
  const source = JSON.parse(await readFile(new URL("../page3_report.json", import.meta.url), "utf8"));
  const report = validateReport({ value: source });
  assert.equal(report.headline, source.headline);
  assert.equal(report.summary, source.summary);
  assert.equal(report.sourceUrl, new URL(source.source_url).href);
  assert.ok(report.imageUrls.length <= 4, "the report gallery renders at most four images");
  assert.deepEqual(
    report.imageUrls,
    (source.image_urls ?? []).map((url) => new URL(url).href),
  );
});

// Page 4's layout hard-wires three stacked tips and three pro/contra debates; this guards that the committed
// file actually carries exactly those counts with non-empty argument columns, so the panels never render blank.
test("committed tips data satisfies the tips contract", async () => {
  const source = JSON.parse(await readFile(new URL("../page4_tips.json", import.meta.url), "utf8"));
  const payload = validateTips({ value: source });
  assert.equal(payload.tips.length, 3);
  assert.equal(payload.controversial.length, 3);
  assert.deepEqual(
    payload.tips.map((tip) => tip.headline),
    source.tips.map((tip) => tip.headline),
  );
  for (const debate of payload.controversial) {
    assert.ok(debate.pro.length > 0, "every debate needs at least one pro argument");
    assert.ok(debate.contra.length > 0, "every debate needs at least one contra argument");
  }
});

// The migration's first rule is "no forbidden fallback": malformed or hallucinated model output must fail
// hard, never render partially. These cases pin the exact boundaries the validators must reject — each one
// is a shape the backend could realistically emit on a bad run, so the throw is the safety contract itself.
test("validators reject malformed page data instead of rendering it", () => {
  // A link the model fabricated as a bare key or non-URL must not reach an anchor href.
  assert.throws(() => validateNewsItem({ value: { status: "<strong>Breaking News (x)</strong>", headline: "h", summary: "s", source_url: "not-a-url" }, context: "case" }));
  // The new per-item headline is required everywhere display titles are shown.
  assert.throws(() => validateNewsItem({ value: { status: "<strong>Breaking News (x)</strong>", summary: "s", source_url: sourceUrl }, context: "case" }));
  // A fifth report image would overflow the four-slot gallery, so it is rejected rather than clipped silently.
  assert.throws(() => validateReport({ value: { headline: "h", summary: "s", source_url: sourceUrl, image_urls: [imageUrl, imageUrl, imageUrl, imageUrl, imageUrl] } }));
  assert.throws(() => validateReport({ value: { headline: "h", summary: "s" } }));
  // Page 4 is a fixed 3x3 layout; the wrong count must fail rather than leave a panel empty or orphaned.
  assert.throws(() => validateTips({ value: { tips: [], controversial: [{ headline: "h", pro: ["a"], contra: ["b"] }, { headline: "h", pro: ["a"], contra: ["b"] }, { headline: "h", pro: ["a"], contra: ["b"] }] } }));
  // A debate with no counter-arguments would render a one-sided row, defeating the pro/contra framing.
  assert.throws(() =>
    validateTips({
      value: {
        tips: [{ headline: "h", summary: "s" }, { headline: "h", summary: "s" }, { headline: "h", summary: "s" }],
        controversial: [{ headline: "h", pro: ["a"], contra: [] }, { headline: "h", pro: ["a"], contra: ["b"] }, { headline: "h", pro: ["a"], contra: ["b"] }],
      },
    }),
  );
});

// The viewer is a static, CSP-locked bundle; this inventory is the review gate on its entire outbound
// surface. It pins the four same-origin data files the app fetches, the exact script/style/CSP allowlist,
// and the complete set of absolute hosts, so a new remote dependency or a stray map.geojson reference
// cannot slip in unreviewed.
test("static bundle has the complete approved link inventory", async () => {
  const [readme, index, styles, script, state] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../map.css", import.meta.url), "utf8"),
    readFile(new URL("../map.js", import.meta.url), "utf8"),
    readFile(new URL("../map_state.mjs", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(
    [...new Set([...script.matchAll(/"(\.\/page[^"]+)"/g)].map((match) => match[1]))].sort(),
    ["./page1_resort_news.geojson", "./page2_snow_conditions.geojson", "./page3_report.json", "./page4_tips.json"],
  );
  assert.deepEqual(
    [...index.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1]),
    [
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
      "./map.css",
      "#/resort-news",
      "#/snow",
      "#/report",
      "#/tips",
    ],
  );
  assert.deepEqual(
    [...index.matchAll(/\ssrc="([^"]+)"/g)].map((match) => match[1]),
    ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "./map.js"],
  );
  assert.deepEqual(
    [...index.matchAll(/http-equiv="Content-Security-Policy" content="([^"]+)"/g)].map((match) => match[1]),
    [
      "default-src 'none'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com; img-src data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests",
    ],
  );
  assert.deepEqual(
    {
      readme: absoluteUrls({ value: readme }),
      index: absoluteUrls({ value: index }),
      styles: absoluteUrls({ value: styles }),
      script: absoluteUrls({ value: script }),
      state: absoluteUrls({ value: state }),
    },
    {
      readme: ["https://michaelmedek.github.io/alpin-map/"],
      index: [
        "https://unpkg.com",
        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
      ],
      styles: [],
      script: [
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://www.openstreetmap.org/copyright",
      ],
      state: [],
    },
  );
});
