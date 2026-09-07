"""Offline Blender conversion; original EXR remains untouched."""
from pathlib import Path
import bpy

root = Path(__file__).resolve().parent.parent
image = bpy.data.images.load(str(root / "study-assets/meadow_2_4k.exr"))
image.scale(2048, 1024)
out = root / "public/assets/infield-v1"
out.mkdir(parents=True, exist_ok=True)
image.filepath_raw = str(out / "meadow-2-2k.hdr")
image.file_format = 'HDR'
image.save()
print("packaged HDR", Path(image.filepath_raw).stat().st_size)
