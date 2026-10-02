/* ブラウザ配置試験だけに使うChrome APIと公開データの代役。外部通信しない。 */
(function () {
  "use strict";
  const real = globalThis.ChanceLampCore;
  const base = new URL("../", document.currentScript.src);
  const listeners = [];
  let settings = real.settings({ autoLight: true });
  globalThis.ChanceLampCore = Object.assign({}, real, { videoId: url => {
    if (String(url).startsWith(base.origin + "/tests/browser-layout.html")) return "MFwtpM21wWc";
    return real.videoId(url);
  } });
  globalThis.chrome = { runtime: { id: "fixture", getURL: path => new URL(path, base).href,
    sendMessage: async message => ({ ok: true, data: { videoId: message.videoId,
      views: message.videoId === "jNQXAC9IVRw" ? 5000 : message.videoId === "MFwtpM21wWc" ? 14099931 : 300000,
      subscribers: message.videoId === "MFwtpM21wWc" ? 51900 : 10000, title: "配置試験", approximate: true } }) },
    storage: { local: { get: async () => ({ chanceLampSettings: settings }), set: async next => {
      settings = next.chanceLampSettings;
      listeners.forEach(listener => listener({ chanceLampSettings: { newValue: settings } }, "local"));
    } }, onChanged: { addListener: listener => listeners.push(listener) } } };
  document.getElementById("automatic").addEventListener("change", event => {
    settings = real.settings(Object.assign({}, settings, { autoLight: event.target.checked }));
    listeners.forEach(listener => listener({ chanceLampSettings: { newValue: settings } }, "local"));
  });
  document.getElementById("visibleCards").addEventListener("change", event => {
    settings = real.settings(Object.assign({}, settings, { showCards: event.target.checked }));
    listeners.forEach(listener => listener({ chanceLampSettings: { newValue: settings } }, "local"));
  });
})();
