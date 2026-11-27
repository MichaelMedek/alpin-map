const REPORT_IMAGE_LIMIT = 6;
const TIP_MAX = 3;
const CONTROVERSIAL_MAX = 3;

function requireObject({ value, context }) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(context + " must be an object.");
  }
  return value;
}

function requireText({ value, context }) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(context + " must be non-empty text.");
  }
  return value;
}

function requireHttpUrl({ value, context }) {
  const url = new URL(requireText({ value: value, context: context }));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(context + " must use HTTP or HTTPS.");
  }
  return url.href;
}

function requireRecency({ value, context }) {
  // The two visible map states are a closed set; the producer emits only these as plain data, never markup.
  if (value !== "breaking" && value !== "weekly") {
    throw new TypeError(context + " must be 'breaking' or 'weekly'.");
  }
  return value;
}

// The producer emits each per-item time as "DD.MM.YYYY HH:MM" (optionally a trailing " Uhr"); the first group
// set is reused by the global navigator's sort key, so the whole string is validated once here. The " Uhr"
// suffix is non-capturing so the five capture groups stay day/month/year/hour/minute for featureRecencyKey.
const DISPLAY_TIMESTAMP = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?: Uhr)?$/;

function requireDisplayTimestamp({ value, context }) {
  // Validate the producer's complete display time (the whole string, not just a numeric prefix) at load so a
  // malformed time fails loudly instead of being silently sorted to the bottom of the cross-resort navigator.
  const text = requireText({ value: value, context: context });
  const match = DISPLAY_TIMESTAMP.exec(text);
  if (match === null) {
    throw new TypeError(context + " must be in DD.MM.YYYY HH:MM format.");
  }
  // A well-shaped but impossible instant (month 13, 31 February, 99:99) is still malformed: check each field
  // against its range, with the day bounded by the real length of that month and year (so 29 February is only
  // valid in a leap year). new Date(year, month, 0) is the last day of the 1-based month, i.e. its day count.
  const [, day, month, year, hour, minute] = match.map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59)) {
    throw new RangeError(context + " '" + text + "' is not a real calendar date and time.");
  }
  return text;
}

function requireLatLonValues({ latitude, longitude, context }) {
  // The single finite-and-range check for one geographic point. The two order adapters below (GeoJSON [lon, lat]
  // and the app's own [lat, lon]) each reduce to this, so the validation lives in exactly one place.
  const lat = requireFiniteNumber({ value: latitude, context: context + " latitude" });
  const lon = requireFiniteNumber({ value: longitude, context: context + " longitude" });
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new RangeError(context + " latitude/longitude is out of range.");
  }
  return [lat, lon];
}

function requireCoordinates({ value, context }) {
  // GeoJSON stores [longitude, latitude]; adapt that order into the shared validator and return Leaflet's
  // [latitude, longitude].
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(context + " must contain exactly two coordinates.");
  }
  return requireLatLonValues({ latitude: value[1], longitude: value[0], context: context });
}

function requireArrayWithin({ value, min, max, context }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new RangeError(context + " must contain between " + min + " and " + max + " items.");
  }
  return value;
}

function requireNonEmptyArray({ value, context }) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(context + " must be a non-empty array.");
  }
  return value;
}

function requireArray({ value, context }) {
  // An array that is allowed to be empty (e.g. a report mapped by pistes alone draws no lifts).
  if (!Array.isArray(value)) {
    throw new TypeError(context + " must be an array.");
  }
  return value;
}

function requireTextList({ value, context }) {
  // Validate every entry so one blank argument cannot slip into a rendered pro/contra column.
  return requireNonEmptyArray({ value: value, context: context }).map((entry, index) =>
    requireText({ value: entry, context: context + " " + index }),
  );
}

export function statusLabel({ recency }) {
  // The label text is presentation, owned by the viewer; the producer only emits the recency token.
  if (recency === "breaking") return "Breaking News";
  if (recency === "weekly") return "This Week's News";
  throw new RangeError("Unsupported recency: " + recency);
}

