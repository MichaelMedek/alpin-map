import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  compareFeaturesForNav,
  featureRecencyKey,
  formatRunTimestamp,
  markerHasCategoryImage,
  markerStyle,
  pagerState,
  reportWedgePoints,
  statusLabel,
  validateBriefing,
  validateFeatureCollection,
  validateNewsItem,
  validateReportArtifact,
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
    const first = pagerState({ count: feature.newsItems.length, index: 0, label: "Update" });
    assert.equal(first.counterText, scenario.olderImage === null ? "Update 1 of 1" : "Update 1 of 2");
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
// six images, and the bounded 1..3 tips / 1..3 debates layout is satisfied with non-empty argument columns.
test("committed briefing data satisfies the collapsed page contract", async () => {
  const source = JSON.parse(await readFile(new URL("../page3_briefing.json", import.meta.url), "utf8"));
  const briefing = validateBriefing({ value: source });

  assert.equal(briefing.generatedAt, source.generated_at);
  assert.doesNotThrow(() => formatRunTimestamp({ value: briefing.generatedAt }));
  assert.ok(briefing.reports.length >= 1, "a daily run carries at least one report");
  assert.ok(briefing.reports[0].imageUrls.length <= 6, "the report gallery renders at most six images");
  assert.equal(briefing.reports[0].sourceUrl, new URL(source.reports[0].source_url).href);
  assert.ok(briefing.tips.length >= 1 && briefing.tips.length <= 3, "the run carries one to three tips");
  assert.ok(briefing.controversial.length >= 1 && briefing.controversial.length <= 3, "the run carries one to three debates");
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
  // The whole timestamp string is validated, not just a numeric prefix: trailing garbage after a valid time is
  // rejected rather than silently accepted and sorted on its prefix.
  assert.throws(() => validateNewsItem({ value: { ...base, timestamp: "31.10.2026 00:26 nonsense" }, context: "case" }), /format/);
  // A well-shaped but impossible calendar date (31 February) or clock time (99:99) is malformed, not a real instant.
  assert.throws(() => validateNewsItem({ value: { ...base, timestamp: "31.02.2026 00:26 Uhr" }, context: "case" }), /real calendar/);
  assert.throws(() => validateNewsItem({ value: { ...base, timestamp: "10.10.2026 99:99 Uhr" }, context: "case" }), /real calendar/);
  // Both real shapes the producer emits are accepted: with the trailing " Uhr" and the bare form, including the
  // leap-day 29 February 2028 (a real leap year), so valid data always renders.
  assert.doesNotThrow(() => validateNewsItem({ value: { ...base, timestamp: "26.11.2026 02:03 Uhr" }, context: "case" }));
  assert.doesNotThrow(() => validateNewsItem({ value: { ...base, timestamp: "26.11.2026 02:03" }, context: "case" }));
  assert.doesNotThrow(() => validateNewsItem({ value: { ...base, timestamp: "29.02.2028 12:00 Uhr" }, context: "case" }));
  const report = { headline: "h", summary: "s", source_url: sourceUrl, image_urls: [] };
  // Every valid tip and debate now carries a mandatory source_url, so the valid shapes include it.
  const tip = { headline: "h", summary: "s", source_url: sourceUrl };
  const tips = [tip, tip, tip];
  const debate = { headline: "h", pro: ["a"], contra: ["b"], source_url: sourceUrl };
  const controversial = [debate, debate, debate];
  // A seventh report image would overflow the six-slot gallery, so it is rejected rather than clipped silently.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [{ ...report, image_urls: [imageUrl, imageUrl, imageUrl, imageUrl, imageUrl, imageUrl, imageUrl] }], tips: tips, controversial: controversial } }));
  // Tips and debates are bounded 1..3 (matching the daily schema's minItems:1/maxItems:3), so a run with two
  // tips and a single debate is valid and must render rather than fail.
  assert.doesNotThrow(() =>
    validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: tips.slice(0, 2), controversial: controversial.slice(0, 1) } }),
  );
  // An empty or over-cap tip/debate list must still fail rather than render an empty or overflowing section.
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: [], controversial: controversial } }));
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: [tip, tip, tip, tip], controversial: controversial } }));
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: tips, controversial: [] } }));
  assert.throws(() => validateBriefing({ value: { generated_at: "2026-10-31T02:56:00Z", reports: [report], tips: tips, controversial: [debate, debate, debate, debate] } }));
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
    ["./page1_resort_news.geojson", "./page2_snow_conditions.geojson", "./page3_briefing.json", "./page4_report_of_day.json", "./weekly_briefing.md"],
  );
  assert.deepEqual(
    [...index.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1]),
    [
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
      "./map.css",
      "#/resort-news",
      "#/snow",
      "#/report",
      "#/report-map",
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
      "default-src 'none'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com; img-src data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
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
        "https://opentopomap.org",
        "https://www.opensnowmap.org",
        "https://www.opensnowmap.org/pistes/{z}/{x}/{y}.png",
        "https://www.openstreetmap.org/copyright",
        "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      ],
      state: [],
    },
  );
});

