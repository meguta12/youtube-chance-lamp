/*
 * background.test.cjs — 公開情報取得のキャッシュ・同時実行・失敗復旧をVMで検証する。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const VIDEO = "dQw4w9WgXcQ";
const CHANNEL = "UC" + "a".repeat(22);
const tick = () => new Promise(resolve => setImmediate(resolve));

function watchHtml(id = VIDEO, subscribers = "登録者数 1万人") {
  return "var ytInitialPlayerResponse = " + JSON.stringify({ videoDetails: {
    videoId: id, channelId: CHANNEL, viewCount: "100000", title: "検証動画", author: "投稿者"
  } }) + ";var ytInitialData = " + JSON.stringify({ contents: { twoColumnWatchNextResults: { results: {
    videoOwnerRenderer: { subscriberCountText: { simpleText: subscribers } }
  } } } }) + ";";
}

function channelHtml() {
  return "var ytInitialData = " + JSON.stringify({ metadata: { channelMetadataRenderer: { externalId: CHANNEL } },
    header: { pageHeaderRenderer: { text: { content: "登録者数 2万人" } } } }) + ";";
}

function response(url, html, overrides = {}) {
  return { ok: true, status: 200, url, text: async () => html, ...overrides };
}

function createWorker(handler) {
  const calls = [];
  const timers = new Map();
  let now = 1000, nextTimer = 0, listener;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ ChanceLampCore: Core, URL, AbortController, Date: Clock,
    importScripts(name) { assert.equal(name, "core.js"); },
    fetch(url, options) { calls.push({ url, options }); return handler(url, options, calls.length); },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } }
  });
  vm.runInContext(source, context, { filename: "background.js" });
  function request(id = VIDEO, senderUrl = "https://www.youtube.com/watch?v=" + VIDEO) {
    return new Promise((resolve, reject) => {
      try { listener({ type: "chance:lookup", videoId: id }, { tab: { url: senderUrl } }, resolve); }
      catch (error) { reject(error); }
    });
  }
  return { request, calls, timers, listener, advance(ms) { now += ms; },
    expireRequests() { for (const timer of [...timers.values()]) { assert.equal(timer.delay, 12000); timer.callback(); } }
  };
}

test("不正な動画IDとYouTube以外の送信元では取得を始めない", async () => {
  const worker = createWorker(() => { throw new Error("fetch禁止"); });
  for (const id of ["", "short", VIDEO + "x", "abcdefghij!", "../channel/x"]) {
    assert.equal((await worker.request(id)).ok, false);
  }
  for (const url of ["https://evil.example/watch?v=" + VIDEO, "http://www.youtube.com/watch?v=" + VIDEO,
    "https://www.youtube.com.evil.example/watch?v=" + VIDEO]) {
    assert.equal((await worker.request(VIDEO, url)).ok, false);
  }
  assert.equal(worker.calls.length, 0);
  assert.equal(worker.listener({ type: "other" }, {}, () => assert.fail("応答不要")), false);
});

test("不正な送信元URLはthrowせずエラー応答にする", async () => {
  const worker = createWorker(() => { throw new Error("fetch禁止"); });
  assert.equal((await worker.request(VIDEO, "malformed URL")).ok, false);
  assert.equal(worker.calls.length, 0);
});

test("公開情報は許可されたURLから資格情報なしで取得して返す", async () => {
  const worker = createWorker(async url => response(url, watchHtml()));
  const result = await worker.request();
  assert.equal(result.ok, true);
  assert.equal(result.data.views, 100000);
  assert.equal(result.data.subscribers, 10000);
  assert.equal(worker.calls[0].url, "https://www.youtube.com/watch?v=" + VIDEO + "&hl=ja");
  assert.equal(worker.calls[0].options.credentials, "omit");
  assert.equal(worker.timers.size, 0);
});

test("同じ動画の同時要求は1取得を共有し、その後はキャッシュを使う", async () => {
  let release;
  const worker = createWorker(url => new Promise(resolve => { release = () => resolve(response(url, watchHtml())); }));
  const first = worker.request(), second = worker.request();
  assert.equal(worker.calls.length, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal((await worker.request()).ok, true);
  assert.equal(worker.calls.length, 1);
  worker.advance(15 * 60 * 1000);
  const expired = worker.request();
  assert.equal(worker.calls.length, 2);
  release();
  assert.equal((await expired).ok, true);
});

test("HTTP失敗はキャッシュせず、次のレバーで回復できる", async () => {
  const worker = createWorker(async (url, _, number) => number === 1
    ? response(url, "", { ok: false, status: 503 }) : response(url, watchHtml()));
  const failed = await worker.request();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP 503/);
  assert.equal((await worker.request()).ok, true);
  assert.equal(worker.calls.length, 2);
  assert.equal(worker.timers.size, 0);
});

test("別動画のplayerを受け取っても誤ったデータを返さない", async () => {
  const worker = createWorker(async url => response(url, watchHtml("jNQXAC9IVRw")));
  const result = await worker.request();
  assert.equal(result.ok, false);
  assert.match(result.error, /この動画/);
  assert.equal(result.data, undefined);
});

test("登録者数がwatchにないときチャンネルを取得し、同じチャンネルを共有する", async () => {
  const worker = createWorker(async url => response(url, url.includes("/channel/")
    ? channelHtml() : watchHtml(new URL(url).searchParams.get("v"), "非公開")));
  const results = await Promise.all([worker.request(VIDEO), worker.request("jNQXAC9IVRw")]);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.data.subscribers, 20000);
    assert.equal(result.data.approximate, true);
  }
  assert.equal(worker.calls.filter(call => call.url.includes("/channel/")).length, 1);
});

test("登録者数0・非公開の取得結果を点灯可能なデータとして返さない", async () => {
  const html = channelHtml().replace("登録者数 2万人", "0 subscribers");
  const worker = createWorker(async url => response(url, url.includes("/channel/") ? html : watchHtml(VIDEO, "非公開")));
  const result = await worker.request();
  assert.equal(result.ok, false);
  assert.match(result.error, /判定できません/);
  assert.equal(result.data, undefined);
});

test("別ドメインへのredirectや巨大応答は解析しない", async () => {
  const redirected = createWorker(async url => response("https://consent.youtube.com/m", watchHtml()));
  assert.match((await redirected.request()).error, /同意画面/);
  const oversized = createWorker(async url => response(url, "x".repeat(12000001)));
  assert.match((await oversized.request()).error, /大きすぎる/);
});

test("12秒timeoutはabortして明示し、次の要求では再取得できる", async () => {
  const worker = createWorker((url, options, number) => {
    if (number > 1) return Promise.resolve(response(url, watchHtml()));
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    }, { once: true }));
  });
  const first = worker.request();
  assert.equal(worker.timers.size, 1);
  worker.expireRequests();
  const result = await first;
  assert.equal(result.ok, false);
  assert.match(result.error, /12秒/);
  assert.equal(worker.calls[0].options.signal.aborted, true);
  assert.equal(worker.timers.size, 0);
  assert.equal((await worker.request()).ok, true);
  assert.equal(worker.calls.length, 2);
});

test("別動画の取得は同時3件まで。完了すると待機分を実行する", async () => {
  const releases = [];
  const worker = createWorker(url => new Promise(resolve => {
    releases.push(() => resolve(response(url, watchHtml(new URL(url).searchParams.get("v")))));
  }));
  const ids = [VIDEO, "jNQXAC9IVRw", "aaaaaaaaaaa", "bbbbbbbbbbb"];
  const requests = ids.map(id => worker.request(id));
  assert.equal(worker.calls.length, 3);
  releases[0]();
  await tick();
  assert.equal(worker.calls.length, 4);
  for (const release of releases.slice(1)) release();
  const results = await Promise.all(requests);
  assert.ok(results.every(result => result.ok));
});

test("待機が24件を超える要求は理由つきで拒否し、既存要求を壊さない", async () => {
  const releases = [];
  const worker = createWorker(url => new Promise(resolve => {
    releases.push(() => resolve(response(url, watchHtml(new URL(url).searchParams.get("v")))));
  }));
  const requests = Array.from({ length: 27 }, (_, i) => worker.request(String(i).padStart(11, "0")));
  const overflow = await worker.request("99999999999");
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /取得待ち/);
  assert.equal(worker.calls.length, 3);
  while (worker.calls.length < 27) {
    for (const release of releases.splice(0)) release();
    await tick();
  }
  for (const release of releases.splice(0)) release();
  assert.ok((await Promise.all(requests)).every(result => result.ok));
});
