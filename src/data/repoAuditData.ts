import type {
  BenchmarkAsset,
  PatchOptions,
  Phase6Finding,
  Phase6RemainingIssue,
} from "../types/parity";

export const DEFAULT_PATCH_OPTIONS: PatchOptions = {
  autoOrientForward: true,
  fixFrontLegSpin: true,
  balanceWhipKeyframes: true,
  sollumzPbrShaderRouting: true,
  srgbTexconvFlags: true,
  texturedAssemblyRender: true,
  classifyScissorByBoneHop: true,
  emitParityIrGate: true,
};

export const BENCHMARK_ASSETS: BenchmarkAsset[] = [
  {
    id: "buster_drone",
    name: "sf_buster_drone",
    assetType: "prop",
    partCount: 36,
    keyframeRange: "0 (spin) to 50 (distal whip)",
    referenceRepoPath: "testing/REFERENCE_buster.jpg",
    pass3bSummary: "all 36 parts <= 0.0001 m",
    pass4Summary: "worst probe 0.0214 m (0 EXCEEDS > 0.03 m)",
    qaSummary: "WARN_NONRIGID_CHAIN = 0 on legs; leg_f0-2 flagged WARN_AUTO_SPIN_PART",
    visualParityBlocker:
      "render_check.py paints flat pastel colors (colorize=True), and leg_f0-2 are auto-classified as spin so they stay frozen in folded pose during deployment.",
    exportRenders: [
      {
        id: "phase6_deployed",
        label: "Deployed (Phase 6)",
        t: 1.0,
        repoPath: "testing/buster_PHASE6_deployed_iso.png",
        isDiagnosticColorized: true,
        notes:
          "36-part full leg split at 50 stops; diagnostic pastel materials hide PBR textures, and leg_f0-2 spin classification freezes front legs.",
      },
      {
        id: "phase6_mid",
        label: "Mid-Pose (t=0.5)",
        t: 0.5,
        repoPath: "testing/buster_PHASE6_mid_iso.png",
        isDiagnosticColorized: true,
        notes: "Piecewise lerp+slerp across 50-stop RDP track; worst probe 0.0214 m.",
      },
      {
        id: "phase6_folded",
        label: "Folded (t=0.0)",
        t: 0.0,
        repoPath: "testing/buster_PHASE6_folded_iso.png",
        isDiagnosticColorized: true,
        notes: "Folded rest pose matches Contract A (PASS3b <= 0.0001 m).",
      },
      {
        id: "final_deployed",
        label: "5-Part FINAL Deployed",
        t: 1.0,
        repoPath: "testing/buster_FINAL_deployed_iso.png",
        isDiagnosticColorized: true,
        notes: "Earlier 5-part assembly render (still colorize=True pastel diagnostic shading).",
      },
      {
        id: "final_folded",
        label: "5-Part FINAL Folded",
        t: 0.0,
        repoPath: "testing/buster_FINAL_folded_iso.png",
        isDiagnosticColorized: true,
        notes: "Earlier 5-part folded diagnostic render.",
      },
      {
        id: "part_body_ydr",
        label: "Body Part (.ydr)",
        t: 0.0,
        repoPath: "testing/sf_sf_buster_drone2_body_iso.png",
        isDiagnosticColorized: false,
        notes: "Single-part .ydr render (colorize=False); dark albedo shows Sollumz node-group/sRGB issue.",
      },
    ],
    canonicalParts: [
      {
        partName: "body",
        sourceClass: "static",
        exportClass: "static",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "default.sps (missing normal/emissive)",
        status: "MISMATCH",
        issueSummary:
          "Diagnostic render strips textures; export shader drops normal/spec & glowing optics.",
      },
      {
        partName: "leg_f0 / leg_f1 / leg_f2",
        sourceClass: "hinge",
        exportClass: "spin",
        keyframes: 0,
        pass3bErrM: 0.0001,
        pass4WorstProbeM: 0.0,
        materialShader: "default.sps",
        status: "MISMATCH",
        issueSummary:
          "WARN_AUTO_SPIN_PART (>300 deg rotation, <5 cm travel) freezes front legs at folded_rot during deploy.",
      },
      {
        partName: "leg_l0..l4 / leg_r0..r4",
        sourceClass: "hinge",
        exportClass: "hinge",
        keyframes: 26,
        pass3bErrM: 0.0001,
        pass4WorstProbeM: 0.0146,
        materialShader: "default.sps",
        status: "MATCH",
        issueSummary: "Single-member split resolved PASS3c and PASS4 residuals.",
      },
      {
        partName: "leg_l7 / leg_r7 / leg_f7",
        sourceClass: "hinge",
        exportClass: "hinge",
        keyframes: 50,
        pass3bErrM: 0.0001,
        pass4WorstProbeM: 0.0214,
        materialShader: "default.sps",
        status: "STARVED",
        issueSummary:
          "Distal whip links saturate keyframe_max_stops=50 cap; convergence is marginal.",
      },
      {
        partName: "rotor_0 / rotor_1",
        sourceClass: "spin",
        exportClass: "spin",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "default.sps",
        status: "MATCH",
        issueSummary: "True continuous spin rotors with valid hub pivot.",
      },
    ],
  },
  {
    id: "military_mech",
    name: "sf_sf_military_mech",
    assetType: "ped",
    partCount: 1,
    keyframeRange: "Skinned .ydd (rigged ped)",
    referenceRepoPath: "testing/REFERENCE_mech.jpg",
    pass3bSummary: "N/A (ped .ydd)",
    pass4Summary: "FK sweep +-25 deg: FK_PENETRATION = 0",
    qaSummary: "41 FK_SCISSOR_CLIP (pairs=1..16); 2 DISJOINT_KINEMATIC_SEAM (4-7mm)",
    visualParityBlocker:
      "Exports appear near-black and mirrored/mis-faced: render_check.py grabs the first TEX_IMAGE node (bump/spec instead of DiffuseSampler), process_ped computes grounding before rotation_offset_deg, and models lack canonical -Y forward normalization.",
    exportRenders: [
      {
        id: "mech_ped_iso",
        label: "Ped Export (.ydd)",
        t: 0.0,
        repoPath: "testing/mech_PED_iso.png",
        isDiagnosticColorized: false,
        notes:
          "Appears near-black vs olive-drab REFERENCE_mech.jpg and viewed from opposite side; rigid_plate_qa flags 41 scissor clips and 2 shoulder seams.",
      },
      {
        id: "mech_src_000",
        label: "Source 000°",
        t: 0.0,
        repoPath: "testing/military_mech_000.png",
        isDiagnosticColorized: false,
        notes: "Source turntable render at 0 deg azimuth.",
      },
      {
        id: "mech_src_045",
        label: "Source 045°",
        t: 0.0,
        repoPath: "testing/military_mech_045.png",
        isDiagnosticColorized: false,
        notes: "Source turntable render at 45 deg azimuth (matches Reference angle, mirrored/opposite of PED iso).",
      },
      {
        id: "mech_src_090",
        label: "Source 090°",
        t: 0.0,
        repoPath: "testing/military_mech_090.png",
        isDiagnosticColorized: false,
        notes: "Source turntable render at 90 deg profile.",
      },
    ],
    canonicalParts: [
      {
        partName: "facing_direction (-Y forward)",
        sourceClass: "static",
        exportClass: "static",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "SKEL_L/R cross-product check",
        status: "MISMATCH",
        issueSummary:
          "process_ped grounds before applying N and never auto-aligns armature forward vector to canonical RAGE -Y.",
      },
      {
        partName: "SKEL_Pelvis / Cube.006",
        sourceClass: "rigid_bone",
        exportClass: "rigid_bone",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "ped_default.sps",
        status: "MATCH",
        issueSummary: "Midline groin cluster relocked from SKEL_R_Thigh to SKEL_Pelvis.",
      },
      {
        partName: "SKEL_L_Foot vs SKEL_R_Foot (islands 20/22 vs 761..764)",
        sourceClass: "rigid_bone",
        exportClass: "rigid_bone",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "ped_default.sps",
        status: "MISMATCH",
        issueSummary:
          "Cross-limb FK_SCISSOR_CLIP (pairs=1..5) indicates rest-pose stance width overlap, not normal joint articulation.",
      },
      {
        partName: "SKEL_R_UpperArm (503/504) vs SKEL_Spine3 (584)",
        sourceClass: "rigid_bone",
        exportClass: "rigid_bone",
        keyframes: 0,
        pass3bErrM: 0.007,
        pass4WorstProbeM: 0.0,
        materialShader: "ped_default.sps",
        status: "MISMATCH",
        issueSummary:
          "2 genuine DISJOINT_KINEMATIC_SEAM hits (min surf dist 0.004-0.007 m, 2 bone-hops) — floating shoulder pauldron.",
      },
    ],
  },
  {
    id: "police_drone",
    name: "sf_police_drone",
    assetType: "prop",
    partCount: 5,
    keyframeRange: "Static/diagnostic render",
    referenceRepoPath: "testing/REFERENCE_police.jpg",
    pass3bSummary: "<= 0.0001 m",
    pass4Summary: "N/A",
    qaSummary: "Textured decals present; emissive blue lens glow dropped in shader conversion",
    visualParityBlocker:
      "convert_materials falls back to diffuse-only default.sps, dropping the bright emissive blue camera lens glow visible in REFERENCE_police.jpg.",
    exportRenders: [
      {
        id: "police_iso",
        label: "Export Render (Iso)",
        t: 0.0,
        repoPath: "testing/police_drone_iso.png",
        isDiagnosticColorized: false,
        notes:
          "POLICE RECON decals and red ring present; missing emissive shader routing for blue lens glow.",
      },
      {
        id: "police_side",
        label: "Export Render (Side)",
        t: 0.0,
        repoPath: "testing/police_drone_side.png",
        isDiagnosticColorized: false,
        notes: "Side profile geometry and whip antenna verified.",
      },
    ],
    canonicalParts: [
      {
        partName: "hull + decals",
        sourceClass: "static",
        exportClass: "static",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "default.sps",
        status: "MATCH",
        issueSummary: "UVMap 0 decals and white/black hull albedo match reference.",
      },
      {
        partName: "optics_lens_emissive",
        sourceClass: "static",
        exportClass: "static",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "default.sps (should be emissive.sps / normal_spec_emissive.sps)",
        status: "MISMATCH",
        issueSummary:
          "Source Principled BSDF Emission Strength > 0 is ignored by EC_08 fallback shader creation.",
      },
    ],
  },
  {
    id: "robot_humanoid",
    name: "sf_sf_robot_humanoid",
    assetType: "prop",
    partCount: 1,
    keyframeRange: "Static prop",
    referenceRepoPath: "testing/REFERENCE_humanoid.jpg",
    pass3bSummary: "<= 0.0001 m",
    pass4Summary: "N/A",
    qaSummary: "WARN_UV_RESCUE_EMPTY verified; UV range 0.028-0.974",
    visualParityBlocker:
      "Albedo & UV rescue fixed grey-mesh issue; remaining gap is specular/roughness & sRGB calibration vs Sketchfab studio PBR shading.",
    exportRenders: [
      {
        id: "humanoid_textured",
        label: "Textured Export",
        t: 0.0,
        repoPath: "testing/humanoid_FIXED_textured.png",
        isDiagnosticColorized: false,
        notes: "Red/white armor atlas + decals rescued via UVMap 0.",
      },
      {
        id: "humanoid_side",
        label: "Side View",
        t: 0.0,
        repoPath: "testing/humanoid_FIXED_side.png",
        isDiagnosticColorized: false,
        notes: "Symmetry and T-pose proportions verified.",
      },
      {
        id: "humanoid_prefix_iso",
        label: "Pre-Fix Grey (.ydr)",
        t: 0.0,
        repoPath: "testing/sf_sf_robot_humanoid_iso.png",
        isDiagnosticColorized: false,
        notes: "Original grey export prior to UVMap 0 rescue (shows empty UV shell bug).",
      },
    ],
    canonicalParts: [
      {
        partName: "humanoid_body",
        sourceClass: "static",
        exportClass: "static",
        keyframes: 0,
        pass3bErrM: 0.0,
        pass4WorstProbeM: 0.0,
        materialShader: "default.sps (needs normal_spec.sps + sRGB flag)",
        status: "MATCH",
        issueSummary:
          "UVMap 0 rescue fixed albedo; adding normal/specular routing improves Sketchfab metallic highlight parity.",
      },
    ],
  },
];

