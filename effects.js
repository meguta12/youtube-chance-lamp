/*
 * 指定された同梱音源を色ごとに再生し、レバー・通常音をWeb Audioで合成する。
 * クリック後にだけ音源を起動し、音量・停止・遅延読み込みを共通で管理する。
 */
(function () {
  "use strict";

  let sharedContext = null;
  let sharedOutput = null;
  let players = 0;
  const decodedSounds = new Map();
  const files = Object.freeze({
    green: "sounds/green.wav",
    red: "sounds/red.mp3",
    gold: "sounds/gold.mp3",
    rainbow: "sounds/rainbow.wav"
  });
  const names = Object.freeze({ green: "緑", red: "赤", gold: "金", rainbow: "虹" });
  const scriptUrl = globalThis.document && document.currentScript ? document.currentScript.src : "";

  function assetUrl(file) {
    if (globalThis.chrome && chrome.runtime && typeof chrome.runtime.getURL === "function") {
      return chrome.runtime.getURL(file);
    }
    if (!scriptUrl) throw new Error("効果音の読み込み元が見つかりません。");
    return new URL(file, scriptUrl).href;
  }

  function loadSound(key) {
    const url = assetUrl(files[key]);
    if (decodedSounds.has(url)) return decodedSounds.get(url);
    const decoder = context();
    const pending = fetch(url, { credentials: "omit" }).then(function (response) {
      if (!response.ok) throw new Error("音源の取得に失敗しました（" + response.status + "）");
      return response.arrayBuffer();
    }).then(function (bytes) {
      return decoder.decodeAudioData(bytes);
    }).then(function (buffer) {
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
      }
      if (peak === 0) throw new Error("音源に音声が含まれていません");
      // 元ファイルは変更しない。書き出し済みの緑の二重減衰を補い、告知音の振幅をそろえる。
      return { buffer, gain: Math.min(10, 1.35 / peak) };
    }).catch(function (error) {
      if (decodedSounds.get(url) === pending) decodedSounds.delete(url);
      throw new Error(names[key] + "の効果音を読み込めませんでした：" + (error && error.message ? error.message : "形式を確認してください"));
    });
    decodedSounds.set(url, pending);
    return pending;
  }

  function context() {
    if (sharedContext && sharedContext.state !== "closed") return sharedContext;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error("このブラウザでは効果音を再生できません。");
    sharedContext = new AudioContextClass();
    sharedOutput = sharedContext.createDynamicsCompressor();
    sharedOutput.threshold.value = -14;
    sharedOutput.knee.value = 12;
    sharedOutput.ratio.value = 12;
    sharedOutput.attack.value = 0.004;
    sharedOutput.release.value = 0.18;
    sharedOutput.connect(sharedContext.destination);
    return sharedContext;
  }

  function create() {
    players += 1;
    let audioContext = null;
    let master = null;
    let destroyed = false;
    let generation = 0;
    const active = new Set();
    const percussionBuffers = new Map();

    function prepare(volume, muted) {
      if (destroyed || muted || Number(volume) === 0) return null;
      audioContext = context();
      if (!master) {
        master = audioContext.createGain();
        master.connect(sharedOutput);
      }
      const value = Number.isFinite(Number(volume)) ? Number(volume) : 35;
      master.gain.setValueAtTime(Math.max(0, Math.min(100, value)) / 100 * 0.3, audioContext.currentTime);
      return audioContext.currentTime + 0.006;
    }

    function track(source, nodes) {
      const voice = { source, nodes };
      active.add(voice);
      source.addEventListener("ended", function () {
        active.delete(voice);
        source.disconnect();
        nodes.forEach(function (node) { node.disconnect(); });
      }, { once: true });
    }

    function tone(time, frequency, duration, amplitude, type, target) {
      const source = audioContext.createOscillator();
      const envelope = audioContext.createGain();
      source.type = type || "sine";
      source.frequency.setValueAtTime(frequency, time);
      if (target) source.frequency.exponentialRampToValueAtTime(target, time + duration);
      envelope.gain.setValueAtTime(0.0001, time);
      envelope.gain.exponentialRampToValueAtTime(amplitude, time + 0.007);
      envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      source.connect(envelope);
      envelope.connect(master);
      track(source, [envelope]);
      source.start(time);
      source.stop(time + duration + 0.01);
    }

    function noise(time, duration, amplitude, frequency) {
      const source = audioContext.createBufferSource();
      const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * duration), audioContext.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
      source.buffer = buffer;
      const filter = audioContext.createBiquadFilter();
      const envelope = audioContext.createGain();
      filter.type = "bandpass";
      filter.frequency.value = frequency;
      filter.Q.value = 0.8;
      envelope.gain.setValueAtTime(amplitude, time);
      envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      source.connect(filter);
      filter.connect(envelope);
      envelope.connect(master);
      track(source, [filter, envelope]);
      source.start(time);
      source.stop(time + duration + 0.01);
    }

    function strike(time, kind, amplitude, rate) {
      let buffer = percussionBuffers.get(kind);
      if (!buffer) {
        const leverHit = kind === "lever";
        const metalHit = kind === "metal";
        const duration = leverHit ? 0.19 : metalHit ? 0.58 : 0.27;
        buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * duration), audioContext.sampleRate);
        const samples = buffer.getChannelData(0);
        let previousNoise = 0;
        let seed = 0x4b1d;
        for (let index = 0; index < samples.length; index += 1) {
          const elapsed = index / audioContext.sampleRate;
          // 同じ打撃を再現できる固定シードのノイズ。実機の録音・旋律は使わない。
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          const random = (seed >>> 0) / 2147483648 - 1;
          const dryNoise = random - previousNoise * 0.76;
          previousNoise = random;
          const front = dryNoise * Math.exp(-elapsed / (leverHit ? 0.013 : 0.018)) * 0.88;
          const bodyPhase = 2 * Math.PI * (leverHit ? 73 : 91) * elapsed + 1.6 * (1 - Math.exp(-elapsed * 55));
          const body = Math.sin(bodyPhase) * Math.exp(-elapsed / 0.047) * 0.76;
          const knockTime = elapsed - (leverHit ? 0.046 : 0.033);
          let knock = 0;
          if (knockTime >= 0) {
            const ring = Math.sin(2 * Math.PI * 428 * knockTime)
              + Math.sin(2 * Math.PI * 731 * knockTime) * 0.72
              + Math.sin(2 * Math.PI * 1283 * knockTime) * 0.38;
            knock = (dryNoise * 0.63 + ring * 0.3) * Math.exp(-knockTime / (leverHit ? 0.017 : 0.028));
          }
          let clang = 0;
          if (metalHit) {
            const ring = Math.sin(2 * Math.PI * 617 * elapsed)
              + Math.sin(2 * Math.PI * 1121 * elapsed) * 0.6
              + Math.sin(2 * Math.PI * 1813 * elapsed) * 0.42
              + Math.sin(2 * Math.PI * 2711 * elapsed) * 0.22;
            clang = ring * Math.exp(-elapsed / 0.12) * 0.25;
          }
          // 打撃の歪みは波形内で抑える。各色共通のマスター上限は変更しない。
          samples[index] = Math.tanh((front + body + knock + clang) * 1.7) * 0.94;
        }
        percussionBuffers.set(kind, buffer);
      }
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      const playbackRate = rate || 1;
      source.playbackRate.setValueAtTime(playbackRate, time);
      gain.gain.setValueAtTime(amplitude, time);
      source.connect(gain);
      gain.connect(master);
      track(source, [gain]);
      source.start(time);
      source.stop(time + buffer.duration / playbackRate + 0.01);
    }

    function lever(volume, muted) {
      const time = prepare(volume, muted);
      if (time === null) return;
      strike(time, "lever", 0.85);
      tone(time, 116, 0.15, 0.3, "triangle", 43);
      noise(time + 0.095, 0.065, 0.36, 2100);
    }

    async function burst(key, volume, muted) {
      if (destroyed || muted || Number(volume) === 0) return;
      if (key === "none") {
        const time = prepare(volume, muted);
        if (time !== null) strike(time, "lever", 0.35, 1.3);
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(files, key)) throw new Error("指定された色の効果音がありません。");
      const token = generation;
      let sound;
      try {
        sound = await loadSound(key);
      } catch (error) {
        // 停止・破棄された古い操作の失敗は、現在の操作へ表示しない。
        if (destroyed || token !== generation) return;
        throw error;
      }
      if (destroyed || token !== generation) return;
      const time = prepare(volume, muted);
      if (time === null) return;
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      source.buffer = sound.buffer;
      gain.gain.setValueAtTime(sound.gain, time);
      source.connect(gain);
      gain.connect(master);
      track(source, [gain]);
      source.start(time);
      source.stop(time + sound.buffer.duration + 0.01);
    }

    function stop() {
      generation += 1;
      active.forEach(function (voice) {
        // 完了直前の音源にもstopは呼べる。終了イベントで接続を解除する。
        voice.source.stop();
      });
      active.clear();
    }

    return {
      unlock: async function () {
        if (destroyed) return;
        audioContext = context();
        if (audioContext.state === "suspended") await audioContext.resume();
      },
      lever,
      burst,
      stop,
      destroy: function () {
        if (destroyed) return;
        stop();
        destroyed = true;
        if (master) master.disconnect();
        players -= 1;
        if (players === 0 && sharedContext) {
          const retired = sharedContext;
          sharedContext = null;
          sharedOutput = null;
          retired.close().catch(function () { /* ページ終了時のclose競合には追加処理不要。 */ });
        }
      }
    };
  }

  globalThis.ChanceLampAudio = Object.freeze({ create, files });
}());
