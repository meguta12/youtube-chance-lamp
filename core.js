/*
 * core.js — 登録者比・色判定・公開HTMLの解析を共有する。外部コードは実行しない。
 */
(function () {
  "use strict";

  const DEFAULTS = Object.freeze({ enabled: true, showCards: true, autoLight: false, muted: false,
    volume: 35, reducedMotion: false, thresholds: { green: 1, red: 3, gold: 10, rainbow: 30 } });
  const TIERS = Object.freeze([
    { key: "green", label: "チャンス" }, { key: "red", label: "大チャンス" },
    { key: "gold", label: "特大チャンス" }, { key: "rainbow", label: "最高チャンス" }
  ]);

  function parseCount(text) {
    const raw = String(text || "").normalize("NFKC").trim();
    if (!raw || /非公開|非表示|hidden|no subscribers|登録者なし/i.test(raw)) return null;
    const match = raw.replace(/[\u00a0\u202f]/g, " ").match(/(?:^|[^\d.\-])(\d[\d,]*(?:\.\d+)?)\s*(億|万|千|[KMB])?/i);
    if (!match) return null;
    const units = { "億": 1e8, "万": 1e4, "千": 1e3, K: 1e3, M: 1e6, B: 1e9 };
    const number = Number(match[1].replace(/,/g, ""));
    const value = Math.round(number * (units[(match[2] || "").toUpperCase()] || 1));
    return Number.isSafeInteger(value) && value >= 0 ? { value: value, approximate: Boolean(match[2]) } : null;
  }

  function settings(input) {
    const source = input && typeof input === "object" ? input : {};
    const thresholds = Object.assign({}, DEFAULTS.thresholds, source.thresholds);
    const values = TIERS.map(tier => Number(thresholds[tier.key]));
    if (values.some((n, i) => !Number.isFinite(n) || n < 0 || n > 1e6 || (i > 0 && n <= values[i - 1]))) {
      throw new Error("倍率は緑 → 赤 → 金 → 虹の順に大きくしてください（0〜100万倍）。");
    }
    const volume = source.volume === undefined ? DEFAULTS.volume : Number(source.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error("音量は0〜100で指定してください。");
    const result = { volume: volume, thresholds: {} };
    ["enabled", "showCards", "autoLight", "muted", "reducedMotion"].forEach(key => {
      result[key] = typeof source[key] === "boolean" ? source[key] : DEFAULTS[key];
    });
    TIERS.forEach((tier, i) => { result.thresholds[tier.key] = values[i]; });
    return result;
  }

  function classify(views, subscribers, thresholds) {
    if (!Number.isSafeInteger(views) || views < 0 || !Number.isSafeInteger(subscribers) || subscribers <= 0) {
      throw new Error("再生数または登録者数を取得できません。登録者数0・非公開の動画は判定できません。");
    }
    const limits = settings({ thresholds: thresholds }).thresholds;
    const ratio = views / subscribers;
    let result = { key: "none", label: "今回は通常", ratio: ratio, threshold: limits.green };
    TIERS.forEach((tier, i) => {
      if (i === 0 ? ratio > limits[tier.key] : ratio >= limits[tier.key]) {
        result = { key: tier.key, label: tier.label, ratio: ratio, threshold: limits[tier.key] };
      }
    });
    return result;
  }

  function videoId(url) {
    try {
      const parsed = new URL(url, "https://www.youtube.com");
      if (parsed.protocol !== "https:") return null;
      if (parsed.hostname !== "www.youtube.com" && parsed.hostname !== "youtube.com") return null;
      const id = parsed.pathname === "/watch" ? parsed.searchParams.get("v") : null;
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    } catch (_) { return null; }
  }

  // script内のJSONだけを切り出す。evalやリモートJavaScriptを使用しない。
  function readInitial(html, name) {
    const pattern = new RegExp("(?:var\\s+)?" + name + "\\s*=\\s*|window\\[\"" + name + "\"\\]\\s*=\\s*", "g");
    let found;
    while ((found = pattern.exec(html))) {
      const start = pattern.lastIndex;
      if (html[start] !== "{") continue;
      let depth = 0, inString = false, escaped = false;
      for (let i = start; i < html.length; i++) {
        const char = html[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(html.slice(start, i + 1)); }
            catch (_) { break; }
          }
        }
      }
    }
    return null;
  }

  function walk(root, visitor) {
    if (!root || typeof root !== "object") return;
    const queue = [root];
    for (let i = 0; i < queue.length && i < 30000; i++) {
      const node = queue[i];
      if (visitor(node) === false) return;
      Object.values(node).forEach(value => { if (value && typeof value === "object") queue.push(value); });
    }
  }

  function textOf(node) {
    if (typeof node === "string") return node;
    if (!node) return "";
    return node.simpleText || node.content || (Array.isArray(node.runs) ? node.runs.map(run => run.text || "").join("") : "");
  }

  function extractSubscribers(initial) {
    let result = null;
    const header = initial && initial.header;
    walk(header, node => {
      const direct = textOf(node.subscriberCountText);
      if (direct) result = parseCount(direct);
      const content = textOf(node.text) || (typeof node.content === "string" ? node.content : "");
      if (!result && /登録者|subscribers/i.test(content)) result = parseCount(content);
      if (result) return false;
    });
    return result;
  }

  function extractWatch(html, expectedId) {
    const player = readInitial(html, "ytInitialPlayerResponse");
    const details = player && player.videoDetails;
    if (!details || details.videoId !== expectedId) {
      throw new Error("この動画の公開情報を読み取れません。限定公開・制限・YouTube側の画面変更をご確認ください。");
    }
    if (!/^[0-9]+$/.test(String(details.viewCount === null || details.viewCount === undefined ? "" : details.viewCount))) {
      throw new Error("動画の再生数を取得できません。");
    }
    const views = Number(details.viewCount);
    if (!Number.isSafeInteger(views) || views < 0 || !/^UC[A-Za-z0-9_-]{22}$/.test(details.channelId || "")) {
      throw new Error("動画の再生数またはチャンネルIDが取得できません。");
    }
    const initial = readInitial(html, "ytInitialData");
    let subscribers = null;
    walk(initial && initial.contents && initial.contents.twoColumnWatchNextResults && initial.contents.twoColumnWatchNextResults.results, node => {
      if (node.videoOwnerRenderer) {
        const parsed = parseCount(textOf(node.videoOwnerRenderer.subscriberCountText));
        if (parsed) subscribers = parsed;
        return false;
      }
    });
    return { videoId: expectedId, channelId: details.channelId, views: views,
      title: String(details.title || ""), channelTitle: String(details.author || ""),
      subscribers: subscribers ? subscribers.value : null, approximate: subscribers ? subscribers.approximate : true };
  }

  function extractChannel(html, expectedId) {
    const initial = readInitial(html, "ytInitialData");
    const metadata = initial && initial.metadata && initial.metadata.channelMetadataRenderer;
    if (!metadata || metadata.externalId !== expectedId) throw new Error("チャンネルの公開情報を読み取れません。");
    const parsed = extractSubscribers(initial);
    if (!parsed || parsed.value <= 0) throw new Error("登録者数が非公開、0人、またはYouTubeから取得できないため判定できません。");
    return parsed;
  }

  const api = Object.freeze({ DEFAULTS: DEFAULTS, TIERS: TIERS, parseCount: parseCount,
    settings: settings, classify: classify, videoId: videoId, readInitial: readInitial,
    extractWatch: extractWatch, extractChannel: extractChannel });
  globalThis.ChanceLampCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
