import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  formatRunTimestamp,
  markerHasCategoryImage,
  markerStyle,
  newsPageState,
  statusLabel,
  validateBriefing,
  validateFeatureCollection,
  validateNewsItem,
} from "../map_state.mjs";

const imageUrl = "https://example.com/news.jpg";
const sourceUrl = "https://example.com/forum/page-3";

const expectedStyles = {
  "breaking-false": { color: "#8f211b", fillColor: "#d9483d", fillOpacity: 0.9, radius: 9, weight: 2 },
  "breaking-true": { color: "#7a120c", fillColor: "#ff3024", fillOpacity: 1, radius: 10, weight: 3 },
  "weekly-false": { color: "#184f75", fillColor: "#337dab", fillOpacity: 0.82, radius: 8, weight: 2 },
  "weekly-true": { color: "#053f73", fillColor: "#0788df", fillOpacity: 0.96, radius: 9, weight: 3 },
};

function item({ recency, withImage }) {
  const value = {
    recency: recency,
    timestamp: recency === "breaking" ? "31.10.2026 00:26 Uhr" : "29.10.2026 03:47 Uhr",
    headline: "Test headline",
    summary: "Test construction progress.",
    source_url: sourceUrl,
  };
  if (withImage) {
    value.image_url = imageUrl;
  }
  return value;
}

function collection({ recency, primaryImage, olderImage }) {
  const properties = {
    name: "Test resort",
    ...item({ recency: recency, withImage: primaryImage }),
  };
  if (olderImage !== null) {
    properties.older_news = [item({ recency: "weekly", withImage: olderImage })];
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

// The marker colour and "intense" dot are the only signal before a popup opens, so the recency x image
// mapping must hold for every combination the two map layers emit; a drift here silently mislabels breaking
// vs weekly on the map. One body covers the closed 2x2x(single|carousel) matrix, now keyed on the data recency.
for (const scenario of [
  { id: "breaking-normal-single", recency: "breaking", primaryImage: false, olderImage: null, intense: false },
  { id: "breaking-intense-single", recency: "breaking", primaryImage: true, olderImage: null, intense: true },
  { id: "breaking-normal-carousel", recency: "breaking", primaryImage: false, olderImage: true, intense: false },
  { id: "breaking-intense-carousel", recency: "breaking", primaryImage: true, olderImage: false, intense: true },
  { id: "weekly-normal-single", recency: "weekly", primaryImage: false, olderImage: null, intense: false },
  { id: "weekly-intense-single", recency: "weekly", primaryImage: true, olderImage: null, intense: true },
  { id: "weekly-normal-carousel", recency: "weekly", primaryImage: false, olderImage: false, intense: false },
  { id: "weekly-intense-carousel", recency: "weekly", primaryImage: false, olderImage: true, intense: true },
]) {
  test(scenario.id, () => {
    const feature = validateFeatureCollection({
      value: collection({ recency: scenario.recency, primaryImage: scenario.primaryImage, olderImage: scenario.olderImage }),
    })[0];
    const hasImage = markerHasCategoryImage({ newsItems: feature.newsItems });
    assert.equal(hasImage, scenario.intense);
    assert.deepEqual(
      markerStyle({ kind: scenario.recency, hasImage: hasImage }),
      expectedStyles[scenario.recency + "-" + scenario.intense],
    );
    const first = newsPageState({ newsItems: feature.newsItems, activeIndex: 0 });
    assert.equal(first.pageCounterText, scenario.olderImage === null ? "Page 1 of 1" : "Page 1 of 2");
  });
}

// The label text ("Breaking News" / "This Week's News") is a viewer concern now that the data carries only a
// recency token; this guards that both recencies map to a label and anything else is rejected, so a producer
// that ever emitted a formatted status again (the exact bug this migration removed) cannot pass silently.
test("statusLabel maps each recency and rejects anything else", () => {
  assert.equal(statusLabel({ recency: "breaking" }), "Breaking News");
  assert.equal(statusLabel({ recency: "weekly" }), "This Week's News");
  assert.throws(() => statusLabel({ recency: "<strong>Breaking News</strong>" }));
  assert.throws(() => statusLabel({ recency: "outdated" }));
});

// The header date is the one place a UTC instant becomes human text; this pins the UTC->Europe/Berlin
// conversion (Oct 31 is already winter time, UTC+1) and the "Uhr" convention that matches the per-pin
// timestamps, and rejects a non-ISO value so a broken metadata field shows nothing rather than "Invalid Date".
test("formatRunTimestamp renders the run instant in Europe/Berlin wall-clock", () => {
  assert.equal(formatRunTimestamp({ value: "2026-10-31T02:56:00Z" }), "31.10.2026 03:56 Uhr");
  // A summer instant lands on UTC+2, proving the offset is derived, not hard-coded.
  assert.equal(formatRunTimestamp({ value: "2026-07-01T10:00:00Z" }), "01.07.2026 12:00 Uhr");
  assert.throws(() => formatRunTimestamp({ value: "not-a-timestamp" }));
});

// Pages 1 and 2 are published by the backend and are the same shape; one parametrised body asserts both so an
// asymmetry cannot pass. It guards the live backend->viewer contract AND the migration's core rule that the
// data carries no formatting: recency is a bare token, the timestamp holds no markup, and headline/source_url
// plus the newest-to-oldest older_news order survive validation exactly as served.
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
    for (const newsItem of validatedNewsItems) {
      // The producer emits only data: a bare recency token and a timestamp free of any HTML.
      assert.ok(newsItem.recency === "breaking" || newsItem.recency === "weekly");
      assert.ok(newsItem.timestamp.includes("<") === false, "timestamp must carry no markup");
    }
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.headline),
      sourceNewsItems.map((newsItem) => newsItem.headline),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.recency),
      sourceNewsItems.map((newsItem) => newsItem.recency),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.sourceUrl),
      sourceNewsItems.map((newsItem) => new URL(newsItem.source_url).href),
    );
    assert.deepEqual(
      validatedNewsItems.map((newsItem) => newsItem.imageUrl),
      sourceNewsItems.map((newsItem) => (Object.hasOwn(newsItem, "image_url") ? new URL(newsItem.image_url).href : null)),
    );
  });
}

