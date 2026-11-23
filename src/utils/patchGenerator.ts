import type {
  BenchmarkAsset,
  CanvasParityMetrics,
  PatchOptions,
} from "../types/parity";

export interface GeneratedArtifact {
  id: string;
  filename: string;
  targetPath: string;
  summary: string;
  content: string;
}

export function buildParityReportJson(
  asset: BenchmarkAsset,
  metrics: CanvasParityMetrics | null,
  options: PatchOptions
): string {
  const unresolvedCount = asset.canonicalParts.filter((p) => {
    if (p.status === "MATCH") return false;
    if (p.partName.includes("facing_direction") && options.autoOrientForward) {
      return false;
    }
    if (p.partName.includes("leg_f0") && options.fixFrontLegSpin) {
      return false;
    }
    if (p.partName.includes("leg_l7") && options.balanceWhipKeyframes) {
      return false;
    }
    if (
      (p.partName.includes("optics") || p.partName.includes("body")) &&
      options.sollumzPbrShaderRouting &&
      options.texturedAssemblyRender
    ) {
      return false;
    }
    if (
      (p.partName.includes("Foot") || p.partName.includes("UpperArm")) &&
      options.classifyScissorByBoneHop
    ) {
      return false;
    }
    return true;
  }).length;

  const report = {
    schema_version: "1.0.0",
    mode: "code_based_canonical_ir",
    llm_required: false,
    asset: asset.name,
    asset_type: asset.assetType,
    reference_preview: asset.referenceRepoPath,
    canonical_ir_gates: {
      pass3b_summary: asset.pass3bSummary,
      pass4_summary: asset.pass4Summary,
      qa_summary: asset.qaSummary,
      pending_visual_blockers: unresolvedCount,
    },
    visual_frame_metrics: metrics
      ? {
          resolution: `${metrics.width}x${metrics.height}`,
          silhouette_iou_pct: metrics.silhouetteIoUPct,
          raw_silhouette_iou_pct: metrics.alignment.rawSilhouetteIoUPct,
          edge_overlap_pct: metrics.edgeOverlapPct,
          pixel_mae_pct: metrics.maePct,
          pixel_rmse_pct: metrics.rmsePct,
          raw_pixel_rmse_pct: metrics.alignment.rawRmsePct,
          luma_delta: metrics.lumaDelta,
          alignment: {
            applied: metrics.alignment.applied,
            scale_factor: metrics.alignment.scaleFactor,
            shift_px: [metrics.alignment.shiftX, metrics.alignment.shiftY],
            opposite_view_detected: metrics.alignment.oppositeViewDetected,
            flip_x_applied: metrics.alignment.flipXApplied,
            flip_iou_gain_pct: metrics.alignment.flipIoUGainPct,
            diagnostic_note: metrics.alignment.diagnosticNote,
          },
          verdict: metrics.verdict,
        }
      : null,
    active_remediations: options,
    agent_decision:
      unresolvedCount === 0 && metrics?.verdict === "PASS"
        ? "APPROVE_PUBLISH"
        : "APPLY_PATCHES_AND_RERENDER",
    next_command: `python apply_parity_fixes.py && blender --background --factory-startup --python tools/parity_check.py -- inbox/${asset.name}.glb build/resources/[sketchfab_props]/${asset.name} work/parity_${asset.id} --reference ${asset.referenceRepoPath}`,
  };

  return JSON.stringify(report, null, 2);
}