// --- Report-on-map (page 4) ---------------------------------------------------------------------
const reportLiftCats = { SB: { label: "Sesselbahn", color: "#9c27b0" } };
const reportArtifact = {
  generated_at: "2026-11-26T05:15:00Z",
  report: { title: "Espace Lumière", author: "wso", forum: "alpinforum", source_url: "https://www.alpinforum.com/posts/5431562/", date: "2024-02-05", text: "x", post_id: 5431562 },
  center: [44.3, 6.57],
  placed_count: 2,
  lift_cats: reportLiftCats,
  lifts: [{ id: 1, name: "TSF4 Ubaguets", cat: "SB", coords: [[44.33, 6.58], [44.32, 6.585]] }],
  photos: [
    { url: "https://img.example/1.jpg", description: "Start", geo: { latitude: 44.3, longitude: 6.57, elevation_m: 1800.0, bearing_deg: 120.0, captured_at: "2024-02-05T09:10:00+00:00" }, n: 0, placed: true, lift: { id: 1, name: "TSF4 Ubaguets", cat: "SB", dist: 12 }, piste: null },
    { url: "https://img.example/2.jpg", description: null, geo: { latitude: 44.301, longitude: 6.571, elevation_m: null, bearing_deg: null, captured_at: null }, n: 1, placed: true, lift: null, piste: { name: "Rote 4", diff: "intermediate", ptype: "downhill", dist: 8 } },
  ],
};

test("validateReportArtifact accepts the mapped report and normalizes photos, lifts and legend", () => {
  const artifact = validateReportArtifact({ value: reportArtifact });
  assert.equal(artifact.report.title, "Espace Lumière");
  assert.equal(artifact.report.author, "wso");
  assert.deepEqual(artifact.center, [44.3, 6.57]);
  assert.deepEqual(artifact.liftCats, reportLiftCats);
  assert.equal(artifact.lifts.length, 1);
  assert.equal(artifact.lifts[0].cat, "SB");
  assert.equal(artifact.photos.length, 2);
  // The first photo keeps its bearing, elevation and snapped lift; the second has none of those.
  assert.equal(artifact.photos[0].bearing, 120.0);
  assert.equal(artifact.photos[0].lift.name, "TSF4 Ubaguets");
  assert.equal(artifact.photos[0].description, "Start");
  assert.equal(artifact.photos[1].bearing, null);
  assert.equal(artifact.photos[1].elevation, null);
  assert.equal(artifact.photos[1].description, null);
  assert.equal(artifact.photos[1].piste.name, "Rote 4");
});

test("validateReportArtifact returns null for an unmapped report (only generated_at)", () => {
  // The daily writes just the run timestamp when the report had no geotagged on-piste photos; this is the
  // legitimate "nothing to map" state the viewer turns into a plain hint, never a validation error.
  assert.equal(validateReportArtifact({ value: { generated_at: "2026-11-26T05:15:00Z" } }), null);
  // The empty shape is EXACTLY `{ generated_at }`: a payload with a stray extra key (here leftover run metadata)
  // but no `report` is partial/corrupt, not empty, so it is rejected rather than silently treated as "nothing".
  assert.throws(
    () => validateReportArtifact({ value: { generated_at: "2026-11-26T05:15:00Z", placed_count: 1 } }),
    /only `generated_at`/,
  );
});

