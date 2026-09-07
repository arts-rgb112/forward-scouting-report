// Offline lossless texture packaging; no runtime dependencies or source rewrites.
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require(process.argv[2]);
async function main() {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'public/assets/infield-v1');
  await fs.mkdir(out, { recursive: true });
  for (const name of ['Color', 'NormalGL', 'Roughness', 'AmbientOcclusion']) {
    const source = path.join(root, 'study-assets/grass001', `Grass001_2K-JPG_${name}.jpg`);
    const target = path.join(out, `${name}.webp`);
    await sharp(source).webp({ lossless: true, effort: 6 }).toFile(target);
    console.log(name, (await fs.stat(target)).size);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