export function formatRunTimestamp({ value }) {
  // The producer stores the run instant as ISO-8601 UTC; the header shows it in the same Europe/Berlin
  // wall-clock and "Uhr" convention the per-pin timestamps use, so every displayed time agrees.
  const instant = new Date(requireText({ value: value, context: "Run timestamp" }));
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError("Run timestamp must be an ISO-8601 instant.");
  }
  const formatted = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
  return formatted.replace(", ", " ") + " Uhr";
}

export function validateNewsItem({ value, context }) {
  const item = requireObject({ value: value, context: context });
  return {
    recency: requireRecency({ value: item.recency, context: context + " recency" }),
    timestamp: requireDisplayTimestamp({ value: item.timestamp, context: context + " timestamp" }),
    headline: requireText({ value: item.headline, context: context + " headline" }),
    imageUrl: Object.hasOwn(item, "image_url")
      ? requireHttpUrl({ value: item.image_url, context: context + " image_url" })
      : null,
    sourceUrl: requireHttpUrl({ value: item.source_url, context: context + " source_url" }),
    summary: requireText({ value: item.summary, context: context + " summary" }),
  };
}

function validateFeature({ value, index }) {
  const label = "Feature " + index;
  const feature = requireObject({ value: value, context: label });
  if (feature.type !== "Feature") {
    throw new TypeError(label + " must have type Feature.");
  }
  const geometry = requireObject({ value: feature.geometry, context: label + " geometry" });
  if (geometry.type !== "Point") {
    throw new TypeError(label + " geometry must have type Point.");
  }
  const properties = requireObject({ value: feature.properties, context: label + " properties" });
  const primaryNews = validateNewsItem({ value: properties, context: label + " primary news" });
  // older_news, when present, must be a non-empty array; server order is the newest-to-oldest page sequence.
  const olderNews = [];
  if (Object.hasOwn(properties, "older_news")) {
    if (!Array.isArray(properties.older_news) || properties.older_news.length === 0) {
      throw new TypeError(label + " older_news must be a non-empty array when present.");
    }
    for (const [newsIndex, newsItem] of properties.older_news.entries()) {
      olderNews.push(validateNewsItem({ value: newsItem, context: label + " older_news " + newsIndex }));
    }
  }
  return {
    coordinates: requireCoordinates({ value: geometry.coordinates, context: label + " coordinates" }),
    name: requireText({ value: properties.name, context: label + " name" }),
    newsItems: [primaryNews, ...olderNews],
  };
}

export function validateFeatureCollection({ value }) {
  const collection = requireObject({ value: value, context: "Map data" });
  if (collection.type !== "FeatureCollection") {
    throw new TypeError("Map data must have type FeatureCollection.");
  }
  if (!Array.isArray(collection.features)) {
    throw new TypeError("Map data features must be an array.");
  }
  // Validate every marker before rendering so one malformed feature cannot create a partial map.
  return collection.features.map((feature, index) => validateFeature({ value: feature, index: index }));
}

function validateReport({ value }) {
  const report = requireObject({ value: value, context: "Report" });
  const imageUrls = [];
  if (Object.hasOwn(report, "image_urls")) {
    if (!Array.isArray(report.image_urls)) {
      throw new TypeError("Report image_urls must be an array.");
    }
    if (report.image_urls.length > REPORT_IMAGE_LIMIT) {
      throw new RangeError("Report image_urls must contain at most " + REPORT_IMAGE_LIMIT + " images.");
    }
    // Resolve each image to a validated absolute URL so a malformed entry fails the whole page.
    for (const [imageIndex, imageUrl] of report.image_urls.entries()) {
      imageUrls.push(requireHttpUrl({ value: imageUrl, context: "Report image_urls " + imageIndex }));
    }
  }
  return {
    headline: requireText({ value: report.headline, context: "Report headline" }),
    summary: requireText({ value: report.summary, context: "Report summary" }),
    sourceUrl: requireHttpUrl({ value: report.source_url, context: "Report source_url" }),
    imageUrls: imageUrls,
  };
}

