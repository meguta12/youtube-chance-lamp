/*
 * popup.js — 閾値と音量を保存し、同じランプ部品で4色の告知を体験する。
 */
(function () {
  "use strict";
  const Core = globalThis.ChanceLampCore;
  const extension = typeof chrome !== "undefined" && chrome.storage && chrome.runtime && chrome.runtime.id;
  const status = document.getElementById("status");
  if (!extension) {
    document.querySelector("#settings .save").textContent = "体験画面の設定を保存";
    document.querySelector("footer").textContent = "このページは試聴用です。YouTube上の設定はChromeの拡張アイコンから保存してください。";
  }
  const controls = ["enabled", "showCards", "autoLight", "muted", "reducedMotion", "volume", "green", "red", "gold", "rainbow"];
  let selected = "rainbow";
  let saved = Core.settings();
  let demo;

  function message(text, error) {
    status.textContent = text;
    status.dataset.error = String(Boolean(error));
  }

  function readForm() {
    const values = { thresholds: {} };
    controls.forEach(key => {
      const input = document.getElementById(key);
      if (["enabled", "showCards", "autoLight", "muted", "reducedMotion"].includes(key)) values[key] = input.checked;
      else if (key === "volume") values.volume = Number(input.value);
      else values.thresholds[key] = Number(input.value);
    });
    return Core.settings(values);
  }

  function populate(value) {
    controls.forEach(key => {
      const input = document.getElementById(key);
      if (input.type === "checkbox") input.checked = value[key];
      else input.value = key === "volume" ? value.volume : value.thresholds[key];
    });
    document.getElementById("volume-value").textContent = value.volume + "%";
    if (demo) demo.setPreferences(value);
  }

  function demoData() {
    const limits = saved.thresholds;
    let ratio;
    if (selected === "none") ratio = limits.green * 0.6;
    else if (selected === "rainbow") ratio = Math.max(limits.rainbow * 1.4, limits.rainbow + 0.1);
    else {
      const index = Core.TIERS.findIndex(tier => tier.key === selected);
      ratio = (limits[selected] + limits[Core.TIERS[index + 1].key]) / 2;
    }
    const subscribers = 1000000;
    const views = Math.round(ratio * subscribers);
    return { videoId: "demo", views: views, subscribers: subscribers, ratio: views / subscribers,
      approximate: false, title: "演出体験用のサンプル", channelTitle: "デモ" };
  }

  function refreshDemo() {
    demo.reset();
    const data = demoData();
    demo.setData(data);
    if (document.getElementById("autoLight").checked) demo.reveal(Core.classify(data.views, data.subscribers, saved.thresholds), { silent: true });
  }

  demo = globalThis.ChanceLampUI.create({ compact: false, styleUrl: extension ? chrome.runtime.getURL("styles.css") : "../styles.css",
    volume: saved.volume, muted: saved.muted, reducedMotion: saved.reducedMotion,
    onMute: muted => { document.getElementById("muted").checked = muted; },
    onPull: async () => {
      demo.setBusy(true);
      const data = demoData();
      demo.setData(data);
      demo.reveal(Core.classify(data.views, data.subscribers, saved.thresholds));
      demo.setBusy(false);
    } });
  document.getElementById("demo").append(demo.element);
  demo.setData(demoData());

  document.querySelectorAll("[data-demo]").forEach(button => button.addEventListener("click", () => {
    selected = button.dataset.demo;
    document.querySelectorAll("[data-demo]").forEach(option => option.setAttribute("aria-pressed", String(option === button)));
    refreshDemo();
  }));
  document.getElementById("volume").addEventListener("input", event => {
    document.getElementById("volume-value").textContent = event.target.value + "%";
    demo.setPreferences({ volume: Number(event.target.value), muted: document.getElementById("muted").checked,
      reducedMotion: document.getElementById("reducedMotion").checked });
  });
  ["muted", "reducedMotion"].forEach(key => document.getElementById(key).addEventListener("change", () => {
    demo.setPreferences({ volume: Number(document.getElementById("volume").value),
      muted: document.getElementById("muted").checked, reducedMotion: document.getElementById("reducedMotion").checked });
  }));
  document.getElementById("autoLight").addEventListener("change", refreshDemo);

  async function persist(value) {
    if (extension) await chrome.storage.local.set({ chanceLampSettings: value });
    else localStorage.setItem("chanceLampPreviewSettings", JSON.stringify(value));
    saved = value;
    populate(value);
    refreshDemo();
  }

  document.getElementById("settings").addEventListener("submit", async event => {
    event.preventDefault();
    try { await persist(readForm()); message(extension ? "保存しました。開いているYouTubeにも反映されます。" : "体験画面の設定を保存しました。", false); }
    catch (error) { message(error.message || "設定を保存できませんでした。", true); }
  });
  document.getElementById("reset").addEventListener("click", async () => {
    try { await persist(Core.settings()); message("初期値に戻しました。", false); }
    catch (error) { message(error.message || "設定を戻せませんでした。", true); }
  });

  (async () => {
    try {
      const stored = extension ? (await chrome.storage.local.get("chanceLampSettings")).chanceLampSettings : JSON.parse(localStorage.getItem("chanceLampPreviewSettings") || "null");
      saved = Core.settings(stored);
      populate(saved);
      refreshDemo();
    } catch (error) { populate(saved); message("保存済み設定を読み込めません。初期値を表示しています。", true); }
  })();
  window.addEventListener("pagehide", () => demo.destroy());
})();
