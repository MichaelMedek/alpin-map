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

function requireCoordinates({ value, context }) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(context + " must contain exactly two coordinates.");
  }
  const [longitude, latitude] = value;
  const inRange =
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 &&
    Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
  if (!inRange) {
    throw new TypeError(context + " must contain finite longitude and latitude values in range.");
  }
  // GeoJSON stores [longitude, latitude]; Leaflet expects [latitude, longitude].
  return [latitude, longitude];
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
    timestamp: requireText({ value: item.timestamp, context: context + " timestamp" }),
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

export function newsPageState({ newsItems, activeIndex }) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) {
    throw new TypeError("newsItems must be a non-empty array.");
  }
  if (!Number.isInteger(activeIndex)) {
    throw new TypeError("activeIndex must be an integer.");
  }
  if (activeIndex < 0 || activeIndex >= newsItems.length) {
    throw new RangeError("activeIndex must identify an existing news page.");
  }
  return {
    newsItem: newsItems[activeIndex],
    pageCounterText: "Page " + (activeIndex + 1) + " of " + newsItems.length,
    previousDisabled: activeIndex === 0,
    nextDisabled: activeIndex === newsItems.length - 1,
  };
}