// The collapsed page 3 is the whole non-map viewer and the sole home of the run timestamp, so this guards that
// the committed file parses, its generated_at is a real instant the header can format, the gallery stays within
// four images, and the fixed 3-tips / 3-debates layout is actually satisfied with non-empty argument columns.
test("committed briefing data satisfies the collapsed page contract", async () => {
  const source = JSON.parse(await readFile(new URL("../page3_briefing.json", import.meta.url), "utf8"));
  const briefing = validateBriefing({ value: source });

  assert.equal(briefing.generatedAt, source.generated_at);
  assert.doesNotThrow(() => formatRunTimestamp({ value: briefing.generatedAt }));
  assert.ok(briefing.reports.length >= 1, "a daily run carries at least one report");
  assert.ok(briefing.reports[0].imageUrls.length <= 6, "the report gallery renders at most six images");
  assert.equal(briefing.reports[0].sourceUrl, new URL(source.reports[0].source_url).href);
  assert.equal(briefing.tips.length, 3);
  assert.equal(briefing.controversial.length, 3);
  for (const debate of briefing.controversial) {
    assert.ok(debate.pro.length > 0, "every debate needs at least one pro argument");
    assert.ok(debate.contra.length > 0, "every debate needs at least one contra argument");
  }
});

// The migration's first rule is "no forbidden fallback": malformed or hallucinated output must fail hard, never
// render partially. Each case is a shape the backend could realistically emit on a bad run, so the throw is the
// safety contract. The recency and mandatory-source_url cases pin exactly the new fields this migration introduced.
test("validators reject malformed page data instead of rendering it", () => {
  const base = { recency: "breaking", timestamp: "31.10.2026 00:26 Uhr", headline: "h", summary: "s", source_url: sourceUrl };
  // A formatted status string where a bare recency token is required is the exact pre-migration bug; reject it.
  assert.throws(() => validateNewsItem({ value: { ...base, recency: "<strong>Breaking News</strong>" }, context: "case" }));
  // A fabricated or non-URL source must never reach an anchor href.
  assert.throws(() => validateNewsItem({ value: { ...base, source_url: "not-a-url" }, context: "case" }));
  // The per-item timestamp is required for both the pin label and the popup status line.
  assert.throws(() => validateNewsItem({ value: { recency: "weekly", headline: "h", summary: "s", source_url: sourceUrl }, context: "case" }));
  const report = { headline: "h", summary: "s", source_url: sourceUrl, image_urls: [] };
  // Every valid tip and debate now carries a mandatory source_url, so the valid shapes include it.
  const tip = { headline: "h", summary: "s", source_url: sourceUrl };
  const tips = [tip, tip, tip];
  const debate = { headline: "h", pro: ["a"], contra: ["b"], source_url: sourceUrl };
  const controversial = [debate, debate, debate];
  // A seventh report image would overflow the six-slot gallery, so it is rejected rather than clipped silently.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [{ ...report, image_urls: [imageUrl, imageUrl, imageUrl, imageUrl, imageUrl, imageUrl, imageUrl] }], tips: tips, controversial: controversial } }));
  // The fixed 3x3 layout must fail on the wrong count rather than leave a panel empty or orphaned.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: tips.slice(0, 2), controversial: controversial } }));
  // A debate with no counter-arguments would render a one-sided row, defeating the pro/contra framing.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: tips, controversial: [{ ...debate, contra: [] }, debate, debate] } }));
  // A tip source_url is now mandatory; a missing one must fail rather than render a tip without its link.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: [{ headline: "h", summary: "s" }, tip, tip], controversial: controversial } }));
  // A debate source_url is now mandatory; a missing discussion link must fail rather than render without it.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: tips, controversial: [{ headline: "h", pro: ["a"], contra: ["b"] }, debate, debate] } }));
  // A present source_url must still be a real URL, not a leftover key or junk string.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: tips, controversial: [{ ...debate, source_url: "page_abc" }, debate, debate] } }));
});

// The viewer is a static, CSP-locked bundle; this inventory is the review gate on its entire outbound surface.
// It pins the four same-origin data files the app fetches (the three daily pages plus the weekly markdown), the
// exact script/style/CSP allowlist, and every absolute host, so a new remote dependency or a stray file cannot
// slip in unreviewed.
test("static bundle has the complete approved link inventory", async () => {
  const [readme, index, styles, script, state] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../map.css", import.meta.url), "utf8"),
    readFile(new URL("../map.js", import.meta.url), "utf8"),
    readFile(new URL("../map_state.mjs", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(
    [...new Set([...script.matchAll(/"(\.\/[\w-]+\.(?:geojson|json|md))"/g)].map((match) => match[1]))].sort(),
    ["./page1_resort_news.geojson", "./page2_snow_conditions.geojson", "./page3_briefing.json", "./weekly_briefing.md"],
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
      "#/debates",
      "#/weekly",
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
