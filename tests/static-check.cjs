/*
 * static-check.cjs — MV3構成・JS構文・権限・制御文字の納品前検査。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const errors = [];
const checks = [];
const audioFiles = { green: "sounds/green.wav", red: "sounds/red.mp3", gold: "sounds/gold.mp3", rainbow: "sounds/rainbow.wav" };
const logoFile = "assets/nobiru-chance.png";

function check(label, run) {
  try { run(); checks.push(label); }
  catch (error) { errors.push(label + ": " + error.message); }
}

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

let manifest;
check("manifest JSON / MV3", () => {
  manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
});

check("最小権限", () => {
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*"]);
  assert.ok(!manifest.optional_permissions || manifest.optional_permissions.length === 0);
  assert.ok(!manifest.optional_host_permissions || manifest.optional_host_permissions.length === 0);
  assert.equal(manifest.externally_connectable, undefined);
  for (const script of manifest.content_scripts) assert.deepEqual(script.matches, ["https://www.youtube.com/*"]);
  for (const resource of manifest.web_accessible_resources || []) assert.deepEqual(resource.matches, ["https://www.youtube.com/*"]);
});

check("manifest参照ファイル / アイコン4サイズ", () => {
  const references = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const script of manifest.content_scripts) references.push(...script.js, ...(script.css || []));
  for (const resources of manifest.web_accessible_resources || []) references.push(...resources.resources);
  for (const reference of references) {
    assert.ok(reference && !reference.includes("*"), "未解決参照 " + reference);
    const file = path.resolve(root, reference);
    assert.ok(!path.relative(root, file).startsWith(".."), "フォルダ外参照 " + reference);
    assert.ok(fs.statSync(file).isFile(), "ファイルでない " + reference);
  }
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.icons[String(size)], "icons/icon" + size + ".png");
    assert.equal(manifest.action.default_icon[String(size)], manifest.icons[String(size)]);
    const image = fs.readFileSync(path.join(root, manifest.icons[String(size)]));
    assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }
});

check("公開アセットの最小範囲", () => {
  assert.equal(manifest.web_accessible_resources.length, 1);
  assert.deepEqual([...manifest.web_accessible_resources[0].resources].sort(),
    ["styles.css", logoFile, ...Object.values(audioFiles)].sort());
  assert.equal(manifest.content_security_policy && manifest.content_security_policy.sandbox, undefined);
  const policy = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
  if (policy) assert.equal(policy, "script-src 'self'; object-src 'self';");
});

check("4色の音源配線 / 画像と音源の実体", () => {
  const source = fs.readFileSync(path.join(root, "effects.js"), "utf8");
  const context = vm.createContext({ URL, document: { currentScript: { src: "https://preview.example/effects.js" } },
    chrome: { runtime: { getURL: file => "chrome-extension://fixture/" + file } } });
  vm.runInContext(source, context, { filename: "effects.js" });
  assert.deepEqual(JSON.parse(JSON.stringify(context.ChanceLampAudio.files)), audioFiles);
  assert.ok(Object.isFrozen(context.ChanceLampAudio.files));
  for (const file of Object.values(audioFiles)) {
    const data = fs.readFileSync(path.join(root, file));
    assert.ok(data.length > 44, file + " が空か短すぎる");
    if (file.endsWith(".wav")) {
      assert.equal(data.subarray(0, 4).toString("ascii"), "RIFF", file);
      assert.equal(data.subarray(8, 12).toString("ascii"), "WAVE", file);
    } else assert.ok(data.subarray(0, 3).toString("ascii") === "ID3" || data[0] === 255 && (data[1] & 224) === 224,
      file + " にMP3ヘッダがない");
  }
  const image = fs.readFileSync(path.join(root, logoFile));
  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(image.readUInt32BE(16) >= 128 && image.readUInt32BE(20) >= 128);
  assert.equal(image[25], 6, "ロゴは透過RGBA PNG");
});

const files = filesIn(root);
check("JS構文", () => {
  for (const file of files.filter(file => /\.(?:js|cjs)$/.test(file))) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, path.relative(root, file) + " " + (result.stderr || result.error || ""));
  }
});

check("デバッグ残骸", () => {
  for (const file of files.filter(file => /\.(?:js|cjs)$/.test(file))) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/\bconsole\s*\.\s*(?:log|debug)\s*\(/.test(text), path.relative(root, file) + " にデバッグ出力");
    assert.ok(!/\bdebugger\s*;/.test(text), path.relative(root, file) + " に停止命令");
  }
});

check("生の制御バイト", () => {
  for (const file of files.filter(file => /\.(?:js|cjs|html|css|json|md|svg)$/.test(file))) {
    const bytes = fs.readFileSync(file);
    const index = bytes.findIndex(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 || byte === 127);
    assert.equal(index, -1, path.relative(root, file) + " のbyte " + index + " に制御文字");
  }
});

if (errors.length) {
  process.stderr.write(errors.join("\n") + "\n");
  process.exitCode = 1;
} else process.stdout.write("静的検査 " + checks.length + "項目 合格\n");
