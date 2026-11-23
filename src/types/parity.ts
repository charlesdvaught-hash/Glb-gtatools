export type AssetId =
  | "buster_drone"
  | "military_mech"
  | "robot_humanoid"
  | "police_drone";

export type CompareMode = "side-by-side" | "split" | "heatmap" | "edges";

export interface ExportRenderOption {
  id: string;
  label: string;
  t: number;
  repoPath: string;
  isDiagnosticColorized: boolean;
  notes: string;
}

export interface CanonicalPartDiff {
  partName: string;
  sourceClass: "hinge" | "spin" | "rigid_bone" | "static";
  exportClass: "hinge" | "spin" | "rigid_bone" | "static";
  keyframes: number;
  pass3bErrM: number;
  pass4WorstProbeM: number;
  materialShader: string;
  status: "MATCH" | "MISMATCH" | "STARVED";
  issueSummary: string;
}

export interface BenchmarkAsset {
  id: AssetId;
  name: string;
  assetType: "prop" | "ped";
  partCount: number;
  keyframeRange: string;
  referenceRepoPath: string;
  exportRenders: ExportRenderOption[];
  pass3bSummary: string;
  pass4Summary: string;
  qaSummary: string;
  visualParityBlocker: string;
  canonicalParts: CanonicalPartDiff[];
}

export interface Phase6Finding {
  id: string;
  claim: string;
  evidence: string;
  confidence: number;
}

export interface Phase6RemainingIssue {
  id: string;
  severity: "HIGH" | "MEDIUM" | "LOW" | "INFO";
  area: string;
  issue: string;
  suggestedFix: string;
  targetFile: string;
  fixOptionKey?: keyof PatchOptions;
}

export interface PatchOptions {
  autoOrientForward: boolean;
  fixFrontLegSpin: boolean;
  balanceWhipKeyframes: boolean;
  sollumzPbrShaderRouting: boolean;
  srgbTexconvFlags: boolean;
  texturedAssemblyRender: boolean;
  classifyScissorByBoneHop: boolean;
  emitParityIrGate: boolean;
}

export interface PaletteSwatch {
  hex: string;
  pct: number;
}

export interface AlignmentTelemetry {
  applied: boolean;
  scaleFactor: number;
  shiftX: number;
  shiftY: number;
  oppositeViewDetected: boolean;
  flipXApplied: boolean;
  flipIoUGainPct: number;
  rawSilhouetteIoUPct: number;
  rawRmsePct: number;
  diagnosticNote: string;
}

export interface CanvasParityMetrics {
  width: number;
  height: number;
  maePct: number;
  rmsePct: number;
  silhouetteIoUPct: number;
  edgeOverlapPct: number;
  lumaDelta: number;
  refPalette: PaletteSwatch[];
  expPalette: PaletteSwatch[];
  alignment: AlignmentTelemetry;
  verdict: "PASS" | "REVIEW" | "FAIL";
  verdictReason: string;
}

export interface AiParityVerdict {
  verdict: "PASS" | "NEEDS_FIX" | "FAIL";
  summary: string;
  poseDeltas: string[];
  materialDeltas: string[];
  lightingDeltas: string[];
  recommendedFixes: string[];
}

export interface FramePair {
  t: number;
  label: string;
  refDataUrl: string;
  expDataUrl: string;
}