test("validateReportArtifact rejects malformed report map data instead of mapping it", () => {
  assert.throws(() => validateReportArtifact({ value: { report: reportArtifact.report } }), /generated_at/);
  // A lift whose class is not in the legend cannot be coloured.
  assert.throws(() =>
    validateReportArtifact({ value: { ...reportArtifact, lifts: [{ id: 1, name: "X", cat: "ZZ", coords: [[44.3, 6.57], [44.31, 6.58]] }] } }),
  );
  // An out-of-range centre coordinate is rejected.
  assert.throws(() => validateReportArtifact({ value: { ...reportArtifact, center: [200, 6.57] } }));
  // A non-HTTP photo URL is rejected.
  assert.throws(() =>
    validateReportArtifact({ value: { ...reportArtifact, photos: [{ ...reportArtifact.photos[0], url: "ftp://x/y.jpg" }] } }),
  );
});

test("reportWedgePoints builds a bearing-pointed triangle and null without a bearing", () => {
  assert.equal(reportWedgePoints({ latitude: 44.3, longitude: 6.57, bearing: null }), null);
  const wedge = reportWedgePoints({ latitude: 44.3, longitude: 6.57, bearing: 90 });
  // Four [lat, lon] points: the apex at the photo plus the three triangle vertices.
  assert.equal(wedge.length, 4);
  assert.deepEqual(wedge[0], [44.3, 6.57]);
  for (const point of wedge) {
    assert.equal(point.length, 2);
    assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]));
  }
});

test("validateReportArtifact accepts a piste-only report that draws no lifts", () => {
  // A report mapped purely by pistes has photos but an empty lifts array; that is valid, not a broken page.
  const pisteOnly = { ...reportArtifact, lifts: [], photos: [reportArtifact.photos[1]] };
  const artifact = validateReportArtifact({ value: pisteOnly });
  assert.deepEqual(artifact.lifts, []);
  assert.equal(artifact.photos.length, 1);
  assert.equal(artifact.photos[0].piste.name, "Rote 4");
  // A lifts value that is present but not an array is still rejected.
  assert.throws(() => validateReportArtifact({ value: { ...reportArtifact, lifts: "none" } }));
});

test("validateReportArtifact enforces the photo, snap and lift contracts the producer guarantees", () => {
  const withPhoto = (photo) => ({ ...reportArtifact, photos: [photo] });
  // A photo latitude out of range is rejected exactly as a center is, not accepted as a finite number.
  assert.throws(
    () => validateReportArtifact({ value: withPhoto({ ...reportArtifact.photos[0], geo: { ...reportArtifact.photos[0].geo, latitude: 100 } }) }),
    /range/,
  );
  // A lift snap missing its legend class is rejected, never rendered as "undefined · Lift".
  assert.throws(
    () => validateReportArtifact({ value: withPhoto({ ...reportArtifact.photos[0], lift: { name: "X", dist: 5 } }) }),
    /lift_cats/,
  );
  // A negative snap distance is rejected; the producer supplies nonnegative metres.
  assert.throws(
    () => validateReportArtifact({ value: withPhoto({ ...reportArtifact.photos[0], lift: { id: 1, name: "X", cat: "SB", dist: -1 } }) }),
    /zero or greater/,
  );
  // A fractional snap distance is rejected; the producer rounds every distance to whole metres.
  assert.throws(
    () => validateReportArtifact({ value: withPhoto({ ...reportArtifact.photos[0], lift: { id: 1, name: "X", cat: "SB", dist: 0.5 } }) }),
    /whole number of metres/,
  );
  // An absent snap key is malformed data, not a legitimate null: both `lift` and `piste` must be present on every
  // photo (null when the photo snapped to neither), so a photo that omits `piste` entirely is rejected.
  assert.throws(
    () => validateReportArtifact({ value: withPhoto({ url: reportArtifact.photos[0].url, description: null, geo: reportArtifact.photos[0].geo, placed: true, lift: null }) }),
    /must carry a piste key/,
  );
  // A numeric caption is malformed data, not a silent absence.
  assert.throws(
    () => validateReportArtifact({ value: withPhoto({ ...reportArtifact.photos[0], description: 123 }) }),
    /non-empty text/,
  );
  // A one-point lift cannot form a drawable line.
  assert.throws(
    () => validateReportArtifact({ value: { ...reportArtifact, lifts: [{ id: 1, name: "X", cat: "SB", coords: [[44.3, 6.57]] }] } }),
    /at least two/,
  );
});

