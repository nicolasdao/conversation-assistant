// Writes THIRD_PARTY_NOTICES.md: every third-party component the Mac app ships, with its license and notices (see
// docs/desktop.md § Licenses). The npm part comes from the installed production dependencies, so it cannot drift from
// what ships; the rest (Electron, the native libraries, the models, the fonts) is listed below.
//   node scripts/third-party-notices.mjs           write it
//   node scripts/third-party-notices.mjs --check   exit 1 when the committed file is out of date (a release gate)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "THIRD_PARTY_NOTICES.md";
const pkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const text = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim();
const fence = (t) => "```text\n" + t + "\n```";
const electron = pkg("node_modules/electron").version;
const sherpa = pkg("node_modules/sherpa-onnx-node").version;
// Electron's own license files come with its binary, which is downloaded on first use: right after `npm ci` it is
// missing, so fetch it first (the app build needs these files too)
if (!existsSync("node_modules/electron/dist/LICENSES.chromium.html")) {
  execFileSync(process.execPath, ["node_modules/electron/install.js"], { stdio: "ignore" });
}

// ---------- npm: the production dependencies, as installed ----------

const lines = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable", "--long"], { encoding: "utf8" }).trim().split("\n").slice(1);
const seen = new Map();
for (const l of lines) {
  const [dir, id] = l.split(":");
  if (!id || seen.has(id)) continue;
  const p = pkg(dir);
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  seen.set(id, { name: p.name, version: p.version, license: typeof p.license === "string" ? p.license : "see below", dir, file, p });
}
const npmEntries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
  const home = e.p.homepage ?? (typeof e.p.repository === "string" ? e.p.repository : e.p.repository?.url) ?? `https://www.npmjs.com/package/${e.name}`;
  let body;
  if (e.file) body = fence(text(join(e.dir, e.file)));
  else if (e.license === "MIT") {
    const author = typeof e.p.author === "string" ? e.p.author : e.p.author?.name;
    body = "The package ships no license file; its package.json declares MIT" + (author ? `, by ${author}` : "") + ".\n\n" + fence(text("licenses/MIT.txt"));
  } else if (e.license === "Apache-2.0") body = "The package ships no license file; its package.json declares Apache-2.0: see `licenses/Apache-2.0.txt`.";
  else throw new Error(`${e.name}: no license file and no known license text for ${e.license}`);
  return `### ${e.name} ${e.version}\n\n${e.license} · ${home.replace(/^git\+/, "").replace(/\.git$/, "")}\n\n${body}`;
});

// ---------- everything else the app ships ----------

const other = [
  `### Electron ${electron}

MIT · https://github.com/electron/electron. Electron includes Chromium, Node.js, FFmpeg (LGPL-2.1, in its own replaceable library), and many other components, whose licenses are in \`LICENSES.chromium.html\`, shipped with the app. Their source is the Chromium version this Electron release names in its notes (https://github.com/electron/electron/releases/tag/v${electron}), at https://chromium.googlesource.com/chromium/src.

${fence(text("node_modules/electron/dist/LICENSE"))}`,

  `### Squirrel.Mac, Mantle, ReactiveObjC (Electron's update frameworks)

MIT · https://github.com/Squirrel/Squirrel.Mac · https://github.com/Mantle/Mantle · https://github.com/ReactiveCocoa/ReactiveObjC

${fence(text("licenses/Squirrel.Mac-LICENSE.txt"))}

${fence(text("licenses/Mantle-LICENSE.txt"))}

${fence(text("licenses/ReactiveObjC-LICENSE.txt"))}`,

  `### sherpa-onnx ${sherpa} (native libraries)

Apache-2.0 · https://github.com/k2-fsa/sherpa-onnx (tag v${sherpa}). The prebuilt libraries in \`sherpa-onnx-darwin-arm64\` also build in kaldi-native-fbank, kaldi-decoder, kaldifst and OpenFst, simple-sentencepiece, nlohmann/json, and piper-phonemize, under Apache-2.0 or MIT. Full text: \`licenses/Apache-2.0.txt\`.`,

  `### eSpeak NG (inside sherpa-onnx's library)

**GPL-3.0-or-later** · https://github.com/espeak-ng/espeak-ng. sherpa-onnx's prebuilt \`libsherpa-onnx-c-api.dylib\` compiles in eSpeak NG, for text-to-speech, which Conversation Assistant does not use. It is there because that prebuilt library includes it. The Corresponding Source for it:

- sherpa-onnx v${sherpa}: https://github.com/k2-fsa/sherpa-onnx/tree/v${sherpa} (build scripts included; \`cmake/espeak-ng-for-piper.cmake\` names the eSpeak NG source below);
- eSpeak NG as built: https://github.com/csukuangfj/espeak-ng/archive/ed530aa113046142eb5115cf2fc9157854d0ffe1.zip (SHA-256 e4e262cbe34f7fe21f91f1ba3397f2728e1f30eafbae7853f2b753a9ed13f0dd);
- both are also attached to each GitHub Release of Conversation Assistant that ships this library.

Conversation Assistant's own code is BSD-3-Clause, which is compatible with the GPL; you may use, study, change, and share the app under the GPL's terms. Full text: \`licenses/GPL-3.0.txt\`.`,

  `### ONNX Runtime 1.28.2 (inside sherpa-onnx's \`libonnxruntime.dylib\`)

MIT · https://github.com/microsoft/onnxruntime. Its own third-party notices: \`licenses/onnxruntime-ThirdPartyNotices.txt\`.

${fence(text("licenses/onnxruntime-LICENSE.txt"))}`,

  `### Silero VAD (model: \`models/silero_vad.onnx\`)

MIT · https://github.com/snakers4/silero-vad, downloaded from sherpa-onnx's model releases.

${fence(text("licenses/silero-vad-LICENSE.txt"))}`,

  `### WeSpeaker ResNet34-LM, VoxCeleb (model: \`models/wespeaker_en_voxceleb_resnet34_LM.onnx\`)

**CC BY 4.0** · https://creativecommons.org/licenses/by/4.0/

"wespeaker_en_voxceleb_resnet34_LM" by the WeSpeaker authors (https://github.com/wenet-e2e/wespeaker), trained on VoxCeleb, licensed under CC BY 4.0. Converted to ONNX by the sherpa-onnx project (https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models); used without further changes by Conversation Assistant.`,

  `### Barlow and Barlow Condensed (fonts: \`web/fonts/\`)

SIL Open Font License 1.1 · Copyright 2017 The Barlow Project Authors · https://github.com/jpt/barlow. The license ships next to the fonts: \`web/fonts/OFL.txt\`.`,
];

const doc = `# Third-party notices

Conversation Assistant is © 2026 Cloudless Consulting Pty Ltd, under the BSD 3-Clause license ([LICENSE](LICENSE)). The Mac app also contains the third-party software below, each under its own license. The texts not given in full here are in [\`licenses/\`](licenses/), and in the app under **Help → Third-Party Notices**.

This file is generated by \`scripts/third-party-notices.mjs\` from the installed dependencies; do not edit it by hand.

## Components built into the app

${other.join("\n\n")}

## npm packages in the app

${npmEntries.join("\n\n")}
`;

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== doc) {
    console.error(`${OUT} is out of date: run node scripts/third-party-notices.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date`);
} else {
  writeFileSync(OUT, doc);
  console.log(`wrote ${OUT} (${seen.size} npm packages, ${other.length} other components)`);
}