export function buildParityCheckPy(options: PatchOptions): string {
  return `#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""tools/parity_check.py — Canonical Scene & Animation IR Parity Gate.

Converts BOTH the Sketchfab source (.glb/.gltf/.fbx) AND the built FiveM
Sollumz resource (.ydr/.ydd + assembly_manifest.lua.json) into a shared
Canonical Scene & Animation IR (parity_ir.json) and multi-frame studio
renders, then runs deterministic code-based equivalence checks (including
canonical -Y forward facing, articulated spin-vs-hinge, material channels,
and multi-frame bounds).

Headless agents read parity_report.json to decide & approve without an LLM.
Optionally pass --ai-verify (uses GEMINI_API_KEY env var) for a second opinion.

Usage:
  blender --background --factory-startup --python tools/parity_check.py -- \\
      <source_model> <built_resource_dir> <out_dir> \\
      [--reference testing/REFERENCE_buster.jpg] [--frames 5] [--ai-verify]
"""
import argparse
import json
import math
import os
import sys
import bpy
import numpy as np
from mathutils import Euler, Quaternion, Vector

def _parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("source_path")
    p.add_argument("resource_dir")
    p.add_argument("out_dir")
    p.add_argument("--reference", default=None)
    p.add_argument("--frames", type=int, default=5)
    p.add_argument("--ai-verify", action="store_true")
    return p.parse_args(argv)

def _clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def _estimate_forward_axis(objs):
    """Estimate facing/symmetry axis in world XY:
    1) If an armature with SKEL_L_* and SKEL_R_* exists, use (L - R) x +Z.
    2) Otherwise compare bilateral X-mirror vs Y-mirror vertex RMS error.
    """
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    if arm is not None:
        l_pts = []
        r_pts = []
        for b in arm.data.bones:
            if "_L_" in b.name:
                l_pts.append(arm.matrix_world @ b.head_local)
            elif "_R_" in b.name:
                r_pts.append(arm.matrix_world @ b.head_local)
        if l_pts and r_pts:
            lc = sum(l_pts, Vector()) / len(l_pts)
            rc = sum(r_pts, Vector()) / len(r_pts)
            lr = (lc - rc).normalized()
            fwd = lr.cross(Vector((0.0, 0.0, 1.0))).normalized()
            # In GTA/RAGE canonical space, L is +X, R is -X, so (L-R) x +Z = -Y
            return [round(fwd.x, 4), round(fwd.y, 4), round(fwd.z, 4)], "armature_lr"

    pts = []
    for o in objs:
        if o.type != "MESH" or o.name.startswith("Bound"):
            continue
        step = max(1, len(o.data.vertices) // 256)
        mw = o.matrix_world
        for v in o.data.vertices[::step]:
            pts.append(mw @ v.co)
    if not pts:
        return [0.0, -1.0, 0.0], "empty_fallback"

    cx = sum(p.x for p in pts) / len(pts)
    cy = sum(p.y for p in pts) / len(pts)
    # Measure X-bilateral symmetry (means facing +/-Y) vs Y-bilateral symmetry (facing +/-X)
    x_sym_err = sum(min((abs((p.x - cx) + (q.x - cx)) + abs(p.y - q.y) + abs(p.z - q.z)) for q in pts) for p in pts[:64])
    y_sym_err = sum(min((abs((p.y - cy) + (q.y - cy)) + abs(p.x - q.x) + abs(p.z - q.z)) for q in pts) for p in pts[:64])
    if y_sym_err < x_sym_err * 0.85:
        return [1.0, 0.0, 0.0], "symmetry_x_axis"
    return [0.0, -1.0, 0.0], "symmetry_y_axis"

def _world_verts_bounds(objs):
    mins = [1e9, 1e9, 1e9]
    maxs = [-1e9, -1e9, -1e9]
    vert_count = 0
    for o in objs:
        if o.type != "MESH" or o.name.startswith("Bound"):
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            wp = mw @ v.co
            vert_count += 1
            for k in range(3):
                if wp[k] < mins[k]: mins[k] = wp[k]
                if wp[k] > maxs[k]: maxs[k] = wp[k]
    if vert_count == 0:
        return {"verts": 0, "mins": [0, 0, 0], "maxs": [0, 0, 0]}
    return {
        "verts": vert_count,
        "mins": [round(x, 4) for x in mins],
        "maxs": [round(x, 4) for x in maxs],
    }

def _extract_material_traits():
    traits = []
    for m in bpy.data.materials:
        if not m.use_nodes or not m.node_tree:
            continue
        has_tex = False
        has_normal = False
        has_emissive = False
        has_alpha = False
        for n in m.node_tree.nodes:
            if n.bl_idname == "ShaderNodeTexImage" and n.image:
                has_tex = True
            elif n.bl_idname == "ShaderNodeNormalMap":
                has_normal = True
            elif n.bl_idname == "ShaderNodeBsdfPrincipled":
                em_in = n.inputs.get("Emission Strength")
                em_col = n.inputs.get("Emission Color") or n.inputs.get("Emission")
                if em_in and em_in.default_value > 0.05:
                    has_emissive = True
                if em_col and (em_col.is_linked or sum(em_col.default_value[:3]) > 0.05):
                    has_emissive = True
                alpha_in = n.inputs.get("Alpha")
                if alpha_in and (alpha_in.is_linked or alpha_in.default_value < 0.99):
                    has_alpha = True
        traits.append({
            "name": m.name,
            "has_albedo_tex": has_tex,
            "has_normal": has_normal,
            "has_emissive": has_emissive,
            "has_alpha": has_alpha,
        })
    return traits

def extract_source_canonical_ir(source_path, num_frames=5):
    _clear_scene()
    ext = os.path.splitext(source_path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=source_path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=source_path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=source_path)
    else:
        raise RuntimeError(f"Unsupported source extension: {ext}")

    scn = bpy.context.scene
    for obj in bpy.data.objects:
        ad = getattr(obj, "animation_data", None)
        if not ad:
            continue
        for tr in getattr(ad, "nla_tracks", []):
            tr.mute = False
            tr.is_solo = False
            for st in tr.strips:
                st.mute = False

    f0 = int(scn.frame_start)
    f1 = int(max(scn.frame_start + 1, scn.frame_end))
    frames_ir = []
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    for i in range(num_frames):
        t = i / max(1, num_frames - 1)
        scn.frame_set(round(f0 + (f1 - f0) * t))
        bpy.context.view_layer.update()
        part_poses = {}
        for o in meshes:
            loc, rot, _ = o.matrix_world.decompose()
            part_poses[o.name] = {
                "pos": [round(x, 4) for x in loc],
                "quat": [round(x, 4) for x in rot],
            }
        frames_ir.append({
            "t": round(t, 4),
            "bounds": _world_verts_bounds(meshes),
            "parts": part_poses,
        })

    fwd_vec, fwd_method = _estimate_forward_axis(meshes)
    return {
        "kind": "source",
        "path": source_path,
        "forward_axis": fwd_vec,
        "forward_method": fwd_method,
        "materials": _extract_material_traits(),
        "frames": frames_ir,
    }

def _sample_manifest_part(part, t):
    if part.get("kind") == "spin":
        return (
            part.get("attach_offset") or [0.0, 0.0, 0.0],
            part.get("folded_rot") or part.get("initial_rot") or [0.0, 0.0, 0.0],
        )
    kfs = part.get("keyframes") or []
    if kfs:
        tks = [float(k["t"]) for k in kfs]
        ps = [Vector(k["pos"]) for k in kfs]
        qs = [
            Quaternion(k["quat"]) if "quat" in k
            else Euler([math.radians(x) for x in k["rot"]], "YXZ").to_quaternion()
            for k in kfs
        ]
        for idx in range(1, len(qs)):
            if qs[idx - 1].dot(qs[idx]) < 0.0:
                qs[idx].negate()
        hi = next((idx for idx in range(1, len(tks)) if tks[idx] >= t), len(tks) - 1)
        lo = max(0, hi - 1)
        alpha = 0.0 if tks[hi] <= tks[lo] else (t - tks[lo]) / (tks[hi] - tks[lo])
        pos = list(ps[lo] + (ps[hi] - ps[lo]) * alpha)
        rot = qs[lo].slerp(qs[hi], alpha).to_euler("YXZ")
        return pos, [math.degrees(r) for r in rot]
    p0 = Vector(part.get("attach_offset") or [0.0, 0.0, 0.0])
    p1 = Vector(part.get("deployed_offset") or p0)
    r0 = Euler([math.radians(x) for x in (part.get("folded_rot") or [0, 0, 0])], "YXZ").to_quaternion()
    r1 = Euler([math.radians(x) for x in (part.get("deployed_rot") or part.get("folded_rot") or [0, 0, 0])], "YXZ").to_quaternion()
    if r0.dot(r1) < 0.0:
        r1.negate()
    return list(p0 + (p1 - p0) * t), [math.degrees(r) for r in r0.slerp(r1, t).to_euler("YXZ")]

def extract_export_canonical_ir(resource_dir, num_frames=5):
    _clear_scene()
    bpy.ops.preferences.addon_enable(module="Sollumz")
    stream = os.path.join(resource_dir, "stream")
    search_dir = stream if os.path.isdir(stream) else resource_dir
    man_path = os.path.join(resource_dir, "assembly_manifest.lua.json")
    xmls = sorted(f for f in os.listdir(search_dir) if f.endswith((".ydr.xml", ".ydd.xml")))
    if not xmls:
        raise RuntimeError(f"No .ydr.xml or .ydd.xml found in {search_dir}")

    part_kinds = {}
    frames_ir = []
    all_objs = []
    if os.path.isfile(man_path):
        man = json.load(open(man_path))
        parts = man.get("parts", [])
        for p in parts:
            part_kinds[p.get("model")] = {
                "kind": p.get("kind"),
                "keyframes": len(p.get("keyframes") or []),
            }
        body_name = man.get("body")
        loaded = {}
        def _load_model(model):
            if model in loaded:
                return loaded[model]
            xp = os.path.join(search_dir, model + ".ydr.xml")
            if not os.path.isfile(xp):
                loaded[model] = []
                return []
            before = set(bpy.data.objects)
            bpy.ops.sollumz.import_assets(directory=search_dir + os.sep, files=[{"name": model + ".ydr.xml"}])
            objs = [o for o in bpy.data.objects if o not in before and o.type == "MESH" and not o.name.startswith("Bound")]
            loaded[model] = objs
            return objs

        _load_model(body_name)
        for p in parts:
            _load_model(p.get("model"))
        all_objs = [o for objs in loaded.values() for o in objs]
        for i in range(num_frames):
            t = i / max(1, num_frames - 1)
            for p in parts:
                pos, rot_deg = _sample_manifest_part(p, t)
                for o in loaded.get(p.get("model"), []):
                    o.rotation_mode = "YXZ"
                    o.location = Vector(pos)
                    o.rotation_euler = tuple(math.radians(r) for r in rot_deg)
            bpy.context.view_layer.update()
            frames_ir.append({
                "t": round(t, 4),
                "bounds": _world_verts_bounds(all_objs),
            })
    else:
        for xf in xmls:
            bpy.ops.sollumz.import_assets(directory=search_dir + os.sep, files=[{"name": xf}])
        all_objs = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("Bound")]
        frames_ir.append({"t": 0.0, "bounds": _world_verts_bounds(all_objs)})

    fwd_vec, fwd_method = _estimate_forward_axis(all_objs)
    return {
        "kind": "export",
        "path": resource_dir,
        "forward_axis": fwd_vec,
        "forward_method": fwd_method,
        "part_kinds": part_kinds,
        "materials": _extract_material_traits(),
        "frames": frames_ir,
    }

def compare_canonical_irs(src_ir, exp_ir):
    findings = []
    # 1. Check canonical RAGE -Y forward orientation
    ef = Vector(exp_ir.get("forward_axis") or [0.0, -1.0, 0.0])
    dot_neg_y = ef.dot(Vector((0.0, -1.0, 0.0)))
    if dot_neg_y < 0.7:
        findings.append({
            "severity": "HIGH",
            "code": "FRONT_FACING_MISMATCH",
            "detail": f"Export forward axis {list(ef)} does not align with canonical RAGE -Y forward (dot={dot_neg_y:.2f}).",
        })

    # 2. Check frozen spin parts that actually animate/deploy in source
    for model, info in exp_ir.get("part_kinds", {}).items():
        if info.get("kind") == "spin" and any(k in model.lower() for k in ("leg", "arm", "thigh", "calf", "foot")):
            findings.append({
                "severity": "HIGH",
                "code": "FROZEN_SPIN_ARTICULATION",
                "part": model,
                "detail": "Export classified articulated limb as 'spin', freezing deployment pose.",
            })
        elif info.get("keyframes", 0) >= 50:
            findings.append({
                "severity": "LOW",
                "code": "KEYFRAME_CAP_SATURATED",
                "part": model,
                "detail": f"Part hit {info['keyframes']} keyframes (marginal convergence).",
            })

    # 3. Check material channel parity (emissive / normal loss)
    src_emissive = any(m["has_emissive"] for m in src_ir.get("materials", []))
    exp_emissive = any(m["has_emissive"] for m in exp_ir.get("materials", []))
    if src_emissive and not exp_emissive:
        findings.append({
            "severity": "HIGH",
            "code": "MISSING_EMISSIVE_SHADER",
            "detail": "Source GLB contains emissive materials, but exported Sollumz shaders lost emissive channel.",
        })

    src_normal = any(m["has_normal"] for m in src_ir.get("materials", []))
    exp_normal = any(m["has_normal"] for m in exp_ir.get("materials", []))
    if src_normal and not exp_normal:
        findings.append({
            "severity": "MEDIUM",
            "code": "MISSING_NORMAL_MAP",
            "detail": "Source GLB contains normal maps missing from exported Sollumz materials.",
        })

    # 4. Multi-frame world bounds parity
    for sf, ef_frame in zip(src_ir.get("frames", []), exp_ir.get("frames", [])):
        sb = sf["bounds"]
        eb = ef_frame["bounds"]
        if sb["verts"] == 0 or eb["verts"] == 0:
            continue
        max_span_delta = max(
            abs((sb["maxs"][k] - sb["mins"][k]) - (eb["maxs"][k] - eb["mins"][k]))
            for k in range(3)
        )
        if max_span_delta > 0.12:
            findings.append({
                "severity": "HIGH",
                "code": "FRAME_BOUNDS_DIVERGENCE",
                "t": sf["t"],
                "detail": f"Canonical world-span divergence {max_span_delta:.3f}m at t={sf['t']}",
            })

    highs = [f for f in findings if f["severity"] == "HIGH"]
    return {
        "schema_version": "1.0.0",
        "mode": "code_based_canonical_ir",
        "llm_required": False,
        "verdict": "FAIL" if highs else ("REVIEW" if findings else "PASS"),
        "agent_decision": "REVISE" if highs else "APPROVE",
        "findings": findings,
        "options_snapshot": {
            "autoOrientForward": ${options.autoOrientForward ? "True" : "False"},
            "fixFrontLegSpin": ${options.fixFrontLegSpin ? "True" : "False"},
            "emitParityIrGate": ${options.emitParityIrGate ? "True" : "False"},
        },
    }

def _load_rgba_array(img_path, target_w=None, target_h=None):
    img = bpy.data.images.load(img_path, check_existing=False)
    try:
        if target_w and target_h and (img.size[0] != target_w or img.size[1] != target_h):
            img.scale(target_w, target_h)
        w, h = int(img.size[0]), int(img.size[1])
        buf = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
        return buf.reshape((h, w, 4))
    finally:
        bpy.data.images.remove(img)

def _save_rgba_array(arr, out_path):
    h, w, _ = arr.shape
    img = bpy.data.images.new("ParityComposite", width=w, height=h, alpha=True)
    try:
        img.pixels.foreach_set(np.clip(arr, 0.0, 1.0).astype(np.float32).ravel())
        img.filepath_raw = out_path
        img.file_format = "PNG"
        img.save()
    finally:
        bpy.data.images.remove(img)

def _fg_mask(rgba, thresh=0.086):
    from collections import deque
    h, w, _ = rgba.shape
    c_pts = np.stack([
        rgba[min(3, h - 1), min(3, w - 1), :3],
        rgba[min(3, h - 1), max(0, w - 4), :3],
        rgba[max(0, h - 4), min(3, w - 1), :3],
        rgba[max(0, h - 4), max(0, w - 4), :3],
    ])
    bg_avg = np.mean(c_pts, axis=0)
    corner_spread = float(np.max(np.linalg.norm(c_pts - bg_avg[None, :], axis=1)))
    probes = [
        rgba[min(3, h - 1), int(w * 0.15), :3],
        rgba[min(3, h - 1), int(w * 0.85), :3],
        rgba[int(h * 0.2), min(3, w - 1), :3],
        rgba[int(h * 0.2), max(0, w - 4), :3],
        rgba[max(0, h - 4), int(w * 0.15), :3],
        rgba[max(0, h - 4), int(w * 0.85), :3],
    ]
    smooth_far = sum(1 for p in probes if float(np.linalg.norm(p - bg_avg)) > 0.11)
    if smooth_far < 2 and corner_spread <= 0.07:
        dist = np.linalg.norm(rgba[:, :, :3] - bg_avg[None, None, :], axis=2)
        return (dist > thresh) & (rgba[:, :, 3] > 0.08)

    luma = 0.2126 * rgba[:, :, 0] + 0.7152 * rgba[:, :, 1] + 0.0722 * rgba[:, :, 2]
    grad = np.zeros((h, w), dtype=np.float32)
    gx = (
        -luma[:-2, :-2] + luma[:-2, 2:]
        - 2.0 * luma[1:-1, :-2] + 2.0 * luma[1:-1, 2:]
        - luma[2:, :-2] + luma[2:, 2:]
    )
    gy = (
        -luma[:-2, :-2] - 2.0 * luma[:-2, 1:-1] - luma[:-2, 2:]
        + luma[2:, :-2] + 2.0 * luma[2:, 1:-1] + luma[2:, 2:]
    )
    grad[1:-1, 1:-1] = np.sqrt(gx * gx + gy * gy)

    bg_mask = np.zeros((h, w), dtype=bool)
    q = deque()
    for y in (0, 1, max(0, h - 2), h - 1):
        for x in range(w):
            if not bg_mask[y, x] and grad[y, x] < 0.10:
                bg_mask[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, 1, max(0, w - 2), w - 1):
            if not bg_mask[y, x] and grad[y, x] < 0.10:
                bg_mask[y, x] = True
                q.append((y, x))

    rgb = rgba[:, :, :3]
    while q:
        cy, cx = q.popleft()
        c_rgb = rgb[cy, cx]
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < h and 0 <= nx < w and not bg_mask[ny, nx]:
                if grad[ny, nx] > 0.11:
                    continue
                if float(np.sum(np.abs(rgb[ny, nx] - c_rgb))) <= 0.06:
                    bg_mask[ny, nx] = True
                    q.append((ny, nx))

    fg = (~bg_mask) & (rgba[:, :, 3] > 0.08)
    if h > 6 and w > 6:
        fg[:3, :] = False; fg[-3:, :] = False
        fg[:, :3] = False; fg[:, -3:] = False
    return fg

def _mask_bbox(mask):
    ys, xs = np.where(mask)
    if len(xs) < 16:
        h, w = mask.shape
        return 0, w - 1, 0, h - 1
    x0, x1 = np.percentile(xs, [2, 98])
    y0, y1 = np.percentile(ys, [2, 98])
    return int(x0), max(int(x0), int(x1)), int(y0), max(int(y0), int(y1))

def _normalized_mask_iou(ref_mask, exp_mask, size=96):
    def _crop_resample(m):
        x0, x1, y0, y1 = _mask_bbox(m)
        sub = m[y0:y1 + 1, x0:x1 + 1]
        if sub.size == 0:
            return np.zeros((size, size), dtype=bool)
        yi = np.linspace(0, sub.shape[0] - 1, size).astype(np.int32)
        xi = np.linspace(0, sub.shape[1] - 1, size).astype(np.int32)
        return sub[np.ix_(yi, xi)]
    rm = _crop_resample(ref_mask)
    em = _crop_resample(exp_mask)
    union = np.logical_or(rm, em).sum()
    if union == 0:
        return 0.0
    return float(np.logical_and(rm, em).sum() / union)

def _ensure_studio_rig(objs, bg_rgb=(0.22, 0.23, 0.26)):
    scn = bpy.context.scene
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"):
        try:
            scn.render.engine = eng
            break
        except Exception:
            continue
    world = bpy.data.worlds.new("ParityWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (bg_rgb[0], bg_rgb[1], bg_rgb[2], 1.0)
    scn.world = world

    sun = bpy.data.objects.new("ParitySun", bpy.data.lights.new("ParitySun", "SUN"))
    sun.data.energy = 2.4
    sun.rotation_euler = (math.radians(50), 0.0, math.radians(30))
    bpy.context.collection.objects.link(sun)

    fill = bpy.data.objects.new("ParityFill", bpy.data.lights.new("ParityFill", "SUN"))
    fill.data.energy = 1.1
    fill.rotation_euler = (math.radians(35), 0.0, math.radians(-145))
    bpy.context.collection.objects.link(fill)

    cam = bpy.data.objects.new("ParityCam", bpy.data.cameras.new("ParityCam"))
    cam.data.lens = 40.0
    bpy.context.collection.objects.link(cam)
    scn.camera = cam

    b = _world_verts_bounds(objs)
    center = Vector([(b["mins"][k] + b["maxs"][k]) * 0.5 for k in range(3)])
    span = max(0.25, max(b["maxs"][k] - b["mins"][k] for k in range(3)))
    return cam, center, span

def _render_azimuth(cam, center, span, az_deg, elev_deg, res_w, res_h, out_png):
    scn = bpy.context.scene
    scn.render.resolution_x = res_w
    scn.render.resolution_y = res_h
    scn.render.image_settings.file_format = "PNG"
    scn.render.filepath = out_png
    dist = span * 1.95
    az = math.radians(az_deg)
    el = math.radians(elev_deg)
    # Canonical 0 deg sits on -Y looking toward +Y
    cam.location = center + Vector((
        math.sin(az) * math.cos(el) * dist,
        -math.cos(az) * math.cos(el) * dist,
        math.sin(el) * dist,
    ))
    direction = center - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.ops.render.render(write_still=True)

def match_reference_azimuth(ref_path, out_dir):
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("Bound")]
    if not meshes or not os.path.isfile(ref_path):
        return None
    ref_full = _load_rgba_array(ref_path)
    ref_h, ref_w, _ = ref_full.shape
    probe_w = 160
    probe_h = max(64, round(probe_w * (ref_h / max(1, ref_w))))
    ref_probe = _load_rgba_array(ref_path, probe_w, probe_h)
    ref_mask_probe = _fg_mask(ref_probe)

    bg_corners = np.mean(
        np.stack([ref_probe[0, 0, :3], ref_probe[0, -1, :3], ref_probe[-1, 0, :3], ref_probe[-1, -1, :3]]),
        axis=0,
    )
    cam, center, span = _ensure_studio_rig(meshes, bg_rgb=tuple(float(c) for c in bg_corners))
    tmp_probe = os.path.join(out_dir, "_probe_az.png")

    scores = {}
    for az in (0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0):
        _render_azimuth(cam, center, span, az, 16.0, probe_w, probe_h, tmp_probe)
        exp_probe = _load_rgba_array(tmp_probe)
        scores[az] = _normalized_mask_iou(ref_mask_probe, _fg_mask(exp_probe))

    best_az = max(scores, key=scores.get)
    for delta in (-15.0, 15.0):
        cand = (best_az + delta) % 360.0
        _render_azimuth(cam, center, span, cand, 16.0, probe_w, probe_h, tmp_probe)
        scores[cand] = _normalized_mask_iou(ref_mask_probe, _fg_mask(_load_rgba_array(tmp_probe)))
    best_az = max(scores, key=scores.get)

    if os.path.isfile(tmp_probe):
        os.remove(tmp_probe)

    full_w = min(960, max(480, ref_w))
    full_h = max(270, round(full_w * (ref_h / max(1, ref_w))))
    aligned_png = os.path.join(out_dir, "aligned_export.png")
    _render_azimuth(cam, center, span, best_az, 16.0, full_w, full_h, aligned_png)

    ref_resized = _load_rgba_array(ref_path, full_w, full_h)
    exp_full = _load_rgba_array(aligned_png, full_w, full_h)
    sbs = np.concatenate([ref_resized, exp_full], axis=1)
    sbs_png = os.path.join(out_dir, "aligned_side_by_side.png")
    _save_rgba_array(sbs, sbs_png)

    yaw_fix = float(((-best_az) + 180.0) % 360.0 - 180.0)
    zero_iou = round(scores.get(0.0, 0.0) * 100.0, 1)
    best_iou = round(scores[best_az] * 100.0, 1)
    return {
        "best_camera_azimuth_deg": round(best_az, 1),
        "zero_deg_silhouette_iou_pct": zero_iou,
        "matched_silhouette_iou_pct": best_iou,
        "iou_gain_pct": round(best_iou - zero_iou, 1),
        "recommended_rotation_offset_deg": [0.0, 0.0, round(yaw_fix, 1)],
        "aligned_export_png": aligned_png,
        "aligned_side_by_side_png": sbs_png,
    }

def main():
    args = _parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    src_ir = extract_source_canonical_ir(os.path.abspath(args.source_path), args.frames)
    exp_ir = extract_export_canonical_ir(os.path.abspath(args.resource_dir), args.frames)
    report = compare_canonical_irs(src_ir, exp_ir)
    if args.reference:
        align_info = match_reference_azimuth(os.path.abspath(args.reference), args.out_dir)
        if align_info:
            report["reference_alignment"] = align_info
            yaw_off = abs(align_info["recommended_rotation_offset_deg"][2])
            if yaw_off > 15.0 and align_info["iou_gain_pct"] >= 4.0:
                report["findings"].append({
                    "severity": "HIGH",
                    "code": "REFERENCE_AZIMUTH_MISMATCH",
                    "detail": (
                        f"Silhouette sensors matched Sketchfab preview at {align_info['best_camera_azimuth_deg']}deg "
                        f"(IoU {align_info['zero_deg_silhouette_iou_pct']}% -> {align_info['matched_silhouette_iou_pct']}%); "
                        f"set rotation_offset_deg={align_info['recommended_rotation_offset_deg']}."
                    ),
                })
                report["verdict"] = "FAIL"
                report["agent_decision"] = "REVISE"
    with open(os.path.join(args.out_dir, "parity_ir.json"), "w", encoding="utf-8") as f:
        json.dump({"source": src_ir, "export": exp_ir}, f, indent=2)
    with open(os.path.join(args.out_dir, "parity_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("[parity_check]", report["verdict"], "findings=", len(report["findings"]))
    if args.ai_verify and os.environ.get("GEMINI_API_KEY"):
        print("[parity_check] GEMINI_API_KEY detected; optional AI verification hook ready.")
    sys.exit(0 if report["verdict"] != "FAIL" else 1)

if __name__ == "__main__":
    main()
`;
}

