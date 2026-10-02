/*
 * content.test.cjs — 実際のcontent.jsを最小DOM fixtureで実行し、SPAと非同期取得を検証する。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");
const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
const VIDEO = "dQw4w9WgXcQ", OTHER = "jNQXAC9IVRw";
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag;
    this.attributes = { ...attributes };
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.textContent = "";
    this.nodeType = 1;
    this.style = { position: "", setProperty(key, value) { this[key] = value; } };
    this.rect = { left: 0, top: 0, width: 800, height: 80, right: 800, bottom: 80 };
  }
  getBoundingClientRect() { return this.rect; }
  get previousElementSibling() { if (!this.parentElement) return null; return this.parentElement.children[this.parentElement.children.indexOf(this) - 1] || null; }
  get isConnected() { return this.root || Boolean(this.parentElement && this.parentElement.isConnected); }
  get href() { return this.getAttribute("href"); }
  set href(value) { this.setAttribute("href", value); }
  getAttribute(key) { return this.attributes[key] === undefined ? null : this.attributes[key]; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  hasAttribute(key) { return this.attributes[key] !== undefined || key === "data-chance-lamp" && this.dataset.chanceLamp !== undefined; }
  append(child) { child.remove(); child.parentElement = this; this.children.push(child); }
  after(child) {
    const parent = this.parentElement;
    child.remove();
    child.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const value = part.trim();
      if (value === "*") return true;
      if (value === "[data-chance-lamp]") return this.hasAttribute("data-chance-lamp");
      if (value.startsWith("a[")) return this.tagName === "a" && String(this.href || "").includes("/watch?v=");
      if (value.startsWith("#")) return this.getAttribute("id") === value.slice(1);
      if (value.startsWith(".")) return String(this.getAttribute("class") || "").split(" ").includes(value.slice(1));
      return this.tagName === value;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement && this.parentElement.closest(selector); }
  querySelectorAll(selector) {
    const parts = selector.includes(",") ? [selector] : selector.trim().split(/\s+(?![^[]*\])/);
    const result = [];
    const visit = element => {
      for (const child of element.children) {
        if (parts.length === 1 ? child.matches(selector) : child.matches(parts.at(-1)) && parts.slice(0, -1).every(part => child.parentElement.closest(part))) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture({ settings, url, failStorage = false, failSave = false } = {}) {
  const body = new Element("body");
  body.root = true;
  const widgets = [], requests = [], timers = new Map(), listeners = new Map();
  let storageListener, observer, nextTimer = 0;
  const location = { href: url || "https://www.youtube.com/" };
  const document = { body, querySelector: selector => body.querySelector(selector),
    querySelectorAll: selector => body.querySelectorAll(selector),
    addEventListener: (name, listener) => listeners.set(name, listener) };
  const window = { addEventListener: (name, listener) => listeners.set(name, listener) };
  const ui = { create(options) {
    const widget = { options, element: new Element("div"), data: null, result: null, destroyed: false, busy: false,
      messages: [], resets: 0, preferences: null,
      setBusy(value) { this.busy = value; }, setData(value) { this.data = value; },
      reveal(value, options) { this.result = value; this.revealOptions = options; }, setMessage(value, error) { this.messages.push({ value, error }); },
      reset() { this.resets++; this.result = null; this.busy = false; },
      setPreferences(value) { this.preferences = value; }, destroy() { this.destroyed = true; this.element.remove(); }
    };
    widgets.push(widget);
    return widget;
  } };
  class Observer {
    constructor(listener) { this.listener = listener; observer = this; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const context = vm.createContext({ ChanceLampCore: Core, ChanceLampUI: ui, document, window, location,
    MutationObserver: Observer, getComputedStyle: () => ({ position: "static" }),
    requestAnimationFrame: callback => callback(),
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: { runtime: { getURL: name => "chrome-extension://fixture/" + name,
      sendMessage(message) { return new Promise(resolve => requests.push({ message, resolve })); } },
      storage: { local: { get: async () => { if (failStorage) throw new Error("保存失敗"); return { chanceLampSettings: settings }; },
        set: async () => { if (failSave) throw new Error("保存失敗"); } }, onChanged: { addListener: listener => { storageListener = listener; } } } }
  });
  vm.runInContext(source, context, { filename: "content.js" });
  function addCard(id = VIDEO, tag = "ytd-video-renderer", parent = body) {
    const card = new Element(tag), link = new Element("a", { href: "https://www.youtube.com/watch?v=" + id });
    link.append(new Element("img"));
    card.append(link); parent.append(card);
    return { card, link };
  }
  function addWatch(id = VIDEO, views = "再生回数 30万回", subscribers = "チャンネル登録者数 1万人") {
    const flexy = new Element("ytd-watch-flexy", { "video-id": id });
    const metadata = new Element("ytd-watch-metadata");
    const row = new Element("div", { id: "top-row" }), owner = new Element("div", { id: "owner" });
    const reaction = new Element("div", { id: "top-level-buttons-computed" }), description = new Element("div", { id: "description" });
    row.rect = { left: 0, top: 40, width: 1000, height: 40, right: 1000, bottom: 80 };
    owner.rect = { left: 0, top: 40, width: 300, height: 40, right: 300, bottom: 80 };
    reaction.rect = { left: 700, top: 40, width: 300, height: 40, right: 1000, bottom: 80 };
    description.rect = { left: 0, top: 100, width: 1000, height: 80, right: 1000, bottom: 180 };
    row.append(owner); row.append(reaction); metadata.append(row); metadata.append(description);
    const viewRenderer = new Element("ytd-video-view-count-renderer"), view = new Element("span", { class: "view-count" });
    const sub = new Element("span", { id: "owner-sub-count" }), title = new Element("h1");
    view.textContent = views; sub.textContent = subscribers; title.textContent = "fixture動画";
    title.rect = { left: 0, top: 0, width: 1000, height: 28, right: 1000, bottom: 28 };
    viewRenderer.append(view); metadata.append(viewRenderer); metadata.append(sub); metadata.append(title);
    flexy.append(metadata); body.append(flexy);
    return { flexy, metadata, row, owner, reaction, description };
  }
  return { widgets, requests, timers, location, observer: () => observer, addCard, addWatch,
    async flush() { await tick(); const active = [...timers.entries()]; for (const [id, timer] of active) { timers.delete(id); timer.callback(); } await tick(); },
    event(name, value = {}) { listeners.get(name)(value); },
    mutation(target, type = "attributes", addedNodes = []) { observer.listener([{ target, type, addedNodes }]); },
    settings(value) { storageListener({ chanceLampSettings: { newValue: value } }, "local"); },
    respond(index, id = VIDEO, views = 300000, subscribers = 10000) {
      requests[index].resolve({ ok: true, data: { videoId: id, views, subscribers, title: "取得動画", approximate: false } });
    }
  };
}

test("カードを重複配置せず、レバー操作まで公開情報を取得しない", async () => {
  const page = fixture();
  const { card } = page.addCard();
  await page.flush();
  assert.equal(page.widgets.length, 1);
  assert.equal(page.requests.length, 0);
  page.mutation(card);
  await page.flush();
  assert.equal(page.widgets.length, 1);
  const pull = page.widgets[0].options.onPull();
  assert.equal(page.requests[0].message.videoId, VIDEO);
  page.respond(0);
  await pull;
  assert.equal(page.widgets[0].result.key, "rainbow");
  assert.equal(page.widgets[0].busy, false);
});

test("視聴中の正しい動画DOMでは追加取得せず比率を判定する", async () => {
  const page = fixture({ url: "https://www.youtube.com/watch?v=" + VIDEO });
  page.addWatch();
  await page.flush();
  assert.equal(page.widgets.length, 1);
  await page.widgets[0].options.onPull();
  assert.equal(page.requests.length, 0);
  assert.equal(page.widgets[0].data.ratio, 30);
  assert.equal(page.widgets[0].result.key, "rainbow");
});

test("視聴ページ遷移後に届く古い応答を新しいランプへ表示しない", async () => {
  const page = fixture({ url: "https://www.youtube.com/watch?v=" + VIDEO });
  const oldWatch = page.addWatch(VIDEO, "取得できません", "非公開");
  await page.flush();
  const oldWidget = page.widgets[0], oldPull = oldWidget.options.onPull();
  page.event("yt-navigate-start");
  oldWatch.flexy.remove();
  page.location.href = "https://www.youtube.com/watch?v=" + OTHER;
  page.addWatch(OTHER);
  page.event("yt-navigate-finish");
  await page.flush();
  page.respond(0);
  await oldPull;
  assert.equal(oldWidget.destroyed, true);
  assert.equal(oldWidget.result, null);
  assert.equal(page.widgets.length, 2);
  assert.equal(page.widgets[1].result, null);
});

test("再利用されたカードでscan前に届く旧動画の応答を点灯しない", async () => {
  const page = fixture(), { link } = page.addCard();
  await page.flush();
  const widget = page.widgets[0], pull = widget.options.onPull();
  link.href = "https://www.youtube.com/watch?v=" + OTHER;
  page.mutation(link);
  page.respond(0);
  await pull;
  assert.equal(widget.result, null);
  await page.flush();
  assert.equal(widget.destroyed, true);
  assert.equal(page.widgets.length, 2);
});

test("カード再利用のscan後では古い応答を破棄し新しい動画を取得する", async () => {
  const page = fixture(), { link } = page.addCard();
  await page.flush();
  const old = page.widgets[0], oldPull = old.options.onPull();
  link.href = "https://www.youtube.com/watch?v=" + OTHER;
  page.mutation(link);
  await page.flush();
  page.respond(0);
  await oldPull;
  assert.equal(old.destroyed, true);
  assert.equal(old.result, null);
  const current = page.widgets[1], newPull = current.options.onPull();
  assert.equal(page.requests[1].message.videoId, OTHER);
  page.respond(1, OTHER, 30000);
  await newPull;
  assert.equal(current.result.key, "red");
});

test("設定変更は待機中の取得を無効化し全ランプへミュートを反映する", async () => {
  const page = fixture();
  page.addCard(); page.addCard(OTHER);
  await page.flush();
  const widget = page.widgets[0], pull = widget.options.onPull();
  page.settings({ muted: true, showCards: false });
  page.respond(0);
  await pull;
  assert.equal(widget.result, null);
  assert.equal(widget.busy, false);
  assert.equal(page.widgets.every(item => item.preferences.muted), true);
  await page.flush();
  assert.equal(page.widgets.every(item => item.destroyed), true);
});

test("登録者数0や非公開はチャンスにせずエラーを表示する", async () => {
  const page = fixture(); page.addCard();
  await page.flush();
  const widget = page.widgets[0], pull = widget.options.onPull();
  page.respond(0, VIDEO, 100000, 0);
  await pull;
  assert.equal(widget.result, null);
  assert.match(widget.messages[0].value, /登録者数0・非公開/);
  assert.equal(widget.messages[0].error, true);
  assert.equal(widget.busy, false);
});

test("ランプ自身の変更を無視してobserverの再scanループを防ぐ", async () => {
  const page = fixture(), { card } = page.addCard();
  await page.flush();
  const element = page.widgets[0].element;
  page.mutation(element);
  page.mutation(card, "childList", [element]);
  assert.equal(page.timers.size, 0);
  page.mutation(card);
  assert.equal(page.timers.size, 1);
  page.mutation(card);
  assert.equal(page.timers.size, 1);
});

test("scan待ちでBFCacheに入っても復帰時にランプを配置し直す", async () => {
  const page = fixture(), { card } = page.addCard();
  await page.flush();
  page.mutation(card);
  assert.equal(page.timers.size, 1);
  page.event("pagehide");
  assert.equal(page.widgets[0].destroyed, true);
  assert.equal(page.timers.size, 0);
  page.event("pageshow", { persisted: true });
  await page.flush();
  assert.equal(page.widgets.length, 2);
  assert.equal(page.widgets[1].element.isConnected, true);
});

test("設定読込失敗でも初期値でランプを表示し読込エラーを伝える", async () => {
  const page = fixture({ url: "https://www.youtube.com/watch?v=" + VIDEO, failStorage: true });
  page.addWatch();
  await page.flush();
  assert.equal(page.widgets.length, 1);
  assert.match(page.widgets[0].messages[0].value, /設定を読み込めませんでした/);
});

test("不正な保存設定でも初期値でランプを表示し設定エラーを伝える", async () => {
  const page = fixture({ url: "https://www.youtube.com/watch?v=" + VIDEO,
    settings: { thresholds: { green: 1, red: 0.5 } } });
  page.addWatch();
  await page.flush();
  assert.equal(page.widgets.length, 1);
  assert.match(page.widgets[0].messages[0].value, /設定/);
  assert.equal(page.widgets[0].messages[0].error, true);
});

test("無効設定・ショート棚・ネストしたカードで余計なランプを作らない", async () => {
  const disabled = fixture({ settings: { enabled: false } });
  disabled.addCard();
  await disabled.flush();
  assert.equal(disabled.widgets.length, 0);
  const page = fixture(), { card } = page.addCard(VIDEO, "ytd-rich-item-renderer");
  page.addCard(VIDEO, "ytd-video-renderer", card);
  const { card: shelf } = page.addCard(VIDEO, "ytd-reel-shelf-renderer");
  page.addCard(OTHER, "ytd-rich-item-renderer", shelf);
  await page.flush();
  assert.equal(page.widgets.length, 1);
});

test("異なる動画IDと取得失敗の応答を通常やチャンスとして扱わない", async () => {
  for (const response of [{ ok: true, data: { videoId: OTHER, views: 300000, subscribers: 10000 } },
    { ok: false, error: "取得できませんでした" }, { ok: true, data: { videoId: VIDEO, views: null, subscribers: null } }]) {
    const page = fixture(); page.addCard();
    await page.flush();
    const widget = page.widgets[0], pull = widget.options.onPull();
    page.requests[0].resolve(response);
    await pull;
    assert.equal(widget.result, null);
    assert.equal(widget.messages[0].error, true);
    assert.equal(widget.busy, false);
  }
});

test("カード上のミュート保存失敗をランプへ表示する", async () => {
  const page = fixture({ failSave: true }); page.addCard();
  await page.flush();
  const widget = page.widgets[0];
  widget.options.onMute(true);
  await tick();
  assert.equal(widget.messages.length, 1);
  assert.match(widget.messages[0].value, /ミュート設定を保存できません/);
  assert.equal(widget.messages[0].error, true);
});

test("一覧はサムネ内にランプを置き、カード直下へパネルを増やさない", async () => {
  const page = fixture(), { card, link } = page.addCard();
  await page.flush();
  assert.equal(page.widgets[0].element.parentElement, link);
  assert.equal(card.children.length, 1);
  assert.equal(page.widgets[0].options.badge, true);
  assert.equal(link.style.position, "relative");
});

test("視聴ページはAnalyzeと高評価の間で、タイトルと概要欄の縦幅に収める", async () => {
  const page = fixture({ url: "https://www.youtube.com/watch?v=" + VIDEO });
  const { row, metadata, reaction, description } = page.addWatch();
  const analyze = new Element("button");
  analyze.rect = { left: 330, top: 40, width: 120, height: 40, right: 450, bottom: 80 };
  row.append(analyze);
  await page.flush();
  const widget = page.widgets[0];
  assert.equal(widget.options.watchInline, true);
  assert.equal(widget.element.parentElement, metadata);
  assert.equal(widget.element.style.position, "absolute");
  const left = parseFloat(widget.element.style.left), top = parseFloat(widget.element.style.top);
  const height = parseFloat(widget.element.style["--watch-height"]), width = parseFloat(widget.element.style["--watch-width"]);
  assert.ok(left > analyze.rect.right);
  assert.ok(left + width < reaction.rect.left);
  assert.ok(top > metadata.querySelector("h1").rect.bottom);
  assert.ok(top + height < description.rect.top);
  assert.ok(height > row.rect.height, "余白の高さを使い、ボタンと同じ小さな高さに限定しない");
});

test("横の余白がなくなっても既存ボタンを保持し、拡大時には余白へ戻る", async () => {
  const page = fixture({ url: "https://www.youtube.com/watch?v=" + VIDEO });
  const { row, owner, reaction } = page.addWatch();
  await page.flush();
  owner.rect.right = 650;
  page.event("resize"); await page.flush();
  assert.equal(page.widgets[0].element.style.position, "relative");
  assert.equal(page.widgets[0].element.previousElementSibling, row);
  assert.equal(owner.parentElement, row); assert.equal(reaction.parentElement, row);
  owner.rect.right = 300;
  page.event("resize"); await page.flush();
  assert.equal(page.widgets[0].element.style.position, "absolute");
  assert.equal(page.widgets.length, 1);
});

test("自動点灯は音なしで一度判定し、DOM変更のたびに再取得しない", async () => {
  const page = fixture({ settings: { autoLight: true } }), { card } = page.addCard();
  await page.flush();
  assert.equal(page.requests.length, 1);
  page.respond(0); await tick();
  assert.equal(page.widgets[0].result.key, "rainbow");
  assert.equal(page.widgets[0].revealOptions.silent, true);
  page.mutation(card); await page.flush();
  assert.equal(page.requests.length, 1);
});

test("自動点灯をオンにした時も、再利用されたカードの旧データを点灯しない", async () => {
  const page = fixture(), { link } = page.addCard();
  await page.flush();
  await (async () => { const work = page.widgets[0].options.onPull(); page.respond(0); await work; })();
  link.href = "https://www.youtube.com/watch?v=" + OTHER;
  page.settings({ autoLight: true });
  assert.equal(page.widgets[0].result, null);
  await page.flush();
  assert.equal(page.requests[1].message.videoId, OTHER);
  page.respond(1, OTHER); await tick();
  assert.equal(page.widgets[1].result.key, "rainbow");
});

test("初期DOMが読込中でも、数字が届いた後に倍率を表示する", async () => {
  const page = fixture({ url: "https://www.youtube.com/watch?v=" + VIDEO });
  const { metadata } = page.addWatch(VIDEO, "読込中");
  await page.flush();
  assert.equal(page.widgets[0].data, null);
  const view = metadata.querySelector(".view-count"); view.textContent = "30万回視聴";
  page.mutation(view, "characterData"); await page.flush();
  assert.equal(page.widgets[0].data.ratio, 30);
  assert.equal(page.requests.length, 0);
});
