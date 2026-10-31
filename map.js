import {
  markerHasCategoryImage,
  markerStyle,
  newsPageState,
  validateFeatureCollection,
  validateReport,
  validateTips,
} from "./map_state.mjs";

const DEFAULT_CENTER = [46.8, 10.2];
const DEFAULT_ZOOM = 5;
const DEFAULT_ROUTE = "resort-news";

// One registry drives the nav chrome and the dispatch below; the two map routes share render(),
// so resort-news and snow stay byte-for-byte symmetric and differ only by data url and labels.
const ROUTES = {
  "resort-news": {
    title: "Resort news",
    subtitle: "Construction and infrastructure progress across the Alps.",
    view: "map",
    url: "./page1_resort_news.geojson",
  },
  snow: {
    title: "Snow & conditions",
    subtitle: "Current snow, slope and mountain conditions.",
    view: "map",
    url: "./page2_snow_conditions.geojson",
  },
  report: {
    title: "Report of the day",
    subtitle: "One standout trip report, retold.",
    view: "doc",
    url: "./page3_report.json",
    render: renderReport,
  },
  tips: {
    title: "Tips & debates",
    subtitle: "Three practical tips and three hot debates from the forums.",
    view: "doc",
    url: "./page4_tips.json",
    render: renderTips,
  },
};

const mapElement = document.getElementById("map");
const docElement = document.getElementById("doc");
const messageElement = document.getElementById("view-message");

let map = null;
let markerGroup = null;
let activeRoute = null;

function ensureMap() {
  // Create the Leaflet map once and reuse it across both map routes; a hidden container keeps the
  // single instance cheap and avoids leaking tile layers when the user switches pages repeatedly.
  if (map === null) {
    map = L.map(mapElement, { minZoom: 4 }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
    }).addTo(map);
    markerGroup = L.featureGroup().addTo(map);
  }
  return { map: map, markerGroup: markerGroup };
}

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

function newsImageElement({ onContentChange }) {
  const image = document.createElement("img");
  image.className = "news-popup__image";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.hidden = true;
  if (typeof onContentChange === "function") {
    image.addEventListener("load", onContentChange);
  }
  return image;
}

function popupElement({ feature, onContentChange }) {
  if (typeof onContentChange !== "function") {
    throw new TypeError("onContentChange must be a function.");
  }

  let activeIndex = 0;
  const popup = document.createElement("article");
  popup.className = "news-popup";

  // The resort name is constant across the carousel, so it is the eyebrow; the per-page headline is the title.
  const kicker = document.createElement("p");
  kicker.className = "news-popup__kicker";
  kicker.textContent = feature.name;
  popup.append(kicker);

  const title = document.createElement("h2");
  popup.append(title);

  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  popup.append(status);

  const content = document.createElement("div");
  content.className = "news-popup__content";

  const summary = document.createElement("p");
  summary.className = "news-popup__summary";

  const image = newsImageElement({ onContentChange: onContentChange });
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
    title.textContent = newsItem.headline;
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
      image.alt = "Selected forum image for " + feature.name + ".";
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

function renderMapFeatures({ features }) {
  const { map: leaflet, markerGroup: group } = ensureMap();
  group.clearLayers();
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
    group.addLayer(marker);
  }
  leaflet.fitBounds(group.getBounds().pad(0.15), { maxZoom: 10, padding: [24, 24] });
}

function reportElement({ report }) {
  const article = document.createElement("article");
  article.className = "report";

  const heading = document.createElement("h2");
  heading.className = "report__headline";
  heading.textContent = report.headline;
  article.append(heading);

  const summary = document.createElement("p");
  summary.className = "report__summary";
  summary.textContent = report.summary;
  article.append(summary);

  if (report.imageUrls.length > 0) {
    const gallery = document.createElement("div");
    gallery.className = "report__gallery";
    // Up to four forum images; no-referrer keeps the forum image hosts from rejecting the hotlink.
    for (const [imageIndex, imageUrl] of report.imageUrls.entries()) {
      const image = document.createElement("img");
      image.className = "report__image";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.src = imageUrl;
      image.alt = "Report photo " + (imageIndex + 1) + ".";
      gallery.append(image);
    }
    article.append(gallery);
  }

  const actions = document.createElement("div");
  actions.className = "report__actions";
  actions.append(linkElement({ href: report.sourceUrl, text: "Open source forum page", className: "button-link" }));
  article.append(actions);
  return article;
}

function renderReport({ value }) {
  const report = validateReport({ value: value });
  docElement.replaceChildren(reportElement({ report: report }));
}

function tipsSection({ tips }) {
  const section = document.createElement("section");
  section.className = "doc-section";

  const heading = document.createElement("h2");
  heading.className = "doc-section__heading";
  heading.textContent = "Three tips";
  section.append(heading);

  const list = document.createElement("div");
  list.className = "tips";
  // Three stacked tip panels; the source link is optional per the page-4 contract.
  for (const tip of tips) {
    const panel = document.createElement("article");
    panel.className = "tip";

    const tipHeadline = document.createElement("h3");
    tipHeadline.className = "tip__headline";
    tipHeadline.textContent = tip.headline;
    panel.append(tipHeadline);

    const tipSummary = document.createElement("p");
    tipSummary.className = "tip__summary";
    tipSummary.textContent = tip.summary;
    panel.append(tipSummary);

    if (tip.sourceUrl !== null) {
      panel.append(linkElement({ href: tip.sourceUrl, text: "Open source forum page", className: "button-link" }));
    }
    list.append(panel);
  }
  section.append(list);
  return section;
}