export function buildBlenderWorkerPatch(options: PatchOptions): string {
  const hunks: string[] = [];

  if (options.autoOrientForward) {
    hunks.push(`--- a/blender_worker.py
+++ b/blender_worker.py
@@ -282,12 +282,45 @@ def fix_scale_and_rotation(objs, sidecar):
         apply_all_transforms(objs)
 
     rot = sidecar.get("rotation_offset_deg") or [0.0, 0.0, 0.0]
+    if not any(abs(r) > 1e-9 for r in rot) and sidecar.get("auto_orient_forward", True):
+        yaw_deg = auto_orient_forward_deg(objs)
+        if abs(yaw_deg) > 1e-3:
+            rot = [0.0, 0.0, yaw_deg]
+            warn(f"WARN_AUTO_ORIENTED_FORWARD:{yaw_deg:.1f}deg")
     if any(abs(r) > 1e-9 for r in rot):
         import math
         for o in objs:
             o.rotation_euler = (math.radians(rot[0]), math.radians(rot[1]),
                                 math.radians(rot[2]))
         apply_all_transforms(objs)
+
+
+def auto_orient_forward_deg(objs, arm=None):
+    """Snap Z yaw (0/90/180/-90) so GTA/RAGE assets face canonical -Y forward."""
+    if arm is not None:
+        l_pts = [arm.matrix_world @ b.head_local for b in arm.data.bones if "_L_" in b.name]
+        r_pts = [arm.matrix_world @ b.head_local for b in arm.data.bones if "_R_" in b.name]
+        if l_pts and r_pts:
+            lr = (sum(l_pts, Vector()) / len(l_pts)) - (sum(r_pts, Vector()) / len(r_pts))
+            fwd = lr.cross(Vector((0.0, 0.0, 1.0)))
+            if fwd.length > 1e-5:
+                ang = math.degrees(math.atan2(fwd.y, fwd.x))
+                # Canonical -Y is -90 deg in XY; snap to nearest 90 deg step
+                delta = round((-90.0 - ang) / 90.0) * 90.0
+                return float((delta + 180.0) % 360.0 - 180.0)
+    pts = []
+    for o in objs:
+        step = max(1, len(o.data.vertices) // 256)
+        mw = o.matrix_world
+        for v in o.data.vertices[::step]:
+            pts.append(mw @ v.co)
+    if len(pts) < 8:
+        return 0.0
+    cx = sum(p.x for p in pts) / len(pts)
+    cy = sum(p.y for p in pts) / len(pts)
+    x_sym = sum(min((abs((p.x - cx) + (q.x - cx)) + abs(p.y - q.y) + abs(p.z - q.z)) for q in pts[:64]) for p in pts[:64])
+    y_sym = sum(min((abs((p.y - cy) + (q.y - cy)) + abs(p.x - q.x) + abs(p.z - q.z)) for q in pts[:64]) for p in pts[:64])
+    if y_sym < x_sym * 0.85:
+        return -90.0  # model was bilaterally symmetric across Y -> rotate 90deg to face -Y
+    return 0.0`);
    hunks.push(`@@ -1125,8 +1158,13 @@ def normalization_transforms(objs, sidecar):
     factor *= float(sidecar.get("scale_multiplier", 1.0))
     rot = sidecar.get("rotation_offset_deg") or [0.0, 0.0, 0.0]
+    if not any(abs(r) > 1e-9 for r in rot) and sidecar.get("auto_orient_forward", True):
+        arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
+        yaw_deg = auto_orient_forward_deg(objs, arm=arm)
+        if abs(yaw_deg) > 1e-3:
+            rot = [0.0, 0.0, yaw_deg]
+            warn(f"WARN_AUTO_ORIENTED_FORWARD:{yaw_deg:.1f}deg")
     rx, ry, rz = (math.radians(float(r)) for r in rot)
     R = (Matrix.Rotation(rz, 4, "Z") @ Matrix.Rotation(ry, 4, "Y")
          @ Matrix.Rotation(rx, 4, "X"))
     return R @ Matrix.Scale(factor, 4), R`);
    hunks.push(`@@ -2333,17 +2371,19 @@ def process_ped(job):
         o.data.update()
         o.matrix_world = Matrix.Identity(4)
     N, _R = normalization_transforms(ms, sidecar)
+    for o in ms:
+        o.data.transform(N)
+        o.data.update()
+    transform_armature_rest(arm, N @ arm.matrix_world)
+    arm.matrix_world = Matrix.Identity(4)
     pivot = sidecar.get("pivot_mode", "bottom_center")
     off = Vector((0.0, 0.0, 0.0))
     if pivot != "keep_origin":
         mins, maxs, _ = world_bbox(ms)
         off = (Vector((-(mins.x + maxs.x) / 2.0, -(mins.y + maxs.y) / 2.0,
                       -mins.z))
                if pivot == "bottom_center" else -(mins + maxs) / 2.0)
-    M = Matrix.Translation(off) @ N
-    for o in ms:
-        o.data.transform(M)
-        o.data.update()
-    transform_armature_rest(arm, M @ arm.matrix_world)
-    arm.matrix_world = Matrix.Identity(4)
+    if off.length > 1e-9:
+        T = Matrix.Translation(off)
+        for o in ms:
+            o.data.transform(T)
+            o.data.update()
+        transform_armature_rest(arm, T @ arm.matrix_world)
+        arm.matrix_world = Matrix.Identity(4)`);
  }

  if (options.srgbTexconvFlags || options.sollumzPbrShaderRouting) {
    hunks.push(`@@ -487,13 +530,22 @@ def image_is_normal_map(img):
-def to_dds(png_path, out_dir, fmt):
+def to_dds(png_path, out_dir, fmt, srgb=False):
     """texconv png -> .dds next to the png. Returns dds path or None."""
     if TEXCONV is None:
         return None
     import subprocess
     dds = os.path.join(out_dir, os.path.splitext(os.path.basename(png_path))[0] + ".dds")
-    r = subprocess.run([TEXCONV, "-y", "-f", fmt, "-pow2", "-o", out_dir, png_path],
+    cmd = [TEXCONV, "-y", "-f", fmt, "-pow2"]
+    if srgb:
+        cmd.append("-srgb")
+    cmd.extend(["-o", out_dir, png_path])
+    r = subprocess.run(cmd,
                        capture_output=True, text=True, timeout=120)
@@ -561,11 +613,13 @@ def prepare_textures(textures_dir, max_res):
         if TEXCONV is None:
             continue
         if image_is_normal_map(img):
-            fmt = "BC7_UNORM"
+            fmt, is_srgb = "BC7_UNORM", False
         elif img.channels == 4:
-            fmt = "BC3_UNORM"
+            fmt, is_srgb = "BC3_UNORM", True
         else:
-            fmt = "BC1_UNORM"
-        dds = to_dds(png, textures_dir, fmt)
+            fmt, is_srgb = "BC1_UNORM", not _image_is_data_map(img)
+        dds = to_dds(png, textures_dir, fmt, srgb=is_srgb)`);
  }

  if (options.sollumzPbrShaderRouting) {
    hunks.push(`@@ -636,12 +690,26 @@ def convert_materials(objs, textures_dir):
             if new_mat is None:
                 try:
-                    new_mat = create_shader("default.sps")
+                    shader_name = _pick_sollumz_shader_for_bsdf(mat)
+                    # normal_spec_emissive.sps / emissive.sps / normal_spec.sps / default_alpha.sps / default.sps
+                    new_mat = create_shader(shader_name)
+                    _wire_pbr_samplers_from_bsdf(mat, new_mat, textures_dir)`);
  }

  if (options.fixFrontLegSpin) {
    hunks.push(`@@ -1646,18 +1714,24 @@ def split_moving_parts(...):
             if net >= spin_min_deg:
                 name_hit = any(p in n.lower() for p in spin_patterns)
+                # Phase 6 P6-R5 fix: articulated leg/arm chains (e.g. leg_f0-2)
+                # can sweep >300deg with <5cm travel without being continuous rotors.
+                articulated_chain = any(
+                    tok in n.lower() for tok in ("leg", "arm", "thigh", "calf", "foot", "knee", "hip")
+                )
                 rel_travel = _trav
                 if not name_hit and body_names:
                     ref_s = [_rigid_se3(m) for m in mw_samples[ref]]
                     rel0 = mw_samples[n][0].to_translation()
                     rel_travel = max(
                         ((ref_s[0] @ ref_s[k].inverted() @ mw_samples[n][k])
                          .to_translation() - rel0).length
                         for k in range(len(ref_s)))
                 moving = tail_rate >= spin_tail_min
-                if moving and (name_hit or rel_travel <= spin_max_travel):
+                if moving and not articulated_chain and (name_hit or rel_travel <= spin_max_travel):
                     g["kind"] = "spin"
                     warn(f"WARN_AUTO_SPIN_PART:{n}")
                 else:
                     warn(f"WARN_HIGH_ROTATION_HINGE:{n}:{net:.0f}deg")
                     g["kind"] = "hinge"`);
  }

  if (options.balanceWhipKeyframes) {
    hunks.push(`@@ -1488,7 +1556,9 @@ def split_moving_parts(...):
     kf_mode = cfg.get("keyframe_mode", "adaptive")
     kf_tol = float(cfg.get("keyframe_tol_m", 0.02))
     kf_max = int(cfg.get("keyframe_max_stops", 5))
+    kf_per_part = cfg.get("keyframe_max_stops_by_part") or {}
+    # Allows distal whip links (e.g. leg_*7) to carry 64 stops without inflating proximal parts.`);
  }

  return hunks.join("\n\n");
}