function validateSourcedItem({ value, context }) {
  // Tips and debate subjects share a headline and a mandatory source link; each adds its own body below
  // (a tip a summary, a debate pro/contra columns), so only the common fields are resolved here.
  const item = requireObject({ value: value, context: context });
  return {
    item: item,
    headline: requireText({ value: item.headline, context: context + " headline" }),
    sourceUrl: requireHttpUrl({ value: item.source_url, context: context + " source_url" }),
  };
}

function validateTip({ value, index }) {
  const context = "Tip " + index;
  const { item, headline, sourceUrl } = validateSourcedItem({ value: value, context: context });
  return {
    headline: headline,
    summary: requireText({ value: item.summary, context: context + " summary" }),
    sourceUrl: sourceUrl,
  };
}

function validateControversial({ value, index }) {
  const context = "Controversial " + index;
  const { item, headline, sourceUrl } = validateSourcedItem({ value: value, context: context });
  return {
    headline: headline,
    pro: requireTextList({ value: item.pro, context: context + " pro" }),
    contra: requireTextList({ value: item.contra, context: context + " contra" }),
    sourceUrl: sourceUrl,
  };
}

export function validateBriefing({ value }) {
  const payload = requireObject({ value: value, context: "Briefing" });
  return {
    generatedAt: requireText({ value: payload.generated_at, context: "Briefing generated_at" }),
    // A daily run carries exactly one report, but the field is a non-empty array validated per element.
    reports: requireNonEmptyArray({ value: payload.reports, context: "Briefing reports" }).map((report) =>
      validateReport({ value: report }),
    ),
    // Tips and debates are bounded one to three (the daily schema's minItems:1 / maxItems:3).
    tips: requireArrayWithin({ value: payload.tips, min: 1, max: TIP_MAX, context: "Briefing tips" }).map(
      (tip, index) => validateTip({ value: tip, index: index }),
    ),
    controversial: requireArrayWithin({
      value: payload.controversial,
      min: 1,
      max: CONTROVERSIAL_MAX,
      context: "Briefing controversial",
    }).map((subject, index) => validateControversial({ value: subject, index: index })),
  };
}

export function markerStyle({ kind, hasImage }) {
  if (kind === "breaking" && hasImage) return { color: "#7a120c", fillColor: "#ff3024", fillOpacity: 1, radius: 10, weight: 3 };
  if (kind === "breaking") return { color: "#8f211b", fillColor: "#d9483d", fillOpacity: 0.9, radius: 9, weight: 2 };
  if (kind === "weekly" && hasImage) return { color: "#053f73", fillColor: "#0788df", fillOpacity: 0.96, radius: 9, weight: 3 };
  if (kind === "weekly") return { color: "#184f75", fillColor: "#337dab", fillOpacity: 0.82, radius: 8, weight: 2 };
  throw new RangeError("Unsupported marker state: " + kind + ", image=" + hasImage);
}

export function markerHasCategoryImage({ newsItems }) {
  const primaryNews = newsItems[0];
  // A red (breaking) marker shows only the age-zero event, so only its own image intensifies it; a blue
  // (weekly) marker represents the whole carousel, so any weekly page with an image intensifies it.
  if (primaryNews.recency === "breaking") return primaryNews.imageUrl !== null;
  if (primaryNews.recency === "weekly") {
    return newsItems.some((newsItem) => newsItem.recency === "weekly" && newsItem.imageUrl !== null);
  }
  throw new RangeError("Unsupported marker recency: " + primaryNews.recency);
}

export function pagerState({ count, index, label }) {
  // The shared pager state (counter text plus boundary-disabled flags) the detail panel's inner per-item and
  // outer cross-resort navigators both render. Extracted so the exact production logic is unit-tested here
  // rather than reimplemented inline, and used by both navigators so they can never drift apart.
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError("pagerState count must be a positive integer.");
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError("pagerState index must identify an existing page.");
  }
  return {
    counterText: label + " " + (index + 1) + " of " + count,
    previousDisabled: index === 0,
    nextDisabled: index === count - 1,
  };
}