export const PHASE6_FINDINGS: Phase6Finding[] = [
  {
    id: "P6-F1",
    claim:
      "R-01 resolution required FULL per-member splits, not 2-way/3-way. Only single-member groups make PASS3c vacuous and PASS4 worst <= 0.0214 m.",
    evidence:
      "PASS4 worst progression 0.064 (2-way) -> 0.027 proximal-only -> 0.0467 (per-member distal, 30 stops) -> 0.0214 (per-member all, 50 stops).",
    confidence: 0.99,
  },
  {
    id: "P6-F2",
    claim:
      "Distal whip links are keyframe-starvation limited, not split limited. At keyframe_max_stops=50 all probes <= 0.0214 m, though terminal links still hit the cap.",
    evidence:
      "leg_l7/leg_r7/leg_f7 all emitted exactly 50 keyframes; EXCEEDS count dropped 86 -> 17 -> 0.",
    confidence: 0.98,
  },
  {
    id: "P6-F3",
    claim:
      "R-05 BVH seam filter achieved a 60x false-positive reduction with zero loss of true positives: 121 -> 2 seams.",
    evidence:
      "tools/rigid_plate_qa.py _islands_close: >= 2 of <= 32 sampled verts within threshold via BVHTree.find_nearest.",
    confidence: 0.97,
  },
  {
    id: "P6-F4",
    claim:
      "R-02 pair counts rank the 41 scissor clips cleanly: parent/child joint overlaps carry pairs=1-16; foot-vs-foot cross-limb clips carry pairs=1-5.",
    evidence: "FK_SCISSOR_CLIP lines suffix pairs=N from BVHTree.overlap tri-tri count.",
    confidence: 0.95,
  },
  {
    id: "P6-F5",
    claim:
      "PASS4 now prefers emitted chained 'quat' over euler 'rot' reconstruction, eliminating >180 deg euler branch-hopping risk.",
    evidence: "tools/diagnose_trs.py predict_pose uses Quaternion(k['quat']).",
    confidence: 0.9,
  },
];

