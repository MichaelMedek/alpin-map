import {
  markerHasCategoryImage,
  markerStyle,
  newsPageState,
  validateFeatureCollection,
} from "./map_state.mjs";

const MAP_URL = "./map.geojson";
const DEFAULT_CENTER = [46.8, 10.2];
const DEFAULT_ZOOM = 5;

const map = L.map("map", { minZoom: 4 }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  maxZoom: 19,
}).addTo(map);

function linkElement({ href, text, className }) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = text;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (className !== null) {
    link.className = className;
  }
  return link;
}

function popupElement({ feature, onContentChange }) {
  if (typeof onContentChange !== "function") {
    throw new TypeError("onContentChange must be a function.");
  }

  let activeIndex = 0;
  const popup = document.createElement("article");
  popup.className = "news-popup";

  const title = document.createElement("h2");
  title.textContent = feature.name;
  popup.append(title);

  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  popup.append(status);

  const content = document.createElement("div");
  content.className = "news-popup__content";

  const summary = document.createElement("p");
  summary.className = "news-popup__summary";

  const image = document.createElement("img");
  image.className = "news-popup__image";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.hidden = true;
  image.addEventListener("load", onContentChange);
  content.append(summary, image);
  popup.append(content);

  const pagination = document.createElement("div");
  pagination.className = "news-popup__pagination";

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.textContent = "Previous";
  previousButton.setAttribute("aria-label", "Show newer news");

  const pageCounter = document.createElement("span");
  pageCounter.className = "news-popup__page-counter";
  pageCounter.setAttribute("aria-live", "polite");
  pageCounter.setAttribute("aria-atomic", "true");

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.textContent = "Next";
  nextButton.setAttribute("aria-label", "Show older news");
  pagination.append(previousButton, pageCounter, nextButton);
  popup.append(pagination);

  const actions = document.createElement("div");
  actions.className = "news-popup__actions";
  const sourceLink = linkElement({ href: feature.newsItems[0].sourceUrl, text: "Open source forum page", className: null });
  actions.append(sourceLink);

  const copyStatus = document.createElement("span");
  copyStatus.className = "news-popup__copy-status";
  copyStatus.setAttribute("aria-live", "polite");

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy forum link";
  async function copyForumLink() {
    try {
      await navigator.clipboard.writeText(feature.newsItems[activeIndex].sourceUrl);
      copyStatus.textContent = "Forum link copied.";
    } catch (error) {
      copyStatus.textContent = "Copying failed; open the link and copy its address from the browser.";
      console.error("Could not copy the forum link.", error);
    }
  }
  copyButton.addEventListener("click", copyForumLink);
  actions.append(copyButton, copyStatus);
  popup.append(actions);

  function renderNewsItem() {
    const pageState = newsPageState({ newsItems: feature.newsItems, activeIndex: activeIndex });
    const newsItem = pageState.newsItem;
    status.className = "news-popup__status news-popup__status--" + newsItem.status.kind;
    if (newsItem.status.kind === "breaking") {
      const strong = document.createElement("strong");
      strong.textContent = newsItem.status.text;
      status.replaceChildren(strong);
    } else if (newsItem.status.kind === "weekly") {
      status.textContent = newsItem.status.text;
    } else {
      throw new RangeError("Unsupported status kind: " + newsItem.status.kind);
    }

    summary.textContent = newsItem.summary;
    sourceLink.href = newsItem.sourceUrl;
    copyStatus.textContent = "";
    if (newsItem.imageUrl === null) {
      image.hidden = true;
      image.removeAttribute("src");
      image.alt = "";
      popup.classList.remove("news-popup--with-image");
    } else if (typeof newsItem.imageUrl === "string") {
      image.hidden = false;
      image.src = newsItem.imageUrl;
      image.alt = "Selected forum image for " + feature.name + " news.";
      popup.classList.add("news-popup--with-image");
    } else {
      throw new TypeError("Validated news image URL must be text or null.");
    }

    previousButton.disabled = pageState.previousDisabled;
    nextButton.disabled = pageState.nextDisabled;
    pageCounter.textContent = pageState.pageCounterText;
    onContentChange();
  }

  function showPreviousNews() {
    if (activeIndex > 0) {
      activeIndex -= 1;
      renderNewsItem();
    }
  }

  function showNextNews() {
    if (activeIndex < feature.newsItems.length - 1) {
      activeIndex += 1;
      renderNewsItem();
    }
  }

  previousButton.addEventListener("click", showPreviousNews);
  nextButton.addEventListener("click", showNextNews);
  renderNewsItem();
  return popup;
}

function renderFeatures({ features }) {
  const markers = [];
  // Each feature owns one marker and one stateful carousel popup.
  for (const feature of features) {
    const primaryNews = feature.newsItems[0];
    const marker = L.circleMarker(
      feature.coordinates,
      markerStyle({ kind: primaryNews.status.kind, hasImage: markerHasCategoryImage({ newsItems: feature.newsItems }) }),
    );
    let popupBound = false;
    function updatePopupPosition() {
      if (popupBound) {
        marker.getPopup().update();
      }
    }
    const popup = popupElement({ feature: feature, onContentChange: updatePopupPosition });
    marker.bindTooltip(feature.name + ": " + primaryNews.status.text);
    marker.bindPopup(popup, { maxWidth: 660 });
    popupBound = true;
    marker.addTo(map);
    markers.push(marker);
  }
  const bounds = L.featureGroup(markers).getBounds();
  map.fitBounds(bounds.pad(0.15), { maxZoom: 10, padding: [24, 24] });
}

function showMessage({ text, kind }) {
  const message = document.getElementById("map-message");
  message.textContent = text;
  message.dataset.kind = kind;
  message.hidden = false;
}

function hideMessage() {
  document.getElementById("map-message").hidden = true;
}

async function loadMap() {
  try {
    const response = await fetch(MAP_URL + "?loaded=" + Date.now(), { cache: "no-store" });
    if (response.ok) {
      const features = validateFeatureCollection({ value: await response.json() });
      if (features.length > 0) {
        renderFeatures({ features: features });
        hideMessage();
      } else if (features.length === 0) {
        showMessage({ text: "There is no breaking or weekly news in the retained run window.", kind: "empty" });
      } else {
        throw new RangeError("Feature count cannot be negative: " + features.length);
      }
    } else {
      throw new Error("Map request failed with HTTP " + response.status + ".");
    }
  } catch (error) {
    showMessage({ text: "The current map data could not be loaded.", kind: "error" });
    console.error("Could not load the Alpine news map.", error);
  }
}

loadMap();