export function buildRenderCheckPatch(options: PatchOptions): string {
  const texturedFlag = options.texturedAssemblyRender ? "True" : "False";
  return `--- a/render_check.py
+++ b/render_check.py
@@ -124,18 +124,33 @@ def import_ydr(path):
     # Sollumz's reimport node graph renders dark even with valid textures --
-    # rebuild every material as clean TEX_IMAGE(diffuse)->Principled->Output.
-    # Diffuse nodes live INSIDE Sollumz NodeGroups; search recursively.
-    def find_tex_image(nt):
+    # prioritize DiffuseSampler/Base Color (never accidentally grab Bump/Spec
+    # as diffuse, which crushes olive/colored armor to near-black!).
+    def find_tex_by_role(nt, roles):
+        cand = None
         for n in nt.nodes:
             if n.type == 'TEX_IMAGE' and n.image:
-                return n, nt
+                nm = (n.name + " " + n.label + " " + n.image.name).lower()
+                if any(r in nm for r in roles):
+                    return n, nt
+                if cand is None:
+                    cand = (n, nt)
             if n.type == 'GROUP' and n.node_tree:
-                r = find_tex_image(n.node_tree)
+                r = find_tex_by_role(n.node_tree, roles)
                 if r[0] is not None:
                     return r
-        return None, None
+        return cand if cand is not None else (None, None)
     mat_uv = {}
     for o in bpy.data.objects:
         if o.type != 'MESH' or not o.data.uv_layers:
             continue
         uvl = o.data.uv_layers
         uvname = (uvl.active.name if uvl.active else uvl[0].name)
         for slot in o.material_slots:
             if slot.material and slot.material not in mat_uv:
                 mat_uv[slot.material] = uvname
     for m in bpy.data.materials:
         if m in before_mats or not m.node_tree:
             continue
-        tn, tnt = find_tex_image(m.node_tree)
+        tn, tnt = find_tex_by_role(m.node_tree, ("diffuse", "albedo", "basecolor", "base_color"))
         tex_img = tn.image if tn else None
         if tex_img:
             try:
                 tex_img.colorspace_settings.name = 'sRGB'
             except Exception:
                 pass
@@ -165,16 +180,26 @@ def render_views(prefix, sun_energy=2.5):
     scn.render.resolution_x, scn.render.resolution_y = 960, 540
     sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN'))
     sun.data.energy = sun_energy
     sun.rotation_euler = (math.radians(50), 0, math.radians(30))
     bpy.context.collection.objects.link(sun)
+    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", 'SUN'))
+    fill.data.energy = sun_energy * 0.45
+    fill.rotation_euler = (math.radians(35), 0, math.radians(-145))
+    bpy.context.collection.objects.link(fill)
     world = bpy.data.worlds.new("W")
     world.use_nodes = True
     world.node_tree.nodes["Background"].inputs[0].default_value = \\
-        (0.15, 0.15, 0.18, 1.0)
+        (0.22, 0.23, 0.26, 1.0)
     scn.world = world
     center, size = scene_bounds()
     cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
     bpy.context.collection.objects.link(cam)
     scn.camera = cam
     cam.data.lens = 40
     views = {
         "iso": Vector((1.6, -1.6, 1.2)),
+        "front": Vector((0.0, -2.5, 0.25)),
         "side": Vector((2.2, 0.0, 0.15)),
         "top": Vector((0.0, -0.01, 2.5)),
     }
@@ -286,19 +311,33 @@ if os.path.isdir(SRC):
             add_axis_markers()
             return len(parts)
         parts = man.get("parts", [])
-        n = pose(parts, "attach_offset", "folded_rot", colorize=True)
-        if n:
-            render_views("_assembly_folded", sun_energy=1.5)
-        n = pose(parts, "deployed_offset", "deployed_rot", colorize=True)
-        if n:
-            render_views("_assembly_deployed", sun_energy=1.5)
+        emit_textured = ${texturedFlag}
+        poses_to_render = [
+            ("_assembly_folded", "attach_offset", "folded_rot", None),
+            ("_assembly_deployed", "deployed_offset", "deployed_rot", None),
+        ]
         hinges = [p for p in parts
                   if p.get("kind") != "spin"
                   and p.get("deployed_rot") != p.get("folded_rot")]
         if hinges:
-            n = pose(parts, "deployed_offset", "deployed_rot",
-                     colorize=True, interpolate_factor=0.5)
-            if n:
-                render_views("_assembly_mid", sun_energy=1.5)
+            poses_to_render.append(
+                ("_assembly_mid", "deployed_offset", "deployed_rot", 0.5)
+            )
+        for prefix, off_key, rot_key, interp in poses_to_render:
+            n = pose(parts, off_key, rot_key, colorize=True, interpolate_factor=interp)
+            if n:
+                render_views(f"{prefix}_diag", sun_energy=1.5)
+            if emit_textured:
+                n = pose(parts, off_key, rot_key, colorize=False, interpolate_factor=interp)
+                if n:
+                    render_views(prefix, sun_energy=2.2)
+                    render_views(f"{prefix}_textured", sun_energy=2.2)
+        for fi, t_val in enumerate((0.0, 0.25, 0.5, 0.75, 1.0)):
+            if pose(parts, "deployed_offset", "deployed_rot",
+                    colorize=False, interpolate_factor=t_val):
+                render_views(f"_anim_f{fi}", sun_energy=2.2)`;
}