export function featureRecencyKey({ feature }) {
  // A sortable key ordering resorts in the global (cross-resort) navigator by their newest news time. The
  // newest sub-page is newsItems[0] (primary, then older newest-to-oldest); its "DD.MM.YYYY HH:MM" display time
  // becomes "YYYYMMDDHHMM" so a descending sort lists the most recent resort first (breaking today before older
  // weekly). Every news timestamp was format-validated at load, so a non-match here is a broken invariant.
  const match = DISPLAY_TIMESTAMP.exec(feature.newsItems[0].timestamp);
  if (match === null) {
    throw new TypeError("News timestamp '" + feature.newsItems[0].timestamp + "' is not in DD.MM.YYYY HH:MM format.");
  }
  const [, day, month, year, hour, minute] = match;
  return year + month + day + hour + minute;
}

export function compareFeaturesForNav({ a, b }) {
  // Global navigator order: newest DAY first (so breaking today leads), then within one day geographically from
  // west to east (ascending longitude) so paging glides across the map. coordinates are [latitude, longitude].
  const dayA = featureRecencyKey({ feature: a }).slice(0, 8);
  const dayB = featureRecencyKey({ feature: b }).slice(0, 8);
  if (dayA !== dayB) return dayB.localeCompare(dayA);
  return a.coordinates[1] - b.coordinates[1];
}

// --- Report-on-map (page 4): the one report of the day, mapped to its lifts, slopes and photo wedges -----
// The producer (alpin-api) writes page 4 on every run: always `generated_at`, plus the spatial artifact
// fields ONLY when the report had geotagged, on-piste photos. Unlike GeoJSON, this artifact already stores
// every coordinate as [latitude, longitude] (Leaflet order), so no swap is needed.

function requireFiniteNumber({ value, context }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(context + " must be a finite number.");
  }
  return value;
}

function requireLatLon({ value, context }) {
  // The app's own [latitude, longitude] pair: same finite-and-range validation as the GeoJSON adapter, in the
  // app's input order.
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(context + " must be a [latitude, longitude] pair.");
  }
  return requireLatLonValues({ latitude: value[0], longitude: value[1], context: context });
}

function requireNullableNumber({ object, key, context }) {
  // The producer always emits the documented key (null when the sensor lacked the value). A missing key or a
  // non-numeric present value is malformed data, never a legitimate absence, so neither is silently coerced.
  if (!Object.hasOwn(object, key)) throw new TypeError(context + " must be present (use null when absent).");
  const value = object[key];
  return value === null ? null : requireFiniteNumber({ value: value, context: context });
}

function requireNullableText({ object, key, context }) {
  // Same present-or-null contract for optional text (a caption, a capture time): a number or an empty string is
  // malformed, not a silent null, so a numeric caption can no longer vanish as an apparently legitimate absence.
  if (!Object.hasOwn(object, key)) throw new TypeError(context + " must be present (use null when absent).");
  const value = object[key];
  return value === null ? null : requireText({ value: value, context: context });
}

function requireNonNegativeInteger({ value, context }) {
  // Snap distances are nonnegative whole metres (the producer rounds every distance); a fractional, negative, or
  // non-numeric value is a producer contract violation, not a value to silently keep or coerce.
  const number = requireFiniteNumber({ value: value, context: context });
  if (!Number.isInteger(number) || number < 0) throw new RangeError(context + " must be a whole number of metres, zero or greater.");
  return number;
}

function requirePositiveInteger({ value, context }) {
  // A count that must be a whole number of at least one (a report in the index has at least one placed photo);
  // zero, a fraction, or a non-number is malformed producer data, not a value to keep.
  const number = requireFiniteNumber({ value: value, context: context });
  if (!Number.isInteger(number) || number < 1) throw new RangeError(context + " must be a whole number of one or greater.");
  return number;
}

function requireStringField({ value, context }) {
  // A display name that may legitimately be empty (an unnamed OSM lift or piste), but must be text when present.
  if (typeof value !== "string") throw new TypeError(context + " must be text.");
  return value;
}

