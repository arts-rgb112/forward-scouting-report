# Infield v1 runtime assets

- Owner release authorization: 2026-09-08, stop visual experiments and ship current approved close-up quality.
- Grass: ambientCG Grass001, CC0, https://ambientcg.com/view?id=Grass001 . Procedural material, not a verified scan. Physical tile 1.4m. Source 2K JPEG maps converted to lossless WebP without resizing. Original archive preserved outside public.
- Environment: Meadow 2, Sergej Majboroda / Poly Haven, CC0, https://polyhaven.com/a/meadow_2 . Original 4K EXR preserved outside public; runtime 2K Radiance HDR exported using Blender. Background is a projected panorama, not 3D vegetation; aerial distortion remains a known limitation.
- Reproduce with scripts/package_pitch_assets.cjs (sharp path argument) and Blender --background --python scripts/package_pitch_environment.py. No runtime dependency added. No source GLB change. Only these packaged assets ship; original EXR/ZIP/comparison GLBs/study HTML are excluded.