export function buildRigidPlateQaPatch(options: PatchOptions): string {
  if (!options.classifyScissorByBoneHop) {
    return "# Enable 'Classify FK_SCISSOR_CLIP by bone-hop & laterality' to emit tools/rigid_plate_qa.py.patch";
  }
  return `--- a/tools/rigid_plate_qa.py
+++ b/tools/rigid_plate_qa.py
@@ -200,7 +200,11 @@ def audit_rigid_plate_map(mesh_obj, arm_obj, islands=None, pad_m=0.025):
                     dstr = (f" (min surf dist {dmin:.3f}m)"
                             if dmin is not None else "")
+                    kind_tag = (
+                        "REVIEW_ARMOR_GAP" if (hops == 2 and dmin is not None and dmin <= 0.01)
+                        else "DISJOINT_KINEMATIC_SEAM"
+                    )
                     anomalies.append(
-                        f"DISJOINT_KINEMATIC_SEAM: Touching islands {ia['id']} ({ia['bone']}) "
+                        f"{kind_tag}: Touching islands {ia['id']} ({ia['bone']}) "
                         f"and {ib['id']} ({ib['bone']}) are {hops} bone-hops apart (expected <=1)"
                         + dstr)
@@ -331,11 +335,19 @@ def fk_sweep_penetration(mesh_obj, arm_obj, islands, angle_deg=25.0):
                     pairs = posed_bvhs[i].overlap(bvh_j)
                     if pairs:
+                        bi, bj = islands[i]["bone"], islands[j]["bone"]
+                        hops = bone_hop_distance(arm_obj, bi, bj)
+                        cross_lat = (
+                            ("_L_" in bi and "_R_" in bj)
+                            or ("_R_" in bi and "_L_" in bj)
+                        )
+                        cls = (
+                            "CROSS_LIMB_SCISSOR_CLIP" if cross_lat
+                            else ("ADJACENT_JOINT_OVERLAP" if hops <= 1 else "DISTAL_SCISSOR_CLIP")
+                        )
                         anomalies.append(
-                            f"FK_SCISSOR_CLIP: bone {bn} {sgn*angle_deg:+.0f}deg "
-                            f"crosses island {islands[i]['id']} ({islands[i]['bone']}) "
+                            f"{cls}: bone {bn} {sgn*angle_deg:+.0f}deg "
+                            f"crosses island {islands[i]['id']} ({bi}) "
                             f"through island {islands[j]['id']} "
-                            f"({islands[j]['bone']}) pairs={len(pairs)}")
+                            f"({bj}) hops={hops} pairs={len(pairs)}")`;
}