test("validateReportArtifact rejects a partial artifact that omits report but keeps spatial fields", () => {
  // The only legitimate empty payload is timestamp-only; one with photos but no report is corrupt, not empty.
  assert.throws(
    () => validateReportArtifact({ value: { generated_at: "2026-11-26T05:15:00Z", center: [44.3, 6.57], photos: reportArtifact.photos, lift_cats: reportLiftCats, lifts: [] } }),
    /only `generated_at`/,
  );
});

test("pagerState gives the shared counter text and boundary-disabled flags for both panel navigators", () => {
  assert.deepEqual(pagerState({ count: 3, index: 0, label: "Photo" }), { counterText: "Photo 1 of 3", previousDisabled: true, nextDisabled: false });
  assert.deepEqual(pagerState({ count: 3, index: 2, label: "Photo" }), { counterText: "Photo 3 of 3", previousDisabled: false, nextDisabled: true });
  assert.deepEqual(pagerState({ count: 1, index: 0, label: "Update" }), { counterText: "Update 1 of 1", previousDisabled: true, nextDisabled: true });
  assert.throws(() => pagerState({ count: 0, index: 0, label: "X" }));
  assert.throws(() => pagerState({ count: 2, index: 2, label: "X" }));
});

test("committed report-of-day data is the same run as the briefing and validates", async () => {
  const [page4, page3] = await Promise.all([
    readFile(new URL("../page4_report_of_day.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../page3_briefing.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  // Same run: the report-of-day map and the collapsed briefing must carry the identical run timestamp.
  assert.equal(page4.generated_at, page3.generated_at);
  // The daily publishes EITHER an empty report (no geotagged photos, validating to null) OR a mapped one, so
  // this committed-data check accepts both; it only pins that when mapped, every photo has a placeable fix.
  const artifact = validateReportArtifact({ value: page4 });
  if (artifact !== null) {
    assert.ok(artifact.photos.length > 0, "a mapped committed report must carry photos");
    for (const photo of artifact.photos) {
      assert.ok(Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude));
    }
  }
});

test("featureRecencyKey orders resorts by their newest news time, breaking (today) before older weekly", () => {
  const breakingResort = { newsItems: [{ recency: "breaking", timestamp: "26.11.2026 07:00 Uhr" }, { recency: "weekly", timestamp: "23.11.2026 02:03 Uhr" }] };
  const olderResort = { newsItems: [{ recency: "weekly", timestamp: "25.11.2026 02:03 Uhr" }] };
  assert.equal(featureRecencyKey({ feature: breakingResort }), "202611260700");
  assert.equal(featureRecencyKey({ feature: olderResort }), "202611250203");
  // A descending sort lists the resort with the newer top item first, independent of how many sub-pages it has.
  const ordered = [olderResort, breakingResort].sort((a, b) => featureRecencyKey({ feature: b }).localeCompare(featureRecencyKey({ feature: a })));
  assert.deepEqual(ordered, [breakingResort, olderResort]);
  // A malformed time is a broken producer invariant, so it is rejected rather than silently sorted last.
  assert.throws(() => featureRecencyKey({ feature: { newsItems: [{ timestamp: "unknown" }] } }), /DD\.MM\.YYYY/);
});

test("compareFeaturesForNav orders by newest day first, then west-to-east within the same day", () => {
  // coordinates are [latitude, longitude]; within one day the earlier longitude (further west) comes first.
  const todayWest = { coordinates: [46, 6.0], newsItems: [{ timestamp: "26.11.2026 09:00 Uhr" }] };
  const todayEast = { coordinates: [46, 11.0], newsItems: [{ timestamp: "26.11.2026 07:00 Uhr" }] };
  const yesterday = { coordinates: [46, 8.0], newsItems: [{ timestamp: "25.11.2026 23:00 Uhr" }] };
  const ordered = [todayEast, yesterday, todayWest].sort((a, b) => compareFeaturesForNav({ a, b }));
  // Both of today's resorts precede yesterday's (newer day first); within today, west (lon 6) before east (lon 11),
  // regardless of the time of day.
  assert.deepEqual(ordered, [todayWest, todayEast, yesterday]);
});
