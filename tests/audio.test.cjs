/*
 * audio.test.cjs — 色別音源、音量補正、非同期読み込みと停止の競合を検証する。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../effects.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const mapping = { green: "sounds/green.wav", red: "sounds/red.mp3", gold: "sounds/gold.mp3", rainbow: "sounds/rainbow.wav" };
const markers = { "green.wav": 1, "red.mp3": 2, "gold.mp3": 3, "rainbow.wav": 4 };
const peaks = { 1: 0.2463, 2: 0.989, 3: 0.9598, 4: 0.8463 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function buffer(marker) {
  return { marker, duration: 1, numberOfChannels: 1,
    getChannelData() { return Float32Array.from([0, peaks[marker] || 0.5, 0]); } };
}

function createAudio(options = {}) {
  const calls = [], contexts = [];
  class Param {
    constructor() { this.value = 0; this.values = []; }
    setValueAtTime(value) { this.value = value; this.values.push(value); }
    exponentialRampToValueAtTime(value) { this.value = value; this.values.push(value); }
  }
  class Node {
    constructor(type) {
      this.type = type; this.connections = []; this.listeners = new Map();
      this.gain = new Param(); this.frequency = new Param(); this.Q = new Param(); this.playbackRate = new Param();
      this.started = false; this.stopped = false;
    }
    connect(node) { this.connections.push(node); }
    disconnect() { this.disconnected = true; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    start(time) { this.started = true; this.startTime = time; }
    stop(time) {
      if (time !== undefined) { this.endTime = time; return; }
      this.stopped = true;
      const listener = this.listeners.get("ended");
      if (listener) { this.listeners.delete("ended"); listener(); }
    }
  }
  class AudioContext {
    constructor() {
      this.state = "suspended"; this.currentTime = 0; this.sampleRate = 44100;
      this.destination = new Node("destination"); this.nodes = []; this.decodeCalls = [];
      contexts.push(this);
    }
    node(type) { const node = new Node(type); this.nodes.push(node); return node; }
    createGain() { return this.node("gain"); }
    createBufferSource() { return this.node("bufferSource"); }
    createOscillator() { return this.node("oscillator"); }
    createBiquadFilter() { return this.node("filter"); }
    createBuffer(channels, length, rate) { return { duration: length / rate, getChannelData() { return new Float32Array(length); } }; }
    createDynamicsCompressor() {
      const node = this.node("compressor");
      for (const key of ["threshold", "knee", "ratio", "attack", "release"]) node[key] = new Param();
      return node;
    }
    decodeAudioData(bytes) {
      const marker = new Uint8Array(bytes)[0]; this.decodeCalls.push(marker);
      return options.decode ? options.decode(marker, this.decodeCalls.length) : Promise.resolve(buffer(marker));
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  const sandbox = { AudioContext, URL,
    document: { currentScript: { src: options.scriptUrl || "http://127.0.0.1:60472/effects.js" }, baseURI: "http://127.0.0.1:60472/preview/index.html" },
    async fetch(url, request) {
      calls.push({ url, request });
      if (options.fetch) return options.fetch(url, request, calls.length);
      const marker = markers[url.split("/").pop()];
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.of(marker).buffer };
    }
  };
  if (options.extension !== false) sandbox.chrome = { runtime: { getURL(file) { return "chrome-extension://chance-test/" + file; } } };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "effects.js" });
  return { api: context.ChanceLampAudio, calls, contexts,
    sources() { return contexts.flatMap(context => context.nodes.filter(node => node.started)); } };
}

test("4色の同梱音源は指定された原本と同じハッシュで、緑は旧赤2段キュイン", () => {
  const expected = {
    green: "6c7d2e69087f2d8a57e323f316b49d0c90e9e4997e8b482740355e7a7c76a62d",
    red: "4121231a84865b231821d993fb82c71a3e01dadf4139abf1cefdb65f587dd610",
    gold: "66e70e1fea75bf153892a3db07a2bc7bf31ab60e5f16ec95b2a13916db7dddb5",
    rainbow: "7ca090a3e677541620b49f83abbc340980fc713d5ba2ec593162605b57833001"
  };
  for (const key of Object.keys(mapping)) {
    const bytes = fs.readFileSync(path.join(__dirname, "..", mapping[key]));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expected[key]);
    assert.deepEqual(bytes, fs.readFileSync(path.join(__dirname, "../preview", mapping[key])));
  }
  assert.notEqual(expected.red, expected.gold);
});

test("拡張URLの4色mappingは実際にそれぞれ異なる音源を再生する", async () => {
  const audio = createAudio();
  assert(Object.isFrozen(audio.api.files));
  assert.deepEqual({ ...audio.api.files }, mapping);
  const player = audio.api.create(); await player.unlock();
  for (const key of Object.keys(mapping)) await player.burst(key, 35, false);
  assert.deepEqual(audio.calls.map(call => call.url), Object.values(mapping).map(file => "chrome-extension://chance-test/" + file));
  assert(audio.calls.every(call => call.request.credentials === "omit"));
  assert.deepEqual(audio.sources().map(node => node.buffer.marker), [1, 2, 3, 4]);
  player.destroy();
});

test("previewの音源URLはpreview/index.htmlではなくeffects.jsの場所を基準にする", async () => {
  const audio = createAudio({ extension: false, scriptUrl: "http://localhost:9000/app/effects.js?v=2" });
  const player = audio.api.create(); await player.burst("red", 35, false);
  assert.equal(audio.calls[0].url, "http://localhost:9000/app/sounds/red.mp3");
  player.destroy();
});

test("mutedと音量0ではfetchも音源予約も開始しない", async () => {
  const audio = createAudio(), player = audio.api.create();
  await player.burst("rainbow", 100, true); await player.burst("green", 0, false); player.lever(0, false);
  assert.equal(audio.calls.length, 0); assert.equal(audio.contexts.length, 0); assert.equal(audio.sources().length, 0);
  player.destroy();
});

test("音量補正で緑の二重減衰を防ぎ、共通masterは0.3以内とcompressorを維持する", async () => {
  const audio = createAudio(), player = audio.api.create(); await player.unlock();
  for (const key of Object.keys(mapping)) await player.burst(key, 999, false);
  const context = audio.contexts[0], compressor = context.nodes.find(node => node.type === "compressor");
  const master = context.nodes.find(node => node.type === "gain" && node.connections.includes(compressor));
  assert.equal(compressor.ratio.value, 12); assert(master.gain.values.every(value => value <= 0.3));
  const normalized = audio.sources().map(node => node.connections[0].gain.value * peaks[node.buffer.marker]);
  assert(normalized.every(value => Math.abs(value - normalized[0]) < 0.000001));
  assert(audio.sources()[0].connections[0].gain.value > 4);
  player.stop(); assert(audio.sources().every(node => node.stopped && node.disconnected)); player.destroy();
});

test("stopまたはdestroyの後にdecodeが完了しても古い音は鳴らない", async () => {
  for (const action of ["stop", "destroy"]) {
    const gate = deferred(), audio = createAudio({ decode: () => gate.promise }), player = audio.api.create();
    const pending = player.burst("green", 35, false); await tick();
    assert.equal(audio.contexts[0].decodeCalls.length, 1); player[action](); gate.resolve(buffer(1)); await pending;
    assert.equal(audio.sources().length, 0);
    if (action === "stop") {
      await player.burst("green", 35, false); assert.equal(audio.sources().length, 1); assert.equal(audio.calls.length, 1);
      player.destroy();
    }
    assert.equal(audio.contexts[0].state, "closed");
  }
});

test("同じ音源の同時読み込みはfetchとdecodeを共有し、停止は自分の音だけに効く", async () => {
  const audio = createAudio(), first = audio.api.create(), second = audio.api.create();
  await Promise.all([first.burst("gold", 35, false), second.burst("gold", 35, false)]);
  assert.equal(audio.calls.length, 1); assert.equal(audio.contexts[0].decodeCalls.length, 1); assert.equal(audio.sources().length, 2);
  first.stop(); assert.equal(audio.sources()[0].stopped, true); assert.equal(audio.sources()[1].stopped, false);
  first.destroy(); assert.notEqual(audio.contexts[0].state, "closed"); second.destroy(); assert.equal(audio.contexts[0].state, "closed");
});

test("取得とdecodeの失敗はPromiseで伝わり、失敗キャッシュは次の試行を妨げない", async () => {
  const http = createAudio({ fetch: async (url, request, count) => count === 1 ? { ok: false, status: 404 }
    : { ok: true, status: 200, arrayBuffer: async () => Uint8Array.of(2).buffer } });
  const first = http.api.create(); await assert.rejects(first.burst("red", 35, false), /赤.*404/);
  await first.burst("red", 35, false); assert.equal(http.sources().length, 1); first.destroy();
  const decode = createAudio({ decode: (marker, count) => count === 1 ? Promise.reject(new Error("壊れたデータ")) : Promise.resolve(buffer(marker)) });
  const second = decode.api.create(); await assert.rejects(second.burst("rainbow", 35, false), /虹.*壊れたデータ/);
  await second.burst("rainbow", 35, false); assert.equal(decode.sources().length, 1);
  await assert.rejects(second.burst("missing", 35, false), /指定された色/); second.destroy();
});