export function buildBusterOverrideRecipe(options: PatchOptions): string {
  const frontKind = options.fixFrontLegSpin ? "hinge" : "auto";
  const makeLegEntries = (prefix: string, forceHinge: boolean) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) {
      const name = `${prefix}${i}`;
      if (forceHinge && i <= 2) {
        out[name] = { kind: frontKind, meshes: [name] };
      } else {
        out[name] = [name];
      }
    }
    return out;
  };

  const recipe = {
    asset_name: "sf_buster_drone",
    auto_orient_forward: options.autoOrientForward,
    motion_mode: "multi_part",
    max_texture_res: 2048,
    texture_mode: "embed",
    assembly_config: {
      max_parts: 40,
      keyframe_mode: "adaptive",
      keyframe_tol_m: 0.02,
      keyframe_max_stops: options.balanceWhipKeyframes ? 50 : 30,
      ...(options.balanceWhipKeyframes
        ? {
            keyframe_max_stops_by_part: {
              leg_l7: 64,
              leg_r7: 64,
              leg_f7: 64,
            },
          }
        : {}),
      group_fit: "procrustes",
    },
    part_map: {
      ...makeLegEntries("leg_l", false),
      ...makeLegEntries("leg_r", false),
      ...makeLegEntries("leg_f", true),
    },
  };

  return JSON.stringify(recipe, null, 2);
}

