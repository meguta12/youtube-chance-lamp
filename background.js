/*
 * background.js — レバーを引いた動画の公開情報を取得。接続先・件数を制限してキャッシュする。
 */
(function () {
  "use strict";
  importScripts("core.js");
  const Core = globalThis.ChanceLampCore;
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;
  const TTL = 15 * 60 * 1000;

  async function fetchHtml(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("https://www.youtube.com" + path, {
        credentials: "omit", signal: controller.signal, redirect: "follow"
      });
      if (!response.ok) throw new Error("YouTubeの公開情報取得に失敗しました（HTTP " + response.status + "）。");
      if (new URL(response.url).hostname !== "www.youtube.com") throw new Error("YouTubeの公開情報取得が同意画面へ移動しました。視聴ページからお試しください。");
      const html = await response.text();
      if (html.length > 12000000) throw new Error("YouTubeの応答が大きすぎるため取得を中止しました。");
      return html;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("YouTubeの応答が12秒以内に届きませんでした。もう一度レバーを引いてください。");
      throw error;
    } finally { clearTimeout(timer); }
  }

  function remember(key, value) {
    cache.set(key, { value: value, time: Date.now() });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  }

  function cached(key, task) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < TTL) return Promise.resolve(hit.value);
    if (pending.has(key)) return pending.get(key);
    const promise = task().then(value => remember(key, value)).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }

  function drain() {
    while (active < 3 && queue.length) {
      const job = queue.shift();
      active++;
      job.task().then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }

  function schedule(task) {
    if (queue.length >= 24) return Promise.reject(new Error("取得待ちが多いため、少し待ってからお試しください。"));
    return new Promise((resolve, reject) => { queue.push({ task: task, resolve: resolve, reject: reject }); drain(); });
  }

  function lookup(id) {
    return cached("video:" + id, () => schedule(async () => {
      const data = Core.extractWatch(await fetchHtml("/watch?v=" + id + "&hl=ja"), id);
      if (!data.subscribers) {
        const channel = await cached("channel:" + data.channelId, () => fetchHtml("/channel/" + data.channelId + "?hl=ja")
          .then(html => Core.extractChannel(html, data.channelId)));
        data.subscribers = channel.value;
        data.approximate = channel.approximate;
      }
      Core.classify(data.views, data.subscribers);
      return data;
    }));
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.type !== "chance:lookup") return false;
    const senderUrl = sender.tab && sender.tab.url;
    let origin = "";
    try { origin = new URL(senderUrl).origin; } catch (_) { /* 不正な送信元は下で拒否する。 */ }
    if (origin !== "https://www.youtube.com" || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId || "")) {
      respond({ ok: false, error: "YouTubeの動画ページから取得してください。" });
      return false;
    }
    lookup(message.videoId).then(data => respond({ ok: true, data: data }),
      error => respond({ ok: false, error: error.message || "公開情報の取得に失敗しました。" }));
    return true;
  });
})();
