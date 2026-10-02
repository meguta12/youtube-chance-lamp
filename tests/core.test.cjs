/*
 * core.test.cjs — 倍率の境界と公開情報の取り違え防止を検証する。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");
const VIDEO = "dQw4w9WgXcQ";
const OTHER = "jNQXAC9IVRw";
const CHANNEL = "UC" + "a".repeat(22);

function watchHtml(options = {}) {
  const player = { videoDetails: { videoId: VIDEO, channelId: CHANNEL,
    viewCount: "123456", title: "動画", author: "投稿者", ...options.details } };
  const initial = { contents: { twoColumnWatchNextResults: { results: {
    results: { contents: [{ videoSecondaryInfoRenderer: { owner: {
      videoOwnerRenderer: { subscriberCountText: { simpleText: options.subscribers ?? "登録者数 1.2万人" } }
    } } }] }
  } } } };
  return "<script>var ytInitialPlayerResponse = " + JSON.stringify(player) + ";</script>" +
    "<script>window[\"ytInitialData\"] = " + JSON.stringify(initial) + ";</script>";
}

test("倍率は登録者比。緑だけ厳密に1倍を超え、赤・金・虹は境界を含む", () => {
  for (const [views, expected] of [[0, "none"], [99, "none"], [100, "none"], [101, "green"],
    [299, "green"], [300, "red"], [999, "red"], [1000, "gold"], [2999, "gold"], [3000, "rainbow"]]) {
    const result = Core.classify(views, 100);
    assert.equal(result.key, expected, "再生数 " + views);
    assert.equal(result.ratio, views / 100);
  }
});

test("カスタム倍率は保存された順序と境界を適用する", () => {
  const thresholds = { green: 2, red: 5, gold: 20, rainbow: 50 };
  for (const [views, expected] of [[200, "none"], [201, "green"], [500, "red"], [2000, "gold"], [5000, "rainbow"]]) {
    assert.equal(Core.classify(views, 100, thresholds).key, expected);
  }
  assert.equal(Core.classify(51, 100, { green: 0.5 }).key, "green");
});

test("登録者0・非公開・不正な再生数は通常や大当たりに変換しない", () => {
  for (const value of [0, null, undefined, -1, NaN, Infinity, "100", 1.5]) {
    assert.throws(() => Core.classify(100, value), /取得できません/);
  }
  for (const value of [-1, null, undefined, NaN, Infinity, "100", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => Core.classify(value, 100), /取得できません/);
  }
});

test("設定は既定値を壊さず、真偽値・音量・倍率だけを正規化する", () => {
  const configured = Core.settings({ volume: "70", muted: true, showCards: false, enabled: "false", unknown: "捨てる" });
  assert.equal(configured.volume, 70);
  assert.equal(configured.muted, true);
  assert.equal(configured.showCards, false);
  assert.equal(configured.enabled, true);
  assert.equal(configured.autoLight, false);
  assert.equal(Core.settings({ autoLight: true }).autoLight, true);
  assert.equal(configured.unknown, undefined);
  configured.thresholds.green = 0;
  assert.equal(Core.settings().thresholds.green, 1);
  assert.equal(Core.settings({ volume: 0 }).volume, 0);
  assert.equal(Core.settings({ volume: 100 }).volume, 100);
});

test("同値・逆順・非数・範囲外の倍率と音量はエラーにする", () => {
  for (const thresholds of [{ green: 3 }, { red: 1 }, { gold: 2 }, { rainbow: 10 },
    { green: -1 }, { gold: NaN }, { rainbow: Infinity }, { rainbow: 1000001 }]) {
    assert.throws(() => Core.settings({ thresholds }), /倍率/);
  }
  for (const volume of [-1, 101, NaN, Infinity, "音量"]) assert.throws(() => Core.settings({ volume }), /音量/);
});

test("日本語・英語・全角の公開件数を読み、丸め表示を概算として区別する", () => {
  const cases = [
    ["2,056,176 回視聴", 2056176, false], ["登録者数 177万人", 1770000, true],
    ["1.2億 回視聴", 120000000, true], ["登録者数 3千人", 3000, true],
    ["1.77M subscribers", 1770000, true], ["12.5K subscribers", 12500, true],
    ["2B views", 2000000000, true], ["１．５万人", 15000, true], ["0 subscribers", 0, false]
  ];
  for (const [text, value, approximate] of cases) assert.deepEqual(Core.parseCount(text), { value, approximate }, text);
});

test("非公開・空欄・負数・巨大値は人数として採用しない", () => {
  for (const value of ["", null, undefined, "非公開", "登録者数非表示", "Subscribers hidden",
    "No subscribers", "登録者なし", "-1 subscribers", "不明", "9007199254740992 subscribers"]) {
    assert.equal(Core.parseCount(value), null, String(value));
  }
});

test("通常watch URLと相対リンクから11文字の動画IDだけを採用する", () => {
  for (const url of ["https://www.youtube.com/watch?v=" + VIDEO, "/watch?v=" + VIDEO + "&t=12",
    "https://youtube.com/watch?v=" + VIDEO + "&list=PL123"]) assert.equal(Core.videoId(url), VIDEO);
  for (const url of ["https://evil.example/watch?v=" + VIDEO, "https://www.youtube.com.evil.example/watch?v=" + VIDEO,
    "https://www.youtube.com/shorts/" + VIDEO, "https://www.youtube.com/watch", "/watch?v=short",
    "/watch?v=" + VIDEO + "x", "/watch?v=abcdefghij!", "javascript:alert(1)", "%%%", "http://["]) {
    assert.equal(Core.videoId(url), null, url);
  }
});

test("埋め込みJSONの括弧・引用符・バックスラッシュを安全に読み取る", () => {
  const payload = { title: '括弧 } ] { [、引用符 "、バックスラッシュ \\', nested: [{ x: "終わり" }] };
  const html = "<script>var ytInitialData = " + JSON.stringify(payload) + ";window.unused=1;</script>";
  assert.deepEqual(Core.readInitial(html, "ytInitialData"), payload);
  assert.deepEqual(Core.readInitial('window["ytInitialData"] = ' + JSON.stringify(payload) + ";", "ytInitialData"), payload);
  assert.equal(Core.readInitial("var ytInitialData = {bad};", "ytInitialData"), null);
  assert.equal(Core.readInitial("var ytInitialData = {\"unterminated\":\"", "ytInitialData"), null);
  assert.equal(Core.readInitial("var otherData = {};", "ytInitialData"), null);
  assert.deepEqual(Core.readInitial("ytInitialData = {bad}; ytInitialData = {\"good\":true};", "ytInitialData"), { good: true });
});

test("解析はコードを実行せず、同じ動画の公開情報だけを返す", () => {
  globalThis.__chanceTestExecuted = false;
  const html = watchHtml({ details: { title: '引用符 " と } を含む動画' } }) +
    "<script>globalThis.__chanceTestExecuted = true;</script>";
  const result = Core.extractWatch(html, VIDEO);
  assert.equal(globalThis.__chanceTestExecuted, false);
  delete globalThis.__chanceTestExecuted;
  assert.equal(result.videoId, VIDEO);
  assert.equal(result.channelId, CHANNEL);
  assert.equal(result.views, 123456);
  assert.equal(result.subscribers, 12000);
  assert.equal(result.approximate, true);
  assert.equal(result.title, '引用符 " と } を含む動画');
});

test("SPA前の別動画ID・欠落player・不正なchannel IDを拒否する", () => {
  assert.throws(() => Core.extractWatch(watchHtml({ details: { videoId: OTHER } }), VIDEO), /この動画/);
  assert.throws(() => Core.extractWatch("<html>同意画面</html>", VIDEO), /この動画/);
  assert.throws(() => Core.extractWatch(watchHtml({ details: { channelId: "wrong" } }), VIDEO), /チャンネルID/);
  assert.throws(() => Core.extractWatch(watchHtml({ details: { viewCount: "NaN" } }), VIDEO), /再生数/);
});

test("空欄や欠落の再生数を0回へ変換せず、明示の0だけを許可する", () => {
  for (const viewCount of [null, undefined, "", " ", -1, "-1", Infinity]) {
    assert.throws(() => Core.extractWatch(watchHtml({ details: { viewCount } }), VIDEO), /再生数/, String(viewCount));
  }
  assert.equal(Core.extractWatch(watchHtml({ details: { viewCount: "0" } }), VIDEO).views, 0);
});

test("watchの非公開登録者数はnullを返し、別エリアの数値を流用しない", () => {
  const result = Core.extractWatch(watchHtml({ subscribers: "登録者数 非公開" }), VIDEO);
  assert.equal(result.subscribers, null);
  assert.equal(result.approximate, true);
});

test("現行pageHeaderViewModelと従来header双方で登録者数を読み取る", () => {
  const modern = { metadata: { channelMetadataRenderer: { externalId: CHANNEL } },
    header: { pageHeaderRenderer: { content: { pageHeaderViewModel: { metadata: {
      contentMetadataViewModel: { metadataRows: [{ metadataParts: [
        { text: { content: "@example" } }, { text: { content: "登録者数 1.77万人" } },
        { text: { content: "動画 999 本" } }
      ] }] }
    } } } } }, contents: { recommended: { subscriberCountText: { simpleText: "1000万人" } } } };
  assert.deepEqual(Core.extractChannel("var ytInitialData = " + JSON.stringify(modern) + ";", CHANNEL),
    { value: 17700, approximate: true });
  const legacy = { metadata: modern.metadata, header: { c4TabbedHeaderRenderer: {
    subscriberCountText: { runs: [{ text: "12,345" }, { text: " subscribers" }] }
  } } };
  assert.deepEqual(Core.extractChannel("var ytInitialData = " + JSON.stringify(legacy) + ";", CHANNEL),
    { value: 12345, approximate: false });
});

test("チャンネルIDが別なら登録者数を拒否し、0・非公開も判定しない", () => {
  function html(subscribers, channelId = CHANNEL) {
    return "var ytInitialData = " + JSON.stringify({ metadata: { channelMetadataRenderer: { externalId: channelId } },
      header: { c4TabbedHeaderRenderer: { subscriberCountText: { simpleText: subscribers } } } }) + ";";
  }
  assert.throws(() => Core.extractChannel(html("1000万人", "UC" + "b".repeat(22)), CHANNEL), /チャンネル/);
  for (const value of ["非公開", "0 subscribers", ""]) assert.throws(() => Core.extractChannel(html(value), CHANNEL), /判定できません/);
});