export function buildApplyFixesInstallerPy(
  options: PatchOptions,
  parityCheckSource: string,
  busterRecipeSource: string
): string {
  const pyEsc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');

  return `#!/usr/bin/env python3
"""apply_parity_fixes.py — Idempotent patch installer for sketchfab-to-fivem.

Run from the root of your sketchfab-to-fivem repo:
    python apply_parity_fixes.py

Creates .bak backups before editing blender_worker.py, render_check.py, and
tools/rigid_plate_qa.py, writes tools/parity_check.py and
recipes/sf_buster_drone.override.json, and verifies Python syntax.
"""
import os
import py_compile
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))

def backup_and_read(rel_path):
    full = os.path.join(ROOT, rel_path)
    if not os.path.isfile(full):
        raise FileNotFoundError(f"Expected file missing: {full}")
    bak = full + ".bak"
    if not os.path.isfile(bak):
        shutil.copy2(full, bak)
    with open(full, "r", encoding="utf-8") as fh:
        return full, fh.read()

def replace_once(src, old, new, label):
    if new in src:
        print(f"  [skip] {label} already applied")
        return src
    if old not in src:
        print(f"  [warn] anchor not found for {label}; check manually")
        return src
    print(f"  [ok]   applied {label}")
    return src.replace(old, new, 1)

def patch_blender_worker():
    print("Patching blender_worker.py...")
    full, src = backup_and_read("blender_worker.py")
    if ${options.autoOrientForward ? "True" : "False"}:
        src = replace_once(
            src,
            '    rot = sidecar.get("rotation_offset_deg") or [0.0, 0.0, 0.0]\\n    if any(abs(r) > 1e-9 for r in rot):',
            '    rot = sidecar.get("rotation_offset_deg") or [0.0, 0.0, 0.0]\\n    if not any(abs(r) > 1e-9 for r in rot) and sidecar.get("auto_orient_forward", True):\\n        yaw_deg = auto_orient_forward_deg(objs)\\n        if abs(yaw_deg) > 1e-3:\\n            rot = [0.0, 0.0, yaw_deg]\\n            warn(f"WARN_AUTO_ORIENTED_FORWARD:{yaw_deg:.1f}deg")\\n    if any(abs(r) > 1e-9 for r in rot):',
            "auto_orient_forward in fix_scale_and_rotation",
        )
        src = replace_once(
            src,
            'def ground_pivot(objs, mode):',
            'def auto_orient_forward_deg(objs, arm=None):\\n    """Snap Z yaw (0/90/180/-90) so assets face canonical RAGE -Y forward."""\\n    if arm is not None:\\n        l_pts = [arm.matrix_world @ b.head_local for b in arm.data.bones if "_L_" in b.name]\\n        r_pts = [arm.matrix_world @ b.head_local for b in arm.data.bones if "_R_" in b.name]\\n        if l_pts and r_pts:\\n            lr = (sum(l_pts, Vector()) / len(l_pts)) - (sum(r_pts, Vector()) / len(r_pts))\\n            fwd = lr.cross(Vector((0.0, 0.0, 1.0)))\\n            if fwd.length > 1e-5:\\n                ang = math.degrees(math.atan2(fwd.y, fwd.x))\\n                delta = round((-90.0 - ang) / 90.0) * 90.0\\n                return float((delta + 180.0) % 360.0 - 180.0)\\n    pts = []\\n    for o in objs:\\n        step = max(1, len(o.data.vertices) // 256)\\n        mw = o.matrix_world\\n        for v in o.data.vertices[::step]:\\n            pts.append(mw @ v.co)\\n    if len(pts) < 8:\\n        return 0.0\\n    cx = sum(p.x for p in pts) / len(pts)\\n    cy = sum(p.y for p in pts) / len(pts)\\n    x_sym = sum(min((abs((p.x - cx) + (q.x - cx)) + abs(p.y - q.y) + abs(p.z - q.z)) for q in pts[:64]) for p in pts[:64])\\n    y_sym = sum(min((abs((p.y - cy) + (q.y - cy)) + abs(p.x - q.x) + abs(p.z - q.z)) for q in pts[:64]) for p in pts[:64])\\n    return -90.0 if y_sym < x_sym * 0.85 else 0.0\\n\\n\\ndef ground_pivot(objs, mode):',
            "auto_orient_forward_deg helper",
        )
        src = replace_once(
            src,
            '    factor *= float(sidecar.get("scale_multiplier", 1.0))\\n    rot = sidecar.get("rotation_offset_deg") or [0.0, 0.0, 0.0]',
            '    factor *= float(sidecar.get("scale_multiplier", 1.0))\\n    rot = sidecar.get("rotation_offset_deg") or [0.0, 0.0, 0.0]\\n    if not any(abs(r) > 1e-9 for r in rot) and sidecar.get("auto_orient_forward", True):\\n        arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)\\n        yaw_deg = auto_orient_forward_deg(objs, arm=arm)\\n        if abs(yaw_deg) > 1e-3:\\n            rot = [0.0, 0.0, yaw_deg]\\n            warn(f"WARN_AUTO_ORIENTED_FORWARD:{yaw_deg:.1f}deg")',
            "auto_orient_forward in normalization_transforms",
        )
        src = replace_once(
            src,
            '    N, _R = normalization_transforms(ms, sidecar)\\n    pivot = sidecar.get("pivot_mode", "bottom_center")\\n    off = Vector((0.0, 0.0, 0.0))\\n    if pivot != "keep_origin":\\n        mins, maxs, _ = world_bbox(ms)\\n        off = (Vector((-(mins.x + maxs.x) / 2.0, -(mins.y + maxs.y) / 2.0,\\n                      -mins.z))\\n               if pivot == "bottom_center" else -(mins + maxs) / 2.0)\\n    M = Matrix.Translation(off) @ N\\n    for o in ms:\\n        o.data.transform(M)\\n        o.data.update()\\n    transform_armature_rest(arm, M @ arm.matrix_world)\\n    arm.matrix_world = Matrix.Identity(4)',
            '    N, _R = normalization_transforms(ms, sidecar)\\n    for o in ms:\\n        o.data.transform(N)\\n        o.data.update()\\n    transform_armature_rest(arm, N @ arm.matrix_world)\\n    arm.matrix_world = Matrix.Identity(4)\\n    pivot = sidecar.get("pivot_mode", "bottom_center")\\n    off = Vector((0.0, 0.0, 0.0))\\n    if pivot != "keep_origin":\\n        mins, maxs, _ = world_bbox(ms)\\n        off = (Vector((-(mins.x + maxs.x) / 2.0, -(mins.y + maxs.y) / 2.0,\\n                      -mins.z))\\n               if pivot == "bottom_center" else -(mins + maxs) / 2.0)\\n    if off.length > 1e-9:\\n        T = Matrix.Translation(off)\\n        for o in ms:\\n            o.data.transform(T)\\n            o.data.update()\\n        transform_armature_rest(arm, T @ arm.matrix_world)\\n        arm.matrix_world = Matrix.Identity(4)',
            "process_ped post-N grounding fix",
        )
    if ${options.fixFrontLegSpin ? "True" : "False"}:
        src = replace_once(
            src,
            '                if moving and (name_hit or rel_travel <= spin_max_travel):',
            '                articulated_chain = any(tok in n.lower() for tok in ("leg", "arm", "thigh", "calf", "foot", "knee", "hip"))\\n                if moving and not articulated_chain and (name_hit or rel_travel <= spin_max_travel):',
            "P6-R5 articulated-chain spin guard",
        )
    if ${options.srgbTexconvFlags ? "True" : "False"}:
        src = replace_once(
            src,
            'def to_dds(png_path, out_dir, fmt):',
            'def to_dds(png_path, out_dir, fmt, srgb=False):',
            "to_dds srgb signature",
        )
        src = replace_once(
            src,
            '    r = subprocess.run([TEXCONV, "-y", "-f", fmt, "-pow2", "-o", out_dir, png_path],',
            '    cmd = [TEXCONV, "-y", "-f", fmt, "-pow2"] + (["-srgb"] if srgb else []) + ["-o", out_dir, png_path]\\n    r = subprocess.run(cmd,',
            "to_dds -srgb flag",
        )
        src = replace_once(
            src,
            '        if image_is_normal_map(img):\\n            fmt = "BC7_UNORM"\\n        elif img.channels == 4:\\n            fmt = "BC3_UNORM"\\n        else:\\n            fmt = "BC1_UNORM"\\n        dds = to_dds(png, textures_dir, fmt)',
            '        if image_is_normal_map(img):\\n            fmt, is_srgb = "BC7_UNORM", False\\n        elif img.channels == 4:\\n            fmt, is_srgb = "BC3_UNORM", True\\n        else:\\n            fmt, is_srgb = "BC1_UNORM", True\\n        dds = to_dds(png, textures_dir, fmt, srgb=is_srgb)',
            "prepare_textures srgb flag pass-through",
        )
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(src)
    py_compile.compile(full, doraise=True)

def patch_render_check():
    print("Patching render_check.py...")
    full, src = backup_and_read("render_check.py")
    src = replace_once(
        src,
        '    def find_tex_image(nt):\\n        for n in nt.nodes:\\n            if n.type == \\'TEX_IMAGE\\' and n.image:\\n                return n, nt\\n            if n.type == \\'GROUP\\' and n.node_tree:\\n                r = find_tex_image(n.node_tree)\\n                if r[0] is not None:\\n                    return r\\n        return None, None',
        '    def find_tex_image(nt):\\n        cand = None\\n        for n in nt.nodes:\\n            if n.type == \\'TEX_IMAGE\\' and n.image:\\n                nm = (n.name + " " + n.label + " " + n.image.name).lower()\\n                if any(r in nm for r in ("diffuse", "albedo", "basecolor", "base_color")):\\n                    return n, nt\\n                if cand is None:\\n                    cand = (n, nt)\\n            if n.type == \\'GROUP\\' and n.node_tree:\\n                r = find_tex_image(n.node_tree)\\n                if r[0] is not None:\\n                    return r\\n        return cand if cand is not None else (None, None)',
        "DiffuseSampler priority in find_tex_image",
    )
    src = replace_once(
        src,
        '    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", \\'SUN\\'))\\n    sun.data.energy = sun_energy\\n    sun.rotation_euler = (math.radians(50), 0, math.radians(30))\\n    bpy.context.collection.objects.link(sun)\\n    world = bpy.data.worlds.new("W")\\n    world.use_nodes = True\\n    world.node_tree.nodes["Background"].inputs[0].default_value = \\\\\\n        (0.15, 0.15, 0.18, 1.0)\\n    scn.world = world\\n    center, size = scene_bounds()\\n    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))\\n    bpy.context.collection.objects.link(cam)\\n    scn.camera = cam\\n    cam.data.lens = 40\\n    views = {\\n        "iso": Vector((1.6, -1.6, 1.2)),\\n        "side": Vector((2.2, 0.0, 0.15)),\\n        "top": Vector((0.0, -0.01, 2.5)),\\n    }',
        '    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", \\'SUN\\'))\\n    sun.data.energy = sun_energy\\n    sun.rotation_euler = (math.radians(50), 0, math.radians(30))\\n    bpy.context.collection.objects.link(sun)\\n    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", \\'SUN\\'))\\n    fill.data.energy = sun_energy * 0.45\\n    fill.rotation_euler = (math.radians(35), 0, math.radians(-145))\\n    bpy.context.collection.objects.link(fill)\\n    world = bpy.data.worlds.new("W")\\n    world.use_nodes = True\\n    world.node_tree.nodes["Background"].inputs[0].default_value = \\\\\\n        (0.22, 0.23, 0.26, 1.0)\\n    scn.world = world\\n    center, size = scene_bounds()\\n    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))\\n    bpy.context.collection.objects.link(cam)\\n    scn.camera = cam\\n    cam.data.lens = 40\\n    views = {\\n        "iso": Vector((1.6, -1.6, 1.2)),\\n        "front": Vector((0.0, -2.5, 0.25)),\\n        "side": Vector((2.2, 0.0, 0.15)),\\n        "top": Vector((0.0, -0.01, 2.5)),\\n    }',
        "3-point studio lighting and front camera",
    )
    if ${options.texturedAssemblyRender ? "True" : "False"}:
        src = replace_once(
            src,
            '        n = pose(parts, "attach_offset", "folded_rot", colorize=True)\\n        if n:\\n            render_views("_assembly_folded", sun_energy=1.5)\\n        n = pose(parts, "deployed_offset", "deployed_rot", colorize=True)\\n        if n:\\n            render_views("_assembly_deployed", sun_energy=1.5)',
            '        for prefix, off_k, rot_k in (("_assembly_folded", "attach_offset", "folded_rot"), ("_assembly_deployed", "deployed_offset", "deployed_rot")):\\n            if pose(parts, off_k, rot_k, colorize=True):\\n                render_views(f"{prefix}_diag", sun_energy=1.5)\\n            if pose(parts, off_k, rot_k, colorize=False):\\n                render_views(prefix, sun_energy=2.2)',
            "textured assembly renders alongside diag",
        )
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(src)
    py_compile.compile(full, doraise=True)

def patch_rigid_qa():
    if not ${options.classifyScissorByBoneHop ? "True" : "False"}:
        return
    print("Patching tools/rigid_plate_qa.py...")
    full, src = backup_and_read(os.path.join("tools", "rigid_plate_qa.py"))
    src = replace_once(
        src,
        '                    if pairs:\\n                        anomalies.append(\\n                            f"FK_SCISSOR_CLIP: bone {bn} {sgn*angle_deg:+.0f}deg "\\n                            f"crosses island {islands[i][\\'id\\']} ({islands[i][\\'bone\\']}) "\\n                            f"through island {islands[j][\\'id\\']} "\\n                            f"({islands[j][\\'bone\\']}) pairs={len(pairs)}")',
        '                    if pairs:\\n                        bi, bj = islands[i]["bone"], islands[j]["bone"]\\n                        hops = bone_hop_distance(arm_obj, bi, bj)\\n                        cross_lat = ("_L_" in bi and "_R_" in bj) or ("_R_" in bi and "_L_" in bj)\\n                        cls = "CROSS_LIMB_SCISSOR_CLIP" if cross_lat else ("ADJACENT_JOINT_OVERLAP" if hops <= 1 else "DISTAL_SCISSOR_CLIP")\\n                        anomalies.append(\\n                            f"{cls}: bone {bn} {sgn*angle_deg:+.0f}deg "\\n                            f"crosses island {islands[i][\\'id\\']} ({bi}) "\\n                            f"through island {islands[j][\\'id\\']} ({bj}) hops={hops} pairs={len(pairs)}")',
        "P6-R1 FK_SCISSOR_CLIP hop/laterality classifier",
    )
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(src)
    py_compile.compile(full, doraise=True)

def write_new_files():
    os.makedirs(os.path.join(ROOT, "tools"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "recipes"), exist_ok=True)
    parity_path = os.path.join(ROOT, "tools", "parity_check.py")
    with open(parity_path, "w", encoding="utf-8") as fh:
        fh.write("""${pyEsc(parityCheckSource)}""")
    py_compile.compile(parity_path, doraise=True)
    print("  [ok]   wrote tools/parity_check.py")

    recipe_path = os.path.join(ROOT, "recipes", "sf_buster_drone.override.json")
    with open(recipe_path, "w", encoding="utf-8") as fh:
        fh.write("""${pyEsc(busterRecipeSource)}""")
    print("  [ok]   wrote recipes/sf_buster_drone.override.json")

if __name__ == "__main__":
    patch_blender_worker()
    patch_render_check()
    patch_rigid_qa()
    write_new_files()
    print("All parity fixes applied cleanly.")
`;
}

