const REPORT_IMAGE_LIMIT = 6;
const TIP_MAX = 3;
const CONTROVERSIAL_MAX = 3;

function requireObject({ value, context }) {
  if (typeof value === "object" && value !== null && Array.isArray(value) === false) {
    return value;
  } else {
    throw new TypeError(context + " must be an object.");
  }
}

function requireText({ value, context }) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  } else {
    throw new TypeError(context + " must be non-empty text.");
  }
}

function requireHttpUrl({ value, context }) {
  const text = requireText({ value: value, context: context });
  const url = new URL(text);
  if (url.protocol === "http:" || url.protocol === "https:") {
    return url.href;
  } else {
    throw new TypeError(context + " must use HTTP or HTTPS.");
  }
}

function requireRecency({ value, context }) {
  // The two visible map states are a closed set; the producer emits only these as plain data, never markup.
  if (value === "breaking" || value === "weekly") {
    return value;
  } else {
    throw new TypeError(context + " must be 'breaking' or 'weekly'.");
  }
}

function requireCoordinates({ value, context }) {
  if (Array.isArray(value) && value.length === 2) {
    const longitude = value[0];
    const latitude = value[1];
    const longitudeIsValid = Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
    const latitudeIsValid = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
    if (longitudeIsValid && latitudeIsValid) {
      return [latitude, longitude];
    } else {
      throw new TypeError(context + " must contain finite longitude and latitude values in range.");
    }
  } else {
    throw new TypeError(context + " must contain exactly two coordinates.");
  }
}

function requireArrayOfLength({ value, length, context }) {
  if (Array.isArray(value) && value.length === length) {
    return value;
  } else {
    throw new RangeError(context + " must contain exactly " + length + " items.");
  }
}

function requireArrayWithin({ value, min, max, context }) {
  if (Array.isArray(value) && value.length >= min && value.length <= max) {
    return value;
  } else {
    throw new RangeError(context + " must contain between " + min + " and " + max + " items.");
  }
}

function requireNonEmptyArray({ value, context }) {
  if (Array.isArray(value) && value.length > 0) {
    return value;
  } else {
    throw new TypeError(context + " must be a non-empty array.");
  }
}

function requireTextList({ value, context }) {
  if (Array.isArray(value) && value.length > 0) {
    // Validate every entry so one blank argument cannot slip into a rendered pro/contra column.
    return value.map((entry, index) => requireText({ value: entry, context: context + " " + index }));
  } else {
    throw new TypeError(context + " must be a non-empty array.");
  }
}

export function statusLabel({ recency }) {
  // The label text is presentation, owned by the viewer; the producer only emits the recency token.
  if (recency === "breaking") {
    return "Breaking News";
  } else if (recency === "weekly") {
    return "This Week's News";
  } else {
    throw new RangeError("Unsupported recency: " + recency);
  }
}

export function formatRunTimestamp({ value }) {
  // The producer stores the run instant as ISO-8601 UTC; the header shows it in the same Europe/Berlin
  // wall-clock and "Uhr" convention the per-pin timestamps already use, so all displayed times agree.
  const iso = requireText({ value: value, context: "Run timestamp" });
  const instant = new Date(iso);
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
  const imageUrl = Object.hasOwn(item, "image_url")
    ? requireHttpUrl({ value: item.image_url, context: context + " image_url" })
    : null;
  return {
    recency: requireRecency({ value: item.recency, context: context + " recency" }),
    timestamp: requireText({ value: item.timestamp, context: context + " timestamp" }),
    headline: requireText({ value: item.headline, context: context + " headline" }),
    imageUrl: imageUrl,
    sourceUrl: requireHttpUrl({ value: item.source_url, context: context + " source_url" }),
    summary: requireText({ value: item.summary, context: context + " summary" }),
  };
}

function validateFeature({ value, index }) {
  const feature = requireObject({ value: value, context: "Feature " + index });
  if (feature.type !== "Feature") {
    throw new TypeError("Feature " + index + " must have type Feature.");
  }
  const geometry = requireObject({ value: feature.geometry, context: "Feature " + index + " geometry" });
  if (geometry.type !== "Point") {
    throw new TypeError("Feature " + index + " geometry must have type Point.");
  }
  const properties = requireObject({ value: feature.properties, context: "Feature " + index + " properties" });
  const primaryNews = validateNewsItem({ value: properties, context: "Feature " + index + " primary news" });
  const olderNews = [];
  if (Object.hasOwn(properties, "older_news") && Array.isArray(properties.older_news) && properties.older_news.length > 0) {
    // Preserve server order because it is the popup's newest-to-oldest page sequence.
    for (const [newsIndex, newsItem] of properties.older_news.entries()) {
      olderNews.push(validateNewsItem({ value: newsItem, context: "Feature " + index + " older_news " + newsIndex }));
    }
  } else if (Object.hasOwn(properties, "older_news")) {
    throw new TypeError("Feature " + index + " older_news must be a non-empty array when present.");
  }
  return {
    coordinates: requireCoordinates({ value: geometry.coordinates, context: "Feature " + index + " coordinates" }),
    name: requireText({ value: properties.name, context: "Feature " + index + " name" }),
    newsItems: [primaryNews, ...olderNews],
  };
}

