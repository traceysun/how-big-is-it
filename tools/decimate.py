"""Shrink a Tripo GLB (~1.5M tris) to a web-friendly size.

1. Quadric-decimate the mesh with Open3D.
2. Re-unwrap the small mesh with xatlas.
3. Bake the original base-colour texture into the new atlas: every texel maps
   to a 3D point on the small mesh, which we look up against the (very dense)
   original vertices to fetch its colour.

usage: python3 tools/decimate.py in.glb out.glb [target_triangles] [texture_px]
"""
import os
import sys
import numpy as np
import trimesh
import open3d as o3d
import xatlas
from PIL import Image
from scipy.spatial import cKDTree
from scipy.ndimage import binary_dilation

src, dst = sys.argv[1], sys.argv[2]
target = int(sys.argv[3]) if len(sys.argv) > 3 else 40000
tex_px = int(sys.argv[4]) if len(sys.argv) > 4 else 1024

# ---- load original ----
scene = trimesh.load(src, force='scene')
meshes = [g for g in scene.dump() if isinstance(g, trimesh.Trimesh)]
mesh = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
print(f'{src}: {len(mesh.faces)} tris, {len(mesh.vertices)} verts')

uv = np.asarray(mesh.visual.uv)
material = mesh.visual.material
image = material.baseColorTexture if hasattr(material, 'baseColorTexture') else material.image
image = image.convert('RGB')
img = np.asarray(image)
ih, iw = img.shape[:2]

# Colour of every original vertex, sampled from the texture at its UV.
px = np.clip((uv[:, 0] % 1.0) * (iw - 1), 0, iw - 1).astype(int)
py = np.clip((1 - (uv[:, 1] % 1.0)) * (ih - 1), 0, ih - 1).astype(int)
vert_color = img[py, px]
tree = cKDTree(mesh.vertices)

# ---- decimate ----
om = o3d.geometry.TriangleMesh(
    o3d.utility.Vector3dVector(np.ascontiguousarray(mesh.vertices, dtype=np.float64)),
    o3d.utility.Vector3iVector(np.ascontiguousarray(mesh.faces, dtype=np.int32)),
)
om = om.simplify_quadric_decimation(target_number_of_triangles=target)
om.remove_unreferenced_vertices()
om.remove_degenerate_triangles()
verts = np.asarray(om.vertices, dtype=np.float32)
faces = np.asarray(om.triangles, dtype=np.uint32)
print(f'  decimated -> {len(faces)} tris, {len(verts)} verts')

# ---- unwrap ----
vmap, new_faces, new_uv = xatlas.parametrize(verts, faces)
new_verts = verts[vmap]
print(f'  unwrapped -> {len(new_verts)} verts')

# ---- bake ----
W = H = tex_px
atlas = np.zeros((H, W, 3), dtype=np.uint8)
filled = np.zeros((H, W), dtype=bool)
# UV -> pixel (v flipped, image row 0 is top)
puv = np.stack([new_uv[:, 0] * (W - 1), (1 - new_uv[:, 1]) * (H - 1)], axis=1)

for tri in new_faces:
    p = puv[tri]                       # 3x2 pixel coords
    x0, y0 = np.floor(p.min(axis=0)).astype(int)
    x1, y1 = np.ceil(p.max(axis=0)).astype(int)
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, W - 1), min(y1, H - 1)
    if x1 < x0 or y1 < y0:
        continue
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
    xs = xs.ravel() + 0.5
    ys = ys.ravel() + 0.5
    # barycentric coords
    (ax, ay), (bx, by), (cx, cy) = p
    det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(det) < 1e-9:
        continue
    l0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / det
    l1 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / det
    l2 = 1 - l0 - l1
    eps = -0.02
    inside = (l0 >= eps) & (l1 >= eps) & (l2 >= eps)
    if not inside.any():
        continue
    l0, l1, l2 = l0[inside], l1[inside], l2[inside]
    pts = (l0[:, None] * new_verts[tri[0]] + l1[:, None] * new_verts[tri[1]] + l2[:, None] * new_verts[tri[2]])
    _, idx = tree.query(pts)
    ix = (xs[inside] - 0.5).astype(int)
    iy = (ys[inside] - 0.5).astype(int)
    atlas[iy, ix] = vert_color[idx]
    filled[iy, ix] = True

# Dilate filled texels outward a few pixels so bilinear filtering doesn't bleed the background in at seams.
for _ in range(6):
    grown = binary_dilation(filled)
    ring = grown & ~filled
    if not ring.any():
        break
    ys_, xs_ = np.nonzero(ring)
    src_y, src_x = np.nonzero(filled)
    _, near = cKDTree(np.stack([src_y, src_x], 1)).query(np.stack([ys_, xs_], 1))
    atlas[ys_, xs_] = atlas[src_y[near], src_x[near]]
    filled = grown

# ---- export ----
out = trimesh.Trimesh(vertices=new_verts, faces=new_faces, process=False)
out.visual = trimesh.visual.TextureVisuals(
    uv=new_uv,
    material=trimesh.visual.material.PBRMaterial(
        baseColorTexture=Image.fromarray(atlas), metallicFactor=0.0, roughnessFactor=0.85),
)
out.export(dst)
print(f'  wrote {dst}: {os.path.getsize(dst)/1e6:.1f} MB')
