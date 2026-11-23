import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  RotateCcw,
  Sparkles,
  Upload,
} from "lucide-react";
import type {
  AiParityVerdict,
  BenchmarkAsset,
  CanvasParityMetrics,
  CompareMode,
} from "../types/parity";
import {
  extractFramesFromFile,
  runCanvasParityComparison,
  type ComputedDiffResult,
} from "../utils/canvasParity";

interface ParityGateViewProps {
  assets: BenchmarkAsset[];
  selectedAsset: BenchmarkAsset;
  onSelectAsset: (asset: BenchmarkAsset) => void;
  selectedPoseId: string;
  onSelectPoseId: (poseId: string) => void;
  customRefFrames: string[];
  customExpFrames: string[];
  onSetCustomRefFrames: (frames: string[]) => void;
  onSetCustomExpFrames: (frames: string[]) => void;
  onClearCustomFrames: () => void;
  metrics: CanvasParityMetrics | null;
  onMetricsComputed: (m: CanvasParityMetrics | null) => void;
  onJumpToPatches: () => void;
}

const COMPARE_MODES: { id: CompareMode; label: string }[] = [
  { id: "side-by-side", label: "Side by Side" },
  { id: "split", label: "Split Wipe" },
  { id: "heatmap", label: "Pixel Heatmap" },
  { id: "edges", label: "Silhouette Edges" },
];

function dataUrlToPayload(dataUrl: string): { mime: string; base64: string } {
  const [header, base64] = dataUrl.split(",");
  const match = header?.match(/data:([^;]+);base64/);
  return { mime: match?.[1] || "image/png", base64: base64 || "" };
}