export function validateFeatureCollection({ value }) {
  const collection = requireObject({ value: value, context: "Map data" });
  if (collection.type !== "FeatureCollection") {
    throw new TypeError("Map data must have type FeatureCollection.");
  } else if (Array.isArray(collection.features)) {
    const features = [];
    // Validate every marker before rendering so one malformed feature cannot create a partial map.
    for (const [index, feature] of collection.features.entries()) {
      features.push(validateFeature({ value: feature, index: index }));
    }
    return features;
  } else {
    throw new TypeError("Map data features must be an array.");
  }
}

export function validateReport({ value }) {
  const report = requireObject({ value: value, context: "Report" });
  const imageUrls = [];
  if (Object.hasOwn(report, "image_urls")) {
    if (Array.isArray(report.image_urls) === false) {
      throw new TypeError("Report image_urls must be an array.");
    } else if (report.image_urls.length > REPORT_IMAGE_LIMIT) {
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

function validateTip({ value, index }) {
  const tip = requireObject({ value: value, context: "Tip " + index });
  return {
    headline: requireText({ value: tip.headline, context: "Tip " + index + " headline" }),
    summary: requireText({ value: tip.summary, context: "Tip " + index + " summary" }),
    sourceUrl: requireHttpUrl({ value: tip.source_url, context: "Tip " + index + " source_url" }),
  };
}

function validateControversial({ value, index }) {
  const subject = requireObject({ value: value, context: "Controversial " + index });
  return {
    headline: requireText({ value: subject.headline, context: "Controversial " + index + " headline" }),
    pro: requireTextList({ value: subject.pro, context: "Controversial " + index + " pro" }),
    contra: requireTextList({ value: subject.contra, context: "Controversial " + index + " contra" }),
    sourceUrl: requireHttpUrl({ value: subject.source_url, context: "Controversial " + index + " source_url" }),
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
    tips: requireArrayWithin({ value: payload.tips, min: 1, max: TIP_MAX, context: "Briefing tips" }).map((tip, index) =>
      validateTip({ value: tip, index: index }),
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
  if (kind === "breaking" && hasImage === true) {
    return { color: "#7a120c", fillColor: "#ff3024", fillOpacity: 1, radius: 10, weight: 3 };
  } else if (kind === "breaking" && hasImage === false) {
    return { color: "#8f211b", fillColor: "#d9483d", fillOpacity: 0.9, radius: 9, weight: 2 };
  } else if (kind === "weekly" && hasImage === true) {
    return { color: "#053f73", fillColor: "#0788df", fillOpacity: 0.96, radius: 9, weight: 3 };
  } else if (kind === "weekly" && hasImage === false) {
    return { color: "#184f75", fillColor: "#337dab", fillOpacity: 0.82, radius: 8, weight: 2 };
  } else {
    throw new RangeError("Unsupported marker state: " + kind + ", image=" + hasImage);
  }
}

export function markerHasCategoryImage({ newsItems }) {
  const primaryNews = newsItems[0];
  if (primaryNews.recency === "breaking") {
    // A red marker represents only the age-zero event, so weekly-page images cannot intensify it.
    return primaryNews.imageUrl !== null;
  } else if (primaryNews.recency === "weekly") {
    // A blue marker represents the complete weekly carousel, so any weekly-page image intensifies it.
    return newsItems.some((newsItem) => newsItem.recency === "weekly" && newsItem.imageUrl !== null);
  } else {
    throw new RangeError("Unsupported marker recency: " + primaryNews.recency);
  }
}

export function newsPageState({ newsItems, activeIndex }) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) {
    throw new TypeError("newsItems must be a non-empty array.");
  } else if (!Number.isInteger(activeIndex)) {
    throw new TypeError("activeIndex must be an integer.");
  } else if (activeIndex < 0 || activeIndex >= newsItems.length) {
    throw new RangeError("activeIndex must identify an existing news page.");
  } else {
    return {
      newsItem: newsItems[activeIndex],
      pageCounterText: "Page " + (activeIndex + 1) + " of " + newsItems.length,
      previousDisabled: activeIndex === 0,
      nextDisabled: activeIndex === newsItems.length - 1,
    };
  }
}