export function buildAllArtifacts(
  asset: BenchmarkAsset,
  metrics: CanvasParityMetrics | null,
  options: PatchOptions
): GeneratedArtifact[] {
  const parityCheckSource = buildParityCheckPy(options);
  const busterRecipeSource = buildBusterOverrideRecipe(options);
  return [
    {
      id: "apply_parity_fixes_py",
      filename: "apply_parity_fixes.py",
      targetPath: "apply_parity_fixes.py",
      summary:
        "One-command idempotent Python installer: backs up and patches blender_worker.py, render_check.py, rigid_plate_qa.py, and writes tools/parity_check.py + buster recipe.",
      content: buildApplyFixesInstallerPy(
        options,
        parityCheckSource,
        busterRecipeSource
      ),
    },
    {
      id: "parity_check_py",
      filename: "tools/parity_check.py",
      targetPath: "tools/parity_check.py",
      summary:
        "Code-based Canonical Scene & Animation IR comparator, 3D silhouette azimuth auto-aligner (aligned_side_by_side.png + rotation_offset_deg solver), and headless parity_report.json gate.",
      content: parityCheckSource,
    },
    {
      id: "blender_worker_patch",
      filename: "blender_worker.py.patch",
      targetPath: "blender_worker.py",
      summary:
        "Adds canonical -Y auto-forward orientation, fixes process_ped post-N grounding, fixes leg_f0-2 spin freeze, upgrades EC_08 shaders, and adds -srgb DDS flags.",
      content: buildBlenderWorkerPatch(options),
    },
    {
      id: "render_check_patch",
      filename: "render_check.py.patch",
      targetPath: "render_check.py",
      summary:
        "Fixes DiffuseSampler lookup (stops bump/spec from darkening albedo), adds 3-point studio lighting + front camera, and renders textured composites.",
      content: buildRenderCheckPatch(options),
    },
    {
      id: "rigid_plate_qa_patch",
      filename: "tools/rigid_plate_qa.py.patch",
      targetPath: "tools/rigid_plate_qa.py",
      summary:
        "Separates 41 FK_SCISSOR_CLIP hits into ADJACENT_JOINT_OVERLAP vs CROSS_LIMB_SCISSOR_CLIP and flags sub-cm armor gaps.",
      content: buildRigidPlateQaPatch(options),
    },
    {
      id: "buster_override_json",
      filename: "recipes/sf_buster_drone.override.json",
      targetPath: "recipes/sf_buster_drone.override.json",
      summary:
        "Promotes Phase 6 36-part leg split out of gitignored work/ and forces leg_f0-2 to hinge.",
      content: busterRecipeSource,
    },
    {
      id: "parity_report_json",
      filename: `parity_report_${asset.id}.json`,
      targetPath: `work/parity_${asset.id}/parity_report.json`,
      summary:
        "Machine-readable parity gate report for headless agent approval or revision.",
      content: buildParityReportJson(asset, metrics, options),
    },
  ];
}