export function ParityGateView({
  assets,
  selectedAsset,
  onSelectAsset,
  selectedPoseId,
  onSelectPoseId,
  customRefFrames,
  customExpFrames,
  onSetCustomRefFrames,
  onSetCustomExpFrames,
  onClearCustomFrames,
  metrics,
  onMetricsComputed,
  onJumpToPatches,
}: ParityGateViewProps) {
  const [compareMode, setCompareMode] = useState<CompareMode>("split");
  const [splitPct, setSplitPct] = useState(50);
  const [autoAlign, setAutoAlign] = useState(true);
  const [allowMirrorFlip, setAllowMirrorFlip] = useState(false);
  const [diffResult, setDiffResult] = useState<ComputedDiffResult | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiStatusMsg, setAiStatusMsg] = useState<string | null>(null);
  const [aiVerdict, setAiVerdict] = useState<AiParityVerdict | null>(null);

  const refInputRef = useRef<HTMLInputElement>(null);
  const expInputRef = useRef<HTMLInputElement>(null);

  const activePose =
    selectedAsset.exportRenders.find((r) => r.id === selectedPoseId) ??
    selectedAsset.exportRenders[0];

  const refSrc =
    customRefFrames[0] ??
    `/api/github-asset?path=${encodeURIComponent(selectedAsset.referenceRepoPath)}`;
  const expSrc =
    customExpFrames[0] ??
    `/api/github-asset?path=${encodeURIComponent(activePose.repoPath)}`;

  useEffect(() => {
    let cancelled = false;
    setLoadingDiff(true);
    setDiffError(null);
    setAiVerdict(null);
    setAiStatusMsg(null);

    runCanvasParityComparison(refSrc, expSrc, {
      autoAlign,
      allowMirrorFlip,
    })
      .then((res) => {
        if (cancelled) return;
        setDiffResult(res);
        onMetricsComputed(res.metrics);
      })
      .catch((err) => {
        if (cancelled) return;
        setDiffError(
          err instanceof Error ? err.message : "Failed to compute Canvas diff"
        );
        onMetricsComputed(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refSrc, expSrc, autoAlign, allowMirrorFlip]);

  async function handleFileUpload(
    file: File | undefined,
    target: "ref" | "exp"
  ) {
    if (!file) return;
    try {
      const frames = await extractFramesFromFile(file, 6);
      if (target === "ref") {
        onSetCustomRefFrames(frames);
      } else {
        onSetCustomExpFrames(frames);
      }
    } catch (err) {
      setDiffError(
        err instanceof Error ? err.message : "Could not decode uploaded file"
      );
    }
  }

  async function handleRunAiParity() {
    if (!diffResult) return;
    setAiLoading(true);
    setAiStatusMsg(null);
    setAiVerdict(null);

    try {
      const refPayload = dataUrlToPayload(diffResult.refDataUrl);
      const expPayload = dataUrlToPayload(diffResult.expDataUrl);
      const response = await fetch("/api/parity/ai-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetName: selectedAsset.name,
          poseLabel: activePose.label,
          referenceBase64: refPayload.base64,
          referenceMime: refPayload.mime,
          exportBase64: expPayload.base64,
          exportMime: expPayload.mime,
          canvasMetrics: diffResult.metrics,
          notes: activePose.notes,
        }),
      });
      const json = await response.json();
      if (!response.ok) {
        setAiStatusMsg(json.error || "Gemini parity request failed.");
      } else if (!json.configured) {
        setAiStatusMsg(json.message);
      } else if (json.result) {
        setAiVerdict(json.result as AiParityVerdict);
      }
    } catch (err) {
      setAiStatusMsg(
        err instanceof Error ? err.message : "Network error during AI check."
      );
    } finally {
      setAiLoading(false);
    }
  }

  const verdictColor =
    metrics?.verdict === "PASS"
      ? "text-emerald-400"
      : metrics?.verdict === "REVIEW"
        ? "text-amber-400"
        : "text-rose-400";

  return (
    <section className="space-y-6">
      {/* Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          {assets.map((asset) => {
            const active = asset.id === selectedAsset.id;
            return (
              <button
                key={asset.id}
                type="button"
                onClick={() => onSelectAsset(asset)}
                className={`rounded-lg px-3.5 py-2 text-xs font-medium transition-colors duration-150 whitespace-nowrap shrink-0 ${
                  active
                    ? "bg-slate-800 text-sky-400 ring-1 ring-sky-500/40"
                    : "bg-slate-900 text-slate-400 ring-1 ring-slate-800 hover:text-slate-200"
                }`}
              >
                {asset.name}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedAsset.exportRenders.map((pose) => {
            const active = pose.id === activePose.id;
            return (
              <button
                key={pose.id}
                type="button"
                onClick={() => onSelectPoseId(pose.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 whitespace-nowrap shrink-0 ${
                  active
                    ? "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/40"
                    : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                }`}
              >
                {pose.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Primary Visual Parity Canvas Stage */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-stretch">
        <div className="lg:col-span-8 flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-950 p-1 ring-1 ring-slate-800">
              {COMPARE_MODES.map((mode) => {
                const active = compareMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => setCompareMode(mode.id)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 whitespace-nowrap shrink-0 ${
                      active
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setAutoAlign((v) => !v)}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  autoAlign
                    ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                    : "border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200"
                }`}
              >
                {autoAlign ? "Auto-Align: On" : "Auto-Align: Off"}
              </button>
              {autoAlign && metrics?.alignment.oppositeViewDetected && (
                <button
                  type="button"
                  onClick={() => setAllowMirrorFlip((v) => !v)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    allowMirrorFlip
                      ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40"
                      : "border border-amber-500/40 bg-slate-900 text-amber-300 hover:bg-amber-500/10"
                  }`}
                >
                  {allowMirrorFlip ? "Mirror Flip: On" : "Test Mirror Flip"}
                </button>
              )}
              <input
                ref={refInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files?.[0], "ref")}
              />
              <input
                ref={expInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files?.[0], "exp")}
              />
              <button
                type="button"
                onClick={() => refInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-slate-100 whitespace-nowrap shrink-0"
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                Load Reference
              </button>
              <button
                type="button"
                onClick={() => expInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-slate-100 whitespace-nowrap shrink-0"
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                Load Export
              </button>
              {(customRefFrames.length > 0 || customExpFrames.length > 0) && (
                <button
                  type="button"
                  onClick={onClearCustomFrames}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Reset
                </button>
              )}
            </div>
          </div>

          {diffError && (
            <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200">
              {diffError}
            </div>
          )}

          {/* Stage Viewport */}
          <div className="checkerboard-stage relative min-h-[360px] flex-1 overflow-hidden rounded-lg border border-slate-800">
            {loadingDiff && !diffResult ? (
              <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-slate-400">
                Normalizing reference and export into canonical RGBA buffers...
              </div>
            ) : compareMode === "side-by-side" ? (
              <div className="grid h-full min-h-[360px] grid-cols-1 gap-3 p-3 md:grid-cols-2">
                <figure className="flex flex-col justify-between rounded-md border border-slate-800 bg-slate-950/70 p-2">
                  <img
                    src={diffResult?.refDataUrl || refSrc}
                    alt={`Sketchfab reference for ${selectedAsset.name}`}
                    referrerPolicy="no-referrer"
                    className="h-72 w-full object-contain"
                  />
                  <figcaption className="mt-2 flex items-center justify-between text-xs text-slate-400">
                    <span>Sketchfab Reference</span>
                    <span className="font-mono text-slate-500">
                      {customRefFrames.length > 0
                        ? "Custom upload"
                        : selectedAsset.referenceRepoPath}
                    </span>
                  </figcaption>
                </figure>
                <figure className="flex flex-col justify-between rounded-md border border-slate-800 bg-slate-950/70 p-2">
                  <img
                    src={diffResult?.expDataUrl || expSrc}
                    alt={`FiveM export render for ${selectedAsset.name}`}
                    referrerPolicy="no-referrer"
                    className="h-72 w-full object-contain"
                  />
                  <figcaption className="mt-2 flex items-center justify-between text-xs text-slate-400">
                    <span>FiveM Export ({activePose.label})</span>
                    <span className="font-mono text-slate-500">
                      {customExpFrames.length > 0
                        ? "Custom upload"
                        : activePose.repoPath}
                    </span>
                  </figcaption>
                </figure>
              </div>
            ) : compareMode === "split" ? (
              <div className="relative flex h-full min-h-[380px] select-none items-center justify-center p-4">
                <div className="relative aspect-video w-full max-w-[720px] overflow-hidden rounded-md border border-slate-800 bg-slate-950">
                  <img
                    src={diffResult?.expDataUrl || expSrc}
                    alt={`Export render ${selectedAsset.name}`}
                    referrerPolicy="no-referrer"
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                  <div
                    className="absolute inset-0 overflow-hidden"
                    style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
                  >
                    <img
                      src={diffResult?.refDataUrl || refSrc}
                      alt={`Sketchfab reference ${selectedAsset.name}`}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-contain"
                    />
                  </div>
                  <div
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-sky-400"
                    style={{ left: `${splitPct}%` }}
                  />
                  <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-slate-950/85 px-2 py-1 text-xs font-medium text-slate-200">
                    Sketchfab Reference
                  </div>
                  <div className="pointer-events-none absolute bottom-3 right-3 rounded bg-slate-950/85 px-2 py-1 text-xs font-medium text-sky-300">
                    FiveM Export
                  </div>
                </div>
                <div className="absolute bottom-3 left-1/2 flex w-64 -translate-x-1/2 items-center gap-3 rounded-lg border border-slate-700 bg-slate-950/90 px-3 py-1.5">
                  <span className="text-xs text-slate-400">Wipe</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={splitPct}
                    onChange={(e) => setSplitPct(Number(e.target.value))}
                    aria-label="Split wipe position"
                    className="w-full accent-sky-400"
                  />
                  <span className="font-mono text-xs tabular-nums text-slate-300">
                    {splitPct}%
                  </span>
                </div>
              </div>
            ) : compareMode === "heatmap" ? (
              <div className="flex h-full min-h-[380px] flex-col items-center justify-center p-4">
                {diffResult && (
                  <img
                    src={diffResult.heatmapDataUrl}
                    alt="Pixel difference heatmap"
                    className="aspect-video w-full max-w-[720px] rounded-md border border-slate-800 object-contain"
                  />
                )}
                <p className="mt-3 text-xs text-slate-400">
                  Dark slate indicates matched RGB pixels; amber and crimson highlight surface color, lighting, or pose divergence.
                </p>
              </div>
            ) : (
              <div className="flex h-full min-h-[380px] flex-col items-center justify-center p-4">
                {diffResult && (
                  <img
                    src={diffResult.edgeOverlayDataUrl}
                    alt="Sobel silhouette edge overlay"
                    className="aspect-video w-full max-w-[720px] rounded-md border border-slate-800 object-contain"
                  />
                )}
                <div className="mt-3 flex flex-wrap items-center gap-5 text-xs text-slate-400">
                  <span className="text-emerald-400">Green: Matched Edges</span>
                  <span className="text-sky-400">Blue: Sketchfab Reference Only</span>
                  <span className="text-amber-400">Amber: FiveM Export Only</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Inspection Panel */}
        <aside className="lg:col-span-4 flex flex-col justify-between gap-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Code-Based Parity Gate
                </h2>
                <span className={`font-mono text-xs font-semibold ${verdictColor}`}>
                  {metrics ? metrics.verdict : "PENDING"}
                </span>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
                {metrics?.verdictReason ||
                  "Deterministic Canvas & Canonical IR comparison."}
              </p>
            </div>

            {/* Numeric Metrics Grid */}
            <dl className="grid grid-cols-2 gap-3 border-y border-slate-800 py-4">
              <div>
                <dt className="text-xs text-slate-400">Silhouette IoU</dt>
                <dd className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-100">
                  {metrics ? `${metrics.silhouetteIoUPct}%` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-400">Edge Overlap</dt>
                <dd className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-100">
                  {metrics ? `${metrics.edgeOverlapPct}%` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-400">Pixel RMSE</dt>
                <dd className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-100">
                  {metrics ? `${metrics.rmsePct}%` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-400">Luma Delta</dt>
                <dd className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-100">
                  {metrics
                    ? `${metrics.lumaDelta > 0 ? "+" : ""}${metrics.lumaDelta}`
                    : "—"}
                </dd>
              </div>
            </dl>

            {/* Math-Sensor Auto-Alignment Telemetry */}
            {metrics && (
              <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs">
                <div className="flex items-center justify-between font-medium text-slate-200">
                  <span>Math Alignment Sensor</span>
                  <span className="font-mono tabular-nums text-sky-400">
                    IoU {metrics.alignment.rawSilhouetteIoUPct}% →{" "}
                    {metrics.silhouetteIoUPct}%
                  </span>
                </div>
                <p className="leading-relaxed text-slate-400">
                  {metrics.alignment.diagnosticNote}
                </p>
                <div className="font-mono text-[11px] tabular-nums text-slate-500">
                  scale {metrics.alignment.scaleFactor}x · shift{" "}
                  {metrics.alignment.shiftX >= 0 ? "+" : ""}
                  {metrics.alignment.shiftX}, {metrics.alignment.shiftY >= 0 ? "+" : ""}
                  {metrics.alignment.shiftY}px
                  {metrics.alignment.oppositeViewDetected
                    ? ` · mirror gain +${metrics.alignment.flipIoUGainPct}%`
                    : ""}
                </div>
              </div>
            )}

            {/* Palette Comparison */}
            {metrics && (
              <div className="space-y-2.5">
                <h3 className="text-xs font-medium text-slate-300">
                  Foreground Palette Comparison
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">Sketchfab</span>
                    <div className="flex items-center gap-1.5">
                      {metrics.refPalette.map((sw) => (
                        <span
                          key={`ref-${sw.hex}`}
                          title={`${sw.hex} (${sw.pct}%)`}
                          className="h-4 w-6 rounded border border-slate-700"
                          style={{ backgroundColor: sw.hex }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">Export</span>
                    <div className="flex items-center gap-1.5">
                      {metrics.expPalette.map((sw) => (
                        <span
                          key={`exp-${sw.hex}`}
                          title={`${sw.hex} (${sw.pct}%)`}
                          className="h-4 w-6 rounded border border-slate-700"
                          style={{ backgroundColor: sw.hex }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Repo Visual Blocker Context */}
            <div className="space-y-2 border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 text-xs font-medium text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Why Export Differs From Sketchfab</span>
              </div>
              <p className="text-xs leading-relaxed text-slate-300">
                {selectedAsset.visualParityBlocker}
              </p>
              <div className="pt-1 text-xs text-slate-500">
                <span>{selectedAsset.partCount} parts</span>
                <span aria-hidden="true"> · </span>
                <span className="font-mono">{selectedAsset.pass3bSummary}</span>
              </div>
            </div>

            {/* Optional Gemini Vision Review */}
            <div className="space-y-3 border-t border-slate-800 pt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-300">
                  Optional AI Vision Review
                </span>
                <button
                  type="button"
                  disabled={aiLoading || !diffResult}
                  onClick={handleRunAiParity}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:border-sky-500/50 hover:text-sky-200 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {aiLoading ? "Analyzing..." : "Run Gemini Check"}
                </button>
              </div>

              {aiStatusMsg && (
                <p className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs leading-relaxed text-slate-400">
                  {aiStatusMsg}
                </p>
              )}

              {aiVerdict && (
                <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-xs">
                  <div className="flex items-center justify-between font-medium">
                    <span className="inline-flex items-center gap-1.5 text-slate-200">
                      <Eye className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
                      Gemini Verdict
                    </span>
                    <span
                      className={`font-mono ${
                        aiVerdict.verdict === "PASS"
                          ? "text-emerald-400"
                          : "text-amber-400"
                      }`}
                    >
                      {aiVerdict.verdict}
                    </span>
                  </div>
                  <p className="leading-relaxed text-slate-300">
                    {aiVerdict.summary}
                  </p>
                  {aiVerdict.recommendedFixes.length > 0 && (
                    <ul className="space-y-1 pt-1 text-slate-400">
                      {aiVerdict.recommendedFixes.slice(0, 3).map((fix, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <CheckCircle2
                            className="mt-0.5 h-3 w-3 shrink-0 text-sky-400"
                            aria-hidden="true"
                          />
                          <span>{fix}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onJumpToPatches}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2.5 text-xs font-semibold text-slate-100 transition-colors hover:border-sky-500/50 hover:text-sky-300"
          >
            Inspect Phase 6 Fixes & Repo Patches
          </button>
        </aside>
      </div>
    </section>
  );
}
