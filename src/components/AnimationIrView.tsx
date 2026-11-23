import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Pause, Play } from "lucide-react";
import type {
  BenchmarkAsset,
  CanvasParityMetrics,
  PatchOptions,
} from "../types/parity";
import { runCanvasParityComparison } from "../utils/canvasParity";
import { buildParityReportJson } from "../utils/patchGenerator";

interface AnimationIrViewProps {
  asset: BenchmarkAsset;
  customRefFrames: string[];
  customExpFrames: string[];
  patchOptions: PatchOptions;
  latestMetrics: CanvasParityMetrics | null;
}

export function AnimationIrView({
  asset,
  customRefFrames,
  customExpFrames,
  patchOptions,
  latestMetrics,
}: AnimationIrViewProps) {
  const frames = useMemo(() => {
    if (customRefFrames.length > 0 || customExpFrames.length > 0) {
      const count = Math.max(customRefFrames.length, customExpFrames.length, 1);
      return Array.from({ length: count }, (_, i) => ({
        label: `Frame ${i + 1}`,
        t: count === 1 ? 0 : Math.round((i / (count - 1)) * 100) / 100,
        refSrc:
          customRefFrames[Math.min(i, Math.max(0, customRefFrames.length - 1))] ||
          `/api/github-asset?path=${encodeURIComponent(asset.referenceRepoPath)}`,
        expSrc:
          customExpFrames[Math.min(i, Math.max(0, customExpFrames.length - 1))] ||
          `/api/github-asset?path=${encodeURIComponent(asset.exportRenders[0].repoPath)}`,
      }));
    }

    // Order repo renders from t=0 -> t=1 for temporal scrub
    const ordered = [...asset.exportRenders].sort((a, b) => a.t - b.t);
    return ordered.map((pose) => ({
      label: pose.label,
      t: pose.t,
      refSrc: `/api/github-asset?path=${encodeURIComponent(asset.referenceRepoPath)}`,
      expSrc: `/api/github-asset?path=${encodeURIComponent(pose.repoPath)}`,
    }));
  }, [asset, customRefFrames, customExpFrames]);

  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frameMetrics, setFrameMetrics] = useState<CanvasParityMetrics | null>(
    null
  );
  const [copiedReport, setCopiedReport] = useState(false);

  useEffect(() => {
    setFrameIdx(0);
    setPlaying(false);
  }, [asset.id, frames.length]);

  useEffect(() => {
    if (!playing || frames.length <= 1) return;
    const id = window.setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % frames.length);
    }, 900);
    return () => window.clearInterval(id);
  }, [playing, frames.length]);

  const activeFrame = frames[Math.min(frameIdx, frames.length - 1)];

  useEffect(() => {
    let cancelled = false;
    if (!activeFrame) return;
    runCanvasParityComparison(activeFrame.refSrc, activeFrame.expSrc)
      .then((res) => {
        if (!cancelled) setFrameMetrics(res.metrics);
      })
      .catch(() => {
        if (!cancelled) setFrameMetrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFrame]);

  const reportJson = useMemo(
    () => buildParityReportJson(asset, frameMetrics || latestMetrics, patchOptions),
    [asset, frameMetrics, latestMetrics, patchOptions]
  );

  function copyReport() {
    navigator.clipboard?.writeText(reportJson);
    setCopiedReport(true);
    window.setTimeout(() => setCopiedReport(false), 1600);
  }

  return (
    <section className="space-y-8">
      {/* Temporal Animation Frame Scrubber */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-100">
              Temporal Animation & Pose Sequence ({asset.name})
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Compares Sketchfab preview frames against Sollumz manifest poses across time. Upload a video or sprite strip on the Parity Gate tab to scrub multi-frame Sketchfab captures.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {frames.length > 1 && (
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-500/50 whitespace-nowrap shrink-0"
              >
                {playing ? (
                  <>
                    <Pause className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
                    Play Sequence
                  </>
                )}
              </button>
            )}
            <span className="font-mono text-xs tabular-nums text-slate-400">
              t = {activeFrame?.t.toFixed(2)} ({frameIdx + 1}/{frames.length})
            </span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
              <span>Sketchfab Preview Frame</span>
              <span className="font-mono tabular-nums">t={activeFrame?.t.toFixed(2)}</span>
            </div>
            <img
              src={activeFrame?.refSrc}
              alt="Reference animation frame"
              referrerPolicy="no-referrer"
              className="h-64 w-full object-contain"
            />
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
              <span>Export Frame ({activeFrame?.label})</span>
              <span className="font-mono tabular-nums text-sky-400">
                IoU {frameMetrics ? `${frameMetrics.silhouetteIoUPct}%` : "—"} · RMSE{" "}
                {frameMetrics ? `${frameMetrics.rmsePct}%` : "—"}
              </span>
            </div>
            <img
              src={activeFrame?.expSrc}
              alt="Export animation frame"
              referrerPolicy="no-referrer"
              className="h-64 w-full object-contain"
            />
          </div>
        </div>

        {frames.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {frames.map((f, idx) => (
              <button
                key={`${f.label}-${idx}`}
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setFrameIdx(idx);
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  idx === frameIdx
                    ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                    : "bg-slate-950 text-slate-400 ring-1 ring-slate-800 hover:text-slate-200"
                }`}
              >
                {f.label} · t={f.t.toFixed(2)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Canonical Scene IR Equivalence Table + Headless JSON */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Canonical Scene IR Equivalence (Source vs. Export)
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Converts both Source GLB and Re-imported Sollumz drawables into one canonical part/shader representation to verify parity deterministically.
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 pr-3 font-medium">Part / Bone Group</th>
                  <th className="py-2.5 px-3 font-medium">Source</th>
                  <th className="py-2.5 px-3 font-medium">Export</th>
                  <th className="py-2.5 px-3 font-medium text-right">KF</th>
                  <th className="py-2.5 px-3 font-medium text-right">PASS4</th>
                  <th className="py-2.5 pl-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {asset.canonicalParts.map((part) => {
                  const fixedByFacing =
                    part.partName.includes("facing_direction") &&
                    patchOptions.autoOrientForward;
                  const fixedByFrontLeg =
                    part.partName.includes("leg_f0") &&
                    patchOptions.fixFrontLegSpin;
                  const fixedByWhip =
                    part.partName.includes("leg_l7") &&
                    patchOptions.balanceWhipKeyframes;
                  const fixedByShader =
                    (part.partName.includes("optics") ||
                      part.partName.includes("body")) &&
                    patchOptions.sollumzPbrShaderRouting &&
                    patchOptions.texturedAssemblyRender;
                  const fixedByScissor =
                    (part.partName.includes("Foot") ||
                      part.partName.includes("UpperArm")) &&
                    patchOptions.classifyScissorByBoneHop;

                  const resolved =
                    part.status === "MATCH" ||
                    fixedByFacing ||
                    fixedByFrontLeg ||
                    fixedByWhip ||
                    fixedByShader ||
                    fixedByScissor;

                  return (
                    <tr key={part.partName} className="hover:bg-slate-800/30">
                      <td className="py-3 pr-3">
                        <div className="font-mono font-medium text-slate-200">
                          {part.partName}
                        </div>
                        <div className="mt-0.5 text-slate-400">
                          {part.issueSummary}
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-300">
                        {part.sourceClass}
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-300">
                        {fixedByFrontLeg ? "hinge (patched)" : part.exportClass}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300">
                        {fixedByWhip ? "64" : part.keyframes}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300">
                        {part.pass4WorstProbeM.toFixed(4)}m
                      </td>
                      <td className="py-3 pl-3 font-mono font-semibold whitespace-nowrap">
                        {resolved ? (
                          <span className="text-emerald-400">
                            {part.status === "MATCH" ? "MATCH" : "PATCHED"}
                          </span>
                        ) : (
                          <span className="text-amber-400">{part.status}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Headless Agent Report
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Emitted by tools/parity_check.py for automated agent approval.
              </p>
            </div>
            <button
              type="button"
              onClick={copyReport}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 whitespace-nowrap shrink-0"
            >
              {copiedReport ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  Copy JSON
                </>
              )}
            </button>
          </div>

          <pre className="mt-4 max-h-[420px] flex-1 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3.5 font-mono text-xs leading-relaxed text-slate-300">
            {reportJson}
          </pre>
        </div>
      </div>
    </section>
  );
}
