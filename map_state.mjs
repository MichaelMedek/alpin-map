const BREAKING_PREFIX = "<strong>Breaking News (";
const BREAKING_SUFFIX = ")</strong>";
const WEEKLY_PREFIX = "<strong>This Week's News (";
const WEEKLY_SUFFIX = ")</strong>";

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

export function statusDetails({ value }) {
  const status = requireText({ value: value, context: "News status" });
  if (status.startsWith(BREAKING_PREFIX) && status.endsWith(BREAKING_SUFFIX)) {
    const timestamp = status.slice(BREAKING_PREFIX.length, -BREAKING_SUFFIX.length);
    const text = requireText({ value: timestamp, context: "Breaking-news timestamp" });
    return { kind: "breaking", text: "Breaking News (" + text + ")" };
  } else if (status.startsWith(WEEKLY_PREFIX) && status.endsWith(WEEKLY_SUFFIX)) {
    const timestamp = status.slice(WEEKLY_PREFIX.length, -WEEKLY_SUFFIX.length);
    const text = requireText({ value: timestamp, context: "Weekly-news timestamp" });
    return { kind: "weekly", text: "This Week's News (" + text + ")" };
  } else {
    throw new TypeError("Unsupported map status: " + status);
  }
}

export function validateNewsItem({ value, context }) {
  const item = requireObject({ value: value, context: context });
  const imageUrl = Object.hasOwn(item, "image_url")
    ? requireHttpUrl({ value: item.image_url, context: context + " image_url" })
    : null;
  return {
    imageUrl: imageUrl,
    sourceUrl: requireHttpUrl({ value: item.last_page_url, context: context + " last_page_url" }),
    status: statusDetails({ value: item.status }),
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
  if (primaryNews.status.kind === "breaking") {
    // A red marker represents only the age-zero event, so weekly-page images cannot intensify it.
    return primaryNews.imageUrl !== null;
  } else if (primaryNews.status.kind === "weekly") {
    // A blue marker represents the complete weekly carousel, so any weekly-page image intensifies it.
    return newsItems.some((newsItem) => newsItem.status.kind === "weekly" && newsItem.imageUrl !== null);
  } else {
    throw new RangeError("Unsupported marker status kind: " + primaryNews.status.kind);
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