function requireIntegerId({ value, context }) {
  // A lift's OSM way id; it keys a drawn lift to the photos snapped to it, so it must be a real integer, not text.
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(context + " must be an integer id.");
  return value;
}

function validateLiftCategories({ value }) {
  // code -> {label, color}; the renderer colours every lift line and the legend from this closed map.
  const categories = requireObject({ value: value, context: "Report lift_cats" });
  const result = {};
  for (const [code, entry] of Object.entries(categories)) {
    const record = requireObject({ value: entry, context: "Report lift_cats " + code });
    result[code] = {
      label: requireText({ value: record.label, context: "Report lift_cats " + code + " label" }),
      color: requireText({ value: record.color, context: "Report lift_cats " + code + " color" }),
    };
  }
  return result;
}

function validateLiftLine({ value, index, liftCats }) {
  const context = "Report lift " + index;
  const lift = requireObject({ value: value, context: context });
  const cat = requireText({ value: lift.cat, context: context + " cat" });
  // A lift whose class is not in the legend cannot be coloured, so it is a producer error, not a silent default.
  if (!Object.hasOwn(liftCats, cat)) throw new RangeError(context + " cat '" + cat + "' is not in lift_cats.");
  // A lift line needs at least two points to be drawable; a single point cannot form a polyline.
  if (!Array.isArray(lift.coords) || lift.coords.length < 2) {
    throw new TypeError(context + " coords must contain at least two points to draw a line.");
  }
  const coordinates = lift.coords.map((point, pointIndex) =>
    requireLatLon({ value: point, context: context + " coords " + pointIndex }),
  );
  return { id: requireIntegerId({ value: lift.id, context: context + " id" }), name: requireStringField({ value: lift.name, context: context + " name" }), cat: cat, coords: coordinates };
}

function validateReportSnap({ value, context, liftCats, kind }) {
  // A photo's optional snapped lift or piste. A lift snap MUST name a legend class (so it can be coloured and
  // labelled, never "undefined · Lift"); a piste snap carries only a display name. The distance is required and
  // nonnegative — the producer always supplies it as nonnegative metres. The key's PRESENCE is guaranteed by the
  // caller (validateReportPhoto), so only an explicit null is "no snap"; undefined would be a contract break and
  // falls through to requireObject below, which rejects it.
  if (value === null) return null;
  const snap = requireObject({ value: value, context: context });
  const result = {
    name: requireStringField({ value: snap.name, context: context + " name" }),
    dist: requireNonNegativeInteger({ value: snap.dist, context: context + " dist" }),
  };
  if (kind === "lift") {
    if (!Object.hasOwn(liftCats, snap.cat)) throw new RangeError(context + " cat '" + snap.cat + "' is not in lift_cats.");
    result.cat = snap.cat;
    // The OSM way id lets a drawn lift line open the first photo snapped to it; it is matched, never displayed.
    result.id = requireIntegerId({ value: snap.id, context: context + " id" });
  } else if (kind === "piste") {
    // A piste carries its OSM difficulty and type so the detail panel can colour it. Both are present strings that
    // may legitimately be empty (an unclassified piste), so the string validator keeps "" yet rejects a missing
    // key or a non-string value rather than silently coercing it to "".
    result.diff = requireStringField({ value: snap.diff, context: context + " diff" });
    result.ptype = requireStringField({ value: snap.ptype, context: context + " ptype" });
  } else {
    throw new RangeError("Unsupported snap kind: " + kind);
  }
  return result;
}