export const PHASE6_REMAINING_ISSUES: Phase6RemainingIssue[] = [
  {
    id: "P6-EXT1",
    severity: "HIGH",
    area: "Canonical Forward Facing (-Y) & Ped Grounding",
    issue:
      "Models export facing different directions (+Y/+X/-Y) because EC_05 never aligns armature L/R or bilateral symmetry to RAGE -Y forward, and process_ped computes grounding before N.",
    suggestedFix:
      "Add auto_orient_forward_deg() in blender_worker.py (using SKEL_L/R cross-product for peds and symmetry plane for props) and apply N before grounding.",
    targetFile: "blender_worker.py",
    fixOptionKey: "autoOrientForward",
  },
  {
    id: "P6-R4",
    severity: "HIGH",
    area: "render_check & Visual Parity",
    issue:
      "Assembly composites render with colorize=True (flat pastel debug colors) and no automated comparison exists against testing/REFERENCE_*.jpg.",
    suggestedFix:
      "Emit _assembly_{pose}_textured.png alongside _diag.png, capture multi-frame strips, and gate via Canonical IR + reference parity.",
    targetFile: "render_check.py",
    fixOptionKey: "texturedAssemblyRender",
  },
  {
    id: "P6-R5",
    severity: "HIGH",
    area: "Articulation Classification (leg_f0-2)",
    issue:
      "leg_f0/leg_f1/leg_f2 auto-classified as spin (WARN_AUTO_SPIN_PART), freezing front legs at folded_rot during deployment.",
    suggestedFix:
      "Guard auto-spin when a part belongs to a segmented chain or lacks spin-hub semantics, and override leg_f0-2 to hinge in sf_buster_drone.override.json.",
    targetFile: "blender_worker.py",
    fixOptionKey: "fixFrontLegSpin",
  },
  {
    id: "P6-R1",
    severity: "MEDIUM",
    area: "Mech QA (FK_SCISSOR_CLIP)",
    issue:
      "41 scissor clips remain unclassified: adjacent parent/child joint overlaps hide suspicious cross-limb SKEL_L_Foot vs SKEL_R_Foot clips.",
    suggestedFix:
      "Classify by bone-hop distance + L/R laterality in rigid_plate_qa.py so cross-limb stance clips fail/warn separately from 1-hop joints.",
    targetFile: "tools/rigid_plate_qa.py",
    fixOptionKey: "classifyScissorByBoneHop",
  },
  {
    id: "P6-R3",
    severity: "LOW",
    area: "Export Budget & Committed Recipe",
    issue:
      "36-part recipe lived only in gitignored work/rb_buster/override.json, and whip links saturate keyframe_max_stops=50.",
    suggestedFix:
      "Commit recipes/sf_buster_drone.override.json and allocate keyframe_max_stops per part topology instead of a flat global cap.",
    targetFile: "blender_worker.py",
    fixOptionKey: "balanceWhipKeyframes",
  },
  {
    id: "P6-R2",
    severity: "LOW",
    area: "Mech Shoulder Seam",
    issue:
      "2 remaining seams: SKEL_R_UpperArm islands 503/504 vs SKEL_Spine3 island 584 at 0.004-0.007 m (floating shoulder pauldron).",
    suggestedFix:
      "Flag 2-hop sub-centimeter armor gaps explicitly as REVIEW_ARMOR_GAP rather than mixing with severe rigging errors.",
    targetFile: "tools/rigid_plate_qa.py",
    fixOptionKey: "classifyScissorByBoneHop",
  },
];
