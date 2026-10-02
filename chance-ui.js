/*
 * YouTubeの動画近くに置く、独立したランプ・物理レバー・倍率表示を作る。
 * Shadow DOMでページの見た目から分離し、確定データを受け取ってから点灯する。
 */
(function () {
  "use strict";

  const tierNames = { none: "今回は通常", green: "チャンス発見", red: "かなり熱い", gold: "大きなチャンス", rainbow: "特大チャンス" };
  const validTiers = new Set(Object.keys(tierNames));
  const formatCount = new Intl.NumberFormat("ja-JP");
  const formatRatio = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });

  function create(options) {
    const settings = options || {};
    const element = document.createElement("div");
    element.className = "chance-lamp-widget";
    element.setAttribute("data-chance-lamp", "");
    element.dataset.tier = "idle";
    if (settings.watchInline) element.setAttribute("data-watch-inline", "");
    if (settings.badge) element.setAttribute("data-badge", "");
    if (settings.watchInline || settings.badge) element.style.position = "absolute";
    const shadow = element.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = settings.styleUrl || new URL("../styles.css", document.baseURI).href;
    shadow.append(stylesheet);

    const container = document.createElement("section");
    container.className = "cabinet" + (settings.compact ? " compact" : "") +
      (settings.watchInline ? " watch-inline" : "") + (settings.badge ? " badge" : "");
    container.setAttribute("aria-label", "動画の伸びるチャンスを調べる");
    // 固定テンプレートだけをHTML化。動画・エラーなどの外部文字列はtextContentで入れる。
    container.innerHTML = `
      <header class="cabinet-header">
        <span class="brand"><span class="brand-mark" aria-hidden="true"></span>伸びる!? CHANCE</span>
        <button class="mute-button" type="button" aria-label="効果音を消す" title="効果音を消す"><span aria-hidden="true">♪</span><span class="mute-label">音あり</span></button>
      </header>
      <div class="machine">
        <div class="lamp-stage" aria-hidden="true">
          <div class="lamp-halo"></div>
          <div class="lamp-frame">
            <img class="lamp-art" alt="" draggable="false"><div class="lamp-color"></div><div class="lamp-shine"></div>
          </div>
          <div class="sparks"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <span class="lamp-caption">眠っているチャンスを、点灯。</span>
        </div>
        <div class="readout">
          <span class="result-label">レバーを引いて判定</span>
          <div class="ratio-line"><strong class="ratio-value">—</strong><span class="ratio-unit">倍</span></div>
          <span class="ratio-caption">再生数 ÷ 登録者数</span>
          <dl class="metrics"><div><dt>再生</dt><dd class="views-value">—</dd></div><div><dt>登録者</dt><dd class="subscribers-value">—</dd></div></dl>
        </div>
        <button class="lever-button" type="button" aria-label="レバーを引いてチャンスを判定">
          <span class="lever-assembly" aria-hidden="true"><span class="lever-socket"></span><span class="lever-shaft"></span><span class="lever-knob"></span><span class="lever-direction">↓</span></span>
          <span class="lever-label">引く</span>
        </button>
      </div>
      <footer class="cabinet-footer"><span class="status-dot" aria-hidden="true"></span><span class="status" role="status" aria-live="polite">レバーを引くと、倍率に応じた色が点灯します</span></footer>`;
    shadow.append(container);
    container.querySelector(".lamp-art").src = new URL("assets/nobiru-chance.png", stylesheet.href).href;

    const query = function (selector) { return container.querySelector(selector); };
    const lever = query(".lever-button");
    if (settings.badge) lever.setAttribute("aria-label", "この動画のチャンスを判定");
    const mute = query(".mute-button");
    const status = query(".status");
    const resultLabel = query(".result-label");
    const ratioValue = query(".ratio-value");
    const audio = globalThis.ChanceLampAudio ? globalThis.ChanceLampAudio.create() : null;
    const motionQuery = globalThis.matchMedia ? globalThis.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let preferences = {
      volume: Number.isFinite(Number(settings.volume)) ? Math.max(0, Math.min(100, Number(settings.volume))) : 35,
      muted: Boolean(settings.muted),
      reducedMotion: Boolean(settings.reducedMotion || (motionQuery && motionQuery.matches))
    };
    let busy = false;
    let destroyed = false;
    let data = null;
    let timer = null;
    let leverTimer = null;
    let pullToken = 0;

    function clearAnimation() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      container.classList.remove("is-revealing");
    }

    function clearLeverAnimation() {
      if (leverTimer !== null) clearTimeout(leverTimer);
      leverTimer = null;
      container.classList.remove("is-pulling");
      lever.disabled = busy;
    }

    function setMessage(text, isError) {
      if (destroyed) return;
      status.textContent = String(text || "");
      container.classList.toggle("has-error", Boolean(isError));
      if (settings.watchInline || settings.badge) lever.title = String(text || "");
    }

    function updateMute() {
      mute.setAttribute("aria-pressed", String(preferences.muted));
      mute.setAttribute("aria-label", preferences.muted ? "効果音をつける" : "効果音を消す");
      mute.title = preferences.muted ? "効果音をつける" : "効果音を消す";
      query(".mute-label").textContent = preferences.muted ? "無音" : "音あり";
      container.classList.toggle("is-muted", preferences.muted);
      container.classList.toggle("reduced-motion", preferences.reducedMotion);
    }

    function setBusy(value) {
      if (destroyed) return;
      busy = Boolean(value);
      lever.disabled = busy || leverTimer !== null;
      container.classList.toggle("is-busy", busy);
      container.setAttribute("aria-busy", String(busy));
      query(".lever-label").textContent = busy ? "判定中" : "引く";
      if (busy) {
        clearAnimation();
        if (!preferences.reducedMotion && leverTimer === null) {
          container.classList.add("is-pulling");
          leverTimer = setTimeout(function () { clearLeverAnimation(); }, 480);
        }
        element.dataset.tier = "idle";
        container.dataset.tier = "idle";
        resultLabel.textContent = "チャンスを判定中…";
        setMessage("登録者数と再生数を確認しています");
      }
    }

    function setData(nextData) {
      if (destroyed) return;
      data = nextData || null;
      const count = function (value) { return Number.isFinite(Number(value)) && Number(value) >= 0 ? formatCount.format(Number(value)) : "—"; };
      query(".views-value").textContent = data ? count(data.views) : "—";
      query(".subscribers-value").textContent = data ? count(data.subscribers) : "—";
      const ratio = data && Number(data.ratio);
      ratioValue.textContent = Number.isFinite(ratio) && ratio >= 0 ? formatRatio.format(ratio) : "—";
      container.style.setProperty("--ratio-chars", String(Math.max(3, ratioValue.textContent.length)));
      query(".ratio-caption").textContent = data && data.approximate ? "再生数 ÷ 登録者数（概算）" : "再生数 ÷ 登録者数";
      if (data && data.title) container.title = String(data.title) + "\n再生 " + count(data.views) +
        "／登録者 " + count(data.subscribers) + (data.approximate ? "（概算）" : "");
    }

    function reveal(result, revealOptions) {
      if (destroyed) return;
      const key = result && validTiers.has(result.key) ? result.key : "none";
      clearAnimation();
      setBusy(false);
      element.dataset.tier = key;
      container.dataset.tier = key;
      resultLabel.textContent = result && result.label ? String(result.label) : tierNames[key];
      const ratio = result && Number(result.ratio);
      if (Number.isFinite(ratio) && ratio >= 0) ratioValue.textContent = formatRatio.format(ratio);
      const ratioText = ratioValue.textContent === "—" ? "" : "再生数は登録者数の" + ratioValue.textContent + "倍。";
      setMessage(key === "none" ? "今回は通常。別の動画でもレバーを引いてみよう" : ratioText + tierNames[key] + "！");
      const silent = Boolean(revealOptions && revealOptions.silent);
      if (!silent && !preferences.reducedMotion && key !== "none") {
        // 直前と同じ色でもアニメーションをもう一度再生する。
        void container.offsetWidth;
        container.classList.add("is-revealing");
        timer = setTimeout(function () { clearAnimation(); }, key === "rainbow" ? 1900 : 1400);
      }
      if (audio && !silent) {
        const token = pullToken;
        try {
          Promise.resolve(audio.burst(key, preferences.volume, preferences.muted)).catch(error => {
            if (!destroyed && token === pullToken) setMessage("判定できました。効果音を再生できません: " + error.message, true);
          });
        }
        catch (error) { setMessage("判定できました。効果音の再生に失敗しました", true); }
      }
    }

    function reset() {
      if (destroyed) return;
      pullToken += 1;
      clearAnimation();
      clearLeverAnimation();
      if (audio) audio.stop();
      setBusy(false);
      element.dataset.tier = "idle";
      container.dataset.tier = "idle";
      resultLabel.textContent = "レバーを引いて判定";
      setMessage("レバーを引くと、倍率に応じた色が点灯します");
    }

    const widget = {
      element,
      setData,
      setMessage,
      setBusy,
      reveal,
      reset,
      setPreferences: function (next) {
        if (destroyed) return;
        if (next && typeof next.muted === "boolean") preferences.muted = next.muted;
        if (next && Number.isFinite(Number(next.volume))) preferences.volume = Math.max(0, Math.min(100, Number(next.volume)));
        if (next && typeof next.reducedMotion === "boolean") preferences.reducedMotion = next.reducedMotion;
        if (audio && (preferences.muted || preferences.volume === 0)) audio.stop();
        if (preferences.reducedMotion) {
          clearAnimation();
          clearLeverAnimation();
        }
        updateMute();
      },
      destroy: function () {
        if (destroyed) return;
        reset();
        destroyed = true;
        if (audio) audio.destroy();
        if (motionQuery) motionQuery.removeEventListener("change", onMotionChange);
        element.remove();
      }
    };

    function onMotionChange(event) {
      widget.setPreferences({ reducedMotion: event.matches });
    }

    lever.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (busy || destroyed) return;
      const token = ++pullToken;
      if (audio) {
        audio.stop();
        // resumeをクリックと同じイベント内で始め、取得処理は音声の解除を待たない。
        audio.unlock().then(function () {
          if (!destroyed && token === pullToken) audio.lever(preferences.volume, preferences.muted);
        }).catch(function () {
          if (!destroyed && token === pullToken) setMessage("効果音を再生できません。判定は続けています", true);
        });
      }
      setBusy(true);
      try {
        const work = typeof settings.onPull === "function" ? settings.onPull(widget) : Promise.reject(new Error("判定処理が接続されていません"));
        Promise.resolve(work).catch(function (error) {
          if (destroyed || token !== pullToken) return;
          setBusy(false);
          resultLabel.textContent = "もう一度試す";
          setMessage(error && error.message ? error.message : "判定できませんでした。もう一度引いてください", true);
        });
      } catch (error) {
        setBusy(false);
        resultLabel.textContent = "もう一度試す";
        setMessage(error && error.message ? error.message : "判定できませんでした", true);
      }
    });

    mute.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      widget.setPreferences({ muted: !preferences.muted });
      if (typeof settings.onMute === "function") settings.onMute(preferences.muted);
    });
    if (motionQuery) motionQuery.addEventListener("change", onMotionChange);
    updateMute();
    return widget;
  }

  globalThis.ChanceLampUI = Object.freeze({ create });
}());
