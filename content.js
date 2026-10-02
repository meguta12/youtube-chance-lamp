/*
 * content.js — 視聴ページと動画カードへランプを配置。SPA移動と取り外されたカードを追跡する。
 */
(function () {
  "use strict";
  const Core = globalThis.ChanceLampCore;
  const UI = globalThis.ChanceLampUI;
  const styleUrl = chrome.runtime.getURL("styles.css");
  const cards = new Map();
  let prefs = Core.settings();
  let watch = null;
  let scheduled = false;
  let disposed = false;
  let scanTimer = null;
  let navigating = false;
  const autoTargets = new Map();
  const autoObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = autoTargets.get(entry.target);
      if (entry.isIntersecting && record && prefs.autoLight && prefs.enabled && !record.attempted) record.check(true);
    }
  }, { threshold: 0.05 }) : null;
  const CARD_SELECTOR = "ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, yt-lockup-view-model";

  function saveMute(muted, origin) {
    prefs.muted = muted;
    chrome.storage.local.set({ chanceLampSettings: prefs }).catch(error => {
      const visible = origin || watch || cards.values().next().value;
      if (visible) visible.widget.setMessage("ミュート設定を保存できません: " + error.message, true);
    });
  }

  function remove(record) {
    record.generation++;
    if (autoObserver) autoObserver.unobserve(record.anchor);
    autoTargets.delete(record.anchor);
    if (record.resize) record.resize.disconnect();
    if (record.restorePosition !== undefined && record.anchor.style.position === "relative") record.anchor.style.position = record.restorePosition;
    record.widget.destroy();
    record.widget.element.remove();
  }

  function readWatch(id) {
    const flexy = document.querySelector("ytd-watch-flexy");
    if (!flexy || flexy.getAttribute("video-id") !== id || flexy.hasAttribute("hidden")) return null;
    const metadata = flexy.querySelector("ytd-watch-metadata");
    if (!metadata) return null;
    const viewNode = metadata.querySelector("ytd-video-view-count-renderer .view-count");
    const shortViews = metadata.querySelector("ytd-watch-info-text #info") || metadata.querySelector("ytd-watch-info-text");
    const subscriberNode = metadata.querySelector("#owner-sub-count");
    const views = Core.parseCount(viewNode ? viewNode.textContent : shortViews && shortViews.textContent);
    const subscribers = Core.parseCount(subscriberNode && (subscriberNode.getAttribute("aria-label") || subscriberNode.textContent));
    if (!views || !subscribers || subscribers.value <= 0) return null;
    return { videoId: id, views: views.value, subscribers: subscribers.value,
      ratio: views.value / subscribers.value, approximate: views.approximate || subscribers.approximate,
      title: (metadata.querySelector("h1") || {}).textContent || "",
      channelTitle: (metadata.querySelector("ytd-video-owner-renderer #channel-name") || {}).textContent || "" };
  }

  async function lookup(id) {
    const response = await chrome.runtime.sendMessage({ type: "chance:lookup", videoId: id });
    if (!response || !response.ok) throw new Error(response && response.error || "拡張を再読み込みして、YouTubeのタブも再読み込みしてください。");
    if (response.data.videoId !== id) throw new Error("取得した動画IDが一致しません。もう一度お試しください。");
    return Object.assign({}, response.data, { ratio: response.data.views / response.data.subscribers });
  }

  function placeWatch(record) {
    const metadata = record.anchor;
    const host = record.widget.element;
    const row = metadata.querySelector("#top-row");
    const reaction = row && (row.querySelector("segmented-like-dislike-button-view-model") || row.querySelector("#top-level-buttons-computed"));
    if (!row || !reaction) return;
    const rowRect = row.getBoundingClientRect(), reactionRect = reaction.getBoundingClientRect();
    if (!reactionRect.width || !rowRect.width) return;
    let left = rowRect.left;
    // vidIQのAnalyzeを含め、高評価より左にある実要素の右端を基準にする。
    for (const node of row.querySelectorAll("*")) {
      if (node.closest("[data-chance-lamp]")) continue;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right <= reactionRect.left - 2 &&
        r.top >= rowRect.top - 6 && r.bottom <= rowRect.bottom + 6) left = Math.max(left, r.right);
    }
    left += 10;
    const width = Math.min(380, reactionRect.left - 10 - left);
    if (width < 160) {
      // 横に余白がない画面では同じ情報帯の中に収め、既存ボタンを隠さない。
      host.style.position = "relative";
      host.style.left = "";
      host.style.top = "";
      host.style.setProperty("--watch-width", Math.min(280, metadata.getBoundingClientRect().width) + "px");
      host.style.setProperty("--watch-height", "72px");
      if (host.previousElementSibling !== row) row.after(host);
      return;
    }
    if (host.parentElement !== metadata) metadata.append(host);
    host.style.position = "absolute";
    const title = metadata.querySelector("h1"), description = metadata.querySelector("#description");
    const top = title ? title.getBoundingClientRect().bottom + 4 : rowRect.top - 12;
    const bottom = description ? description.getBoundingClientRect().top - 4 : rowRect.bottom + 12;
    const height = Math.max(40, Math.min(112, bottom - top, width / 2.4));
    const targetTop = top + Math.max(0, bottom - top - height) / 2;
    const parent = host.offsetParent || metadata;
    const parentRect = parent.getBoundingClientRect();
    host.style.left = (left - parentRect.left + (parent.scrollLeft || 0) - (parent.clientLeft || 0)) + "px";
    host.style.top = (targetTop - parentRect.top + (parent.scrollTop || 0) - (parent.clientTop || 0)) + "px";
    host.style.setProperty("--watch-width", width + "px");
    host.style.setProperty("--watch-height", height + "px");
  }

  function queueAutomatic(record) {
    if (!prefs.autoLight || !prefs.enabled || record.attempted) return;
    if (autoObserver) {
      autoTargets.set(record.anchor, record);
      autoObserver.observe(record.anchor);
    } else {
      const r = record.anchor.getBoundingClientRect();
      if (r.bottom > 0 && r.top < (window.innerHeight || 1000)) record.check(true);
    }
  }

  function makeRecord(id, compact, container, anchor = container) {
    const record = { id: id, generation: 0, widget: null, data: null, anchor: anchor, container: container,
      isCard: compact, attempted: false };
    async function check(silent) {
        if (disposed || !record.widget.element.isConnected ||
          (compact && Core.videoId(anchor.href) !== id) || (!compact && Core.videoId(location.href) !== id)) return;
        record.attempted = true;
        const generation = ++record.generation;
        record.widget.setBusy(true);
        try {
          const data = !compact && !navigating && readWatch(id) || await lookup(id);
          if (disposed || generation !== record.generation || !record.widget.element.isConnected) return;
          if (!compact && Core.videoId(location.href) !== id) return;
          if (compact) {
            const currentLink = container.querySelector('a[href*="/watch?v="]');
            if (!currentLink || Core.videoId(currentLink.href) !== id) return;
          }
          const result = Core.classify(data.views, data.subscribers, prefs.thresholds);
          record.data = data;
          record.widget.setData(data);
          record.widget.reveal(result, { silent: Boolean(silent) });
        } catch (error) {
          if (generation === record.generation && record.widget.element.isConnected) {
            record.widget.reset();
            record.widget.setMessage(error.message || "公開情報の取得に失敗しました。", true);
          }
        } finally {
          if (generation === record.generation) record.widget.setBusy(false);
        }
    }
    record.check = check;
    record.widget = UI.create({ compact: compact, badge: compact, watchInline: !compact, styleUrl: styleUrl, volume: prefs.volume,
      muted: prefs.muted, reducedMotion: prefs.reducedMotion, onMute: muted => saveMute(muted, record),
      onPull: () => check(false) });
    record.widget.element.dataset.chanceLamp = "";
    if (compact && getComputedStyle(anchor).position === "static") {
      record.restorePosition = anchor.style.position || "";
      anchor.style.position = "relative";
    }
    anchor.append(record.widget.element);
    if (!compact) {
      placeWatch(record);
      if (typeof ResizeObserver === "function") {
        record.resize = new ResizeObserver(requestScan);
        record.resize.observe(anchor);
      }
    }
    return record;
  }

  function scan() {
    scheduled = false;
    if (disposed) return;
    for (const [container, record] of cards) {
      const link = container.querySelector('a[href*="/watch?v="]');
      if (!prefs.enabled || !prefs.showCards || !container.isConnected || !record.widget.element.isConnected || !link || Core.videoId(link.href) !== record.id) {
        remove(record);
        cards.delete(container);
      }
    }
    const id = Core.videoId(location.href);
    if (watch && (!prefs.enabled || watch.id !== id || !watch.widget.element.isConnected)) {
      remove(watch);
      watch = null;
    }
    if (!prefs.enabled) return;
    const flexy = document.querySelector("ytd-watch-flexy");
    const metadata = !navigating && flexy && flexy.getAttribute("video-id") === id && !flexy.hasAttribute("hidden") && flexy.querySelector("ytd-watch-metadata");
    if (id && metadata && !watch) {
      watch = makeRecord(id, false, metadata);
      const data = readWatch(id);
      if (data) { watch.data = data; watch.widget.setData(data); }
    }
    if (watch) {
      placeWatch(watch);
      if (!watch.data) {
        const data = readWatch(id);
        if (data) { watch.data = data; watch.widget.setData(data); }
      }
      queueAutomatic(watch);
    }
    if (!prefs.showCards) return;
    // 無限スクロールでも、画面から消えたカードの音声・タイマーは上で破棄する。
    for (const container of document.querySelectorAll(CARD_SELECTOR)) {
      if (cards.has(container) || container.closest("ytd-reel-shelf-renderer") ||
        container.querySelector("[data-chance-lamp]") || cards.size >= 180) continue;
      const link = container.querySelector('a[href*="/watch?v="]');
      const cardId = link && Core.videoId(link.href);
      if (!cardId || container.parentElement && container.parentElement.closest(CARD_SELECTOR)) continue;
      const thumbnail = Array.from(container.querySelectorAll('a[href*="/watch?v="]')).find(anchor => anchor.querySelector("img"));
      if (!thumbnail) continue;
      cards.set(container, makeRecord(cardId, true, container, thumbnail));
    }
    cards.forEach(queueAutomatic);
  }

  function requestScan() {
    if (scheduled || disposed) return;
    scheduled = true;
    scanTimer = setTimeout(() => requestAnimationFrame(scan), 250);
  }

  function applyPreferences(next) {
    try { prefs = Core.settings(next); }
    catch (error) {
      scan();
      const visible = watch || cards.values().next().value;
      if (visible) visible.widget.setMessage("設定を読み込めません。使用可能な設定で続けます: " + error.message, true);
      return;
    }
    const records = [...cards.values(), ...(watch ? [watch] : [])];
    records.forEach(record => {
      record.generation++;
      record.attempted = false;
      if (autoObserver) autoObserver.unobserve(record.anchor);
      record.widget.reset();
      record.widget.setPreferences(prefs);
      if (record.data) {
        record.widget.setData(record.data);
        const currentId = record.isCard ? Core.videoId(record.anchor.href) : Core.videoId(location.href);
        if (prefs.autoLight && currentId === record.id) {
          record.attempted = true;
          record.widget.reveal(Core.classify(record.data.views, record.data.subscribers, prefs.thresholds), { silent: true });
        }
      }
    });
    requestScan();
  }

  const observer = new MutationObserver(mutations => {
    const relevant = mutations.some(mutation => {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (target && target.closest("[data-chance-lamp]")) return false;
      if (mutation.type === "childList" && mutation.addedNodes.length &&
        Array.from(mutation.addedNodes).every(node => node.nodeType === 1 && node.matches("[data-chance-lamp]"))) return false;
      return true;
    });
    if (relevant) requestScan();
  });

  chrome.storage.local.get("chanceLampSettings").then(stored => {
    applyPreferences(stored.chanceLampSettings);
  }).catch(() => {
    scan();
    if (watch) watch.widget.setMessage("設定を読み込めませんでした。初期値で動作しています。", true);
  }).finally(() => {
    if (!disposed) observer.observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["video-id", "href", "hidden"] });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.chanceLampSettings) applyPreferences(changes.chanceLampSettings.newValue);
  });
  document.addEventListener("yt-navigate-start", () => {
    navigating = true;
    if (watch) { remove(watch); watch = null; }
  });
  document.addEventListener("yt-navigate-finish", () => { navigating = false; requestScan(); });
  window.addEventListener("popstate", requestScan);
  window.addEventListener("resize", requestScan);
  window.addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(scanTimer);
    scheduled = false;
    observer.disconnect();
    if (autoObserver) autoObserver.disconnect();
    cards.forEach(remove);
    cards.clear();
    if (watch) { remove(watch); watch = null; }
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    disposed = false;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["video-id", "href", "hidden"] });
    requestScan();
  });
})();