function validateReportPhoto({ value, index, liftCats }) {
  const context = "Report photo " + index;
  const photo = requireObject({ value: value, context: context });
  const geo = requireObject({ value: photo.geo, context: context + " geo" });
  // Reuse the coordinate-range validator so a photo latitude of 100 is rejected exactly as a center or lift is.
  const [latitude, longitude] = requireLatLon({ value: [geo.latitude, geo.longitude], context: context + " geo" });
  // The producer always emits both snap keys (null when the photo snapped to neither lift nor piste). An absent
  // key would silently become null in validateReportSnap, so it is rejected exactly as a missing nullable scalar.
  for (const key of ["lift", "piste"]) {
    if (!Object.hasOwn(photo, key)) throw new TypeError(context + " must carry a " + key + " key (null or an object).");
  }
  return {
    url: requireHttpUrl({ value: photo.url, context: context + " url" }),
    description: requireNullableText({ object: photo, key: "description", context: context + " description" }),
    latitude: latitude,
    longitude: longitude,
    bearing: requireNullableNumber({ object: geo, key: "bearing_deg", context: context + " bearing" }),
    elevation: requireNullableNumber({ object: geo, key: "elevation_m", context: context + " elevation" }),
    capturedAt: requireNullableText({ object: geo, key: "captured_at", context: context + " captured_at" }),
    lift: validateReportSnap({ value: photo.lift, context: context + " lift", liftCats: liftCats, kind: "lift" }),
    piste: validateReportSnap({ value: photo.piste, context: context + " piste", liftCats: liftCats, kind: "piste" }),
  };
}

function validateBearingOffset({ object, context }) {
  // The per-report view-direction correction. The producer ALWAYS serializes bearing_offset_deg (null when it
  // could not derive one), so a MISSING key is corruption and is rejected here, not coerced to null — matching
  // the present-or-null contract of requireNullableNumber/requireNullableText. A present value is null, or
  // exactly one device-axis quarter-turn to subtract from each recorded bearing.
  if (!Object.hasOwn(object, "bearing_offset_deg")) {
    throw new TypeError(context + " must carry bearing_offset_deg (null when not derivable).");
  }
  const value = object.bearing_offset_deg;
  if (value === null) return null;
  if (value !== 0 && value !== 90 && value !== 180 && value !== 270) {
    throw new RangeError("Report bearing_offset_deg '" + value + "' must be null or one of 0/90/180/270.");
  }
  return value;
}

export function validateReportArtifact({ value }) {
  // Return null for an unmapped report-of-the-day (the producer wrote only `generated_at` because the report
  // had no geotagged on-piste photos), else the validated spatial artifact the report-on-map view renders.
  const payload = requireObject({ value: value, context: "Report map data" });
  requireText({ value: payload.generated_at, context: "Report map generated_at" });
  // The ONLY legitimate "nothing to map" payload is exactly `{ generated_at }`. Any other key — a spatial field,
  // or stray metadata such as placed_count — means a partial or corrupt artifact, not an empty one, so it is
  // rejected rather than shown as an empty report that silently drops its photos and lifts.
  if (!Object.hasOwn(payload, "report")) {
    const extraKeys = Object.keys(payload).filter((key) => key !== "generated_at");
    if (extraKeys.length > 0) {
      throw new TypeError("Report map data without `report` must carry only `generated_at`, but also has: " + extraKeys.join(", ") + ".");
    }
    return null;
  }
  const report = requireObject({ value: payload.report, context: "Report map report" });
  const liftCats = validateLiftCategories({ value: payload.lift_cats });
  return {
    report: {
      title: requireText({ value: report.title, context: "Report title" }),
      author: requireText({ value: report.author, context: "Report author" }),
      forum: requireText({ value: report.forum, context: "Report forum" }),
      sourceUrl: requireHttpUrl({ value: report.source_url, context: "Report source_url" }),
      date: requireText({ value: report.date, context: "Report date" }),
    },
    center: requireLatLon({ value: payload.center, context: "Report center" }),
    bearingOffsetDeg: validateBearingOffset({ object: payload, context: "Report" }),
    liftCats: liftCats,
    // A report may be mapped purely by pistes, so its drawn-lift list is allowed to be empty, but it must be
    // an array; photos remain non-empty because a mapped report always has at least one placed photo.
    lifts: requireArray({ value: payload.lifts, context: "Report lifts" }).map((lift, index) =>
      validateLiftLine({ value: lift, index: index, liftCats: liftCats }),
    ),
    photos: requireNonEmptyArray({ value: payload.photos, context: "Report photos" }).map((photo, index) =>
      validateReportPhoto({ value: photo, index: index, liftCats: liftCats }),
    ),
  };
}