function debateColumn({ heading, side, arguments_ }) {
  const column = document.createElement("div");
  column.className = "debate__column debate__column--" + side;

  const columnHeading = document.createElement("h4");
  columnHeading.className = "debate__column-heading";
  columnHeading.textContent = heading;
  column.append(columnHeading);

  const list = document.createElement("ul");
  list.className = "debate__list";
  // Render every validated argument as its own bullet so the pro/contra weight stays visible.
  for (const argument of arguments_) {
    const item = document.createElement("li");
    item.textContent = argument;
    list.append(item);
  }
  column.append(list);
  return column;
}

function controversialSection({ controversial }) {
  const section = document.createElement("section");
  section.className = "doc-section";

  const heading = document.createElement("h2");
  heading.className = "doc-section__heading";
  heading.textContent = "Three debates";
  section.append(heading);

  const list = document.createElement("div");
  list.className = "debates";
  // Three debate rows; pro renders blue on the left, contra red on the right, per the page-4 contract.
  for (const debate of controversial) {
    const row = document.createElement("article");
    row.className = "debate";

    const debateHeadline = document.createElement("h3");
    debateHeadline.className = "debate__headline";
    debateHeadline.textContent = debate.headline;
    row.append(debateHeadline);

    const columns = document.createElement("div");
    columns.className = "debate__columns";
    columns.append(
      debateColumn({ heading: "For", side: "pro", arguments_: debate.pro }),
      debateColumn({ heading: "Against", side: "contra", arguments_: debate.contra }),
    );
    row.append(columns);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderTips({ value }) {
  const payload = validateTips({ value: value });
  docElement.replaceChildren(tipsSection({ tips: payload.tips }), controversialSection({ controversial: payload.controversial }));
}

function showMessage({ text, kind }) {
  messageElement.textContent = text;
  messageElement.dataset.kind = kind;
  messageElement.hidden = false;
}

function hideMessage() {
  messageElement.hidden = true;
}

function showView({ view }) {
  // Map and doc views are mutually exclusive; toggling hidden keeps a single Leaflet instance alive.
  if (view === "map") {
    mapElement.hidden = false;
    docElement.hidden = true;
  } else if (view === "doc") {
    mapElement.hidden = true;
    docElement.hidden = false;
    docElement.replaceChildren();
  } else {
    throw new RangeError("Unsupported view: " + view);
  }
}

function setChrome({ routeName, route }) {
  document.getElementById("page-title").textContent = route.title;
  document.getElementById("page-subtitle").textContent = route.subtitle;
  // Mark exactly the active nav link so the current page is announced and visibly selected.
  for (const link of document.querySelectorAll(".site-nav a")) {
    if (link.dataset.route === routeName) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

async function activateRoute({ routeName, route }) {
  showView({ view: route.view });
  showMessage({ text: "Loading " + route.title + "…", kind: "loading" });
  try {
    const response = await fetch(route.url + "?loaded=" + Date.now(), { cache: "no-store" });
    if (response.ok === false) {
      throw new Error("Request for " + route.url + " failed with HTTP " + response.status + ".");
    }
    const payload = await response.json();
    if (route.view === "map") {
      const features = validateFeatureCollection({ value: payload });
      if (features.length > 0) {
        renderMapFeatures({ features: features });
        map.invalidateSize();
        hideMessage();
      } else {
        ensureMap().markerGroup.clearLayers();
        showMessage({ text: "There is no news in the retained run window for this page.", kind: "empty" });
      }
    } else if (route.view === "doc") {
      route.render({ value: payload });
      hideMessage();
    } else {
      throw new RangeError("Unsupported view: " + route.view);
    }
  } catch (error) {
    if (route.view === "doc") {
      docElement.replaceChildren();
    }
    showMessage({ text: "The " + route.title + " page could not be loaded.", kind: "error" });
    console.error("Could not load the " + route.title + " page.", error);
  }
}

function routeNameFromHash() {
  const requested = window.location.hash.replace(/^#\/?/, "");
  // Fall back to the default page for an empty or unknown hash so a stray link never shows a blank view.
  if (Object.hasOwn(ROUTES, requested)) {
    return requested;
  } else {
    return DEFAULT_ROUTE;
  }
}

function handleRoute() {
  const routeName = routeNameFromHash();
  const route = ROUTES[routeName];
  setChrome({ routeName: routeName, route: route });
  if (routeName !== activeRoute) {
    activeRoute = routeName;
    activateRoute({ routeName: routeName, route: route });
  }
}

window.addEventListener("hashchange", handleRoute);
handleRoute();