// A report id is both the `data/reports/<id>.json` file stem and the `#/highlight-report-map-<id>` deep-link
// fragment, so it must be a safe path/URL token: lowercase letters, digits, underscore and dash only. Shared by
// the index validator and the viewer's deep-link resolver so a crafted id (e.g. "../day/page3_briefing") can
// never escape data/reports/.
const REPORT_ID_PATTERN = /^[a-z0-9_-]+$/;

export function isReportId(value) {
  return typeof value === "string" && REPORT_ID_PATTERN.test(value);
}

export function validateReportIndex({ value }) {
  // The highlight-reports discovery index: one small entry per collected report, the only file the overview map
  // loads (full artifacts are fetched lazily on open). Every entry is validated to the exact producer contract so
  // a corrupt index fails loudly instead of dropping a marker, exactly as validateReportArtifact does for a report.
  const payload = requireObject({ value: value, context: "Report index" });
  requireText({ value: payload.generated_at, context: "Report index generated_at" });
  return {
    generatedAt: payload.generated_at,
    reports: requireArray({ value: payload.reports, context: "Report index reports" }).map((entry, index) => {
      const context = "Report index entry " + index;
      const record = requireObject({ value: entry, context: context });
      const id = requireText({ value: record.id, context: context + " id" });
      // A report id keys both the file path and the deep link, so a stray character that could alter either is
      // rejected rather than trusted.
      if (!isReportId(id)) throw new RangeError(context + " id '" + id + "' must be lowercase letters, digits, underscore or dash.");
      return {
        id: id,
        forum: requireText({ value: record.forum, context: context + " forum" }),
        author: requireText({ value: record.author, context: context + " author" }),
        date: requireText({ value: record.date, context: context + " date" }),
        title: requireText({ value: record.title, context: context + " title" }),
        sourceUrl: requireHttpUrl({ value: record.source_url, context: context + " source_url" }),
        centroid: requireLatLon({ value: record.centroid, context: context + " centroid" }),
        photoCount: requirePositiveInteger({ value: record.photo_count, context: context + " photo_count" }),
      };
    }),
  };
}

// Wedge geometry, shared so the round no-bearing marker can be built to the SAME area as the triangle.
const WEDGE_RADIUS = 0.0024;
const WEDGE_HALF_WIDTH = (20 * Math.PI) / 180;

export function reportWedgePoints({ latitude, longitude, bearing }) {
  // A small triangle pointing along the compass bearing (degrees clockwise from north) in [lat, lon] points,
  // correcting longitude for the latitude so the wedge is not skewed; a null bearing has no direction.
  if (bearing === null) return null;
  const latitudeScale = Math.cos((latitude * Math.PI) / 180);
  const heading = (bearing * Math.PI) / 180;
  const point = (angle) => [latitude + WEDGE_RADIUS * Math.cos(angle), longitude + (WEDGE_RADIUS * Math.sin(angle)) / latitudeScale];
  return [[latitude, longitude], point(heading - WEDGE_HALF_WIDTH), point(heading), point(heading + WEDGE_HALF_WIDTH)];
}

export function reportDotPoints({ latitude, longitude }) {
  // A round marker for a photo with NO bearing: a circle of EQUAL AREA to the wedge triangle (same polygon
  // style and colour, just round). The drawn wedge polygon has area R^2*sin(halfWidth), so the equal-area
  // circle has radius R*sqrt(sin(halfWidth)/pi); longitude is latitude-corrected exactly as the wedge is.
  const latitudeScale = Math.cos((latitude * Math.PI) / 180);
  const radius = WEDGE_RADIUS * Math.sqrt(Math.sin(WEDGE_HALF_WIDTH) / Math.PI);
  const steps = 32;
  const ring = [];
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * 2 * Math.PI;
    ring.push([latitude + radius * Math.cos(angle), longitude + (radius * Math.sin(angle)) / latitudeScale]);
  }
  return ring;
}
