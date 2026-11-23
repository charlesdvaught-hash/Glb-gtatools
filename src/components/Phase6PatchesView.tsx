import { useMemo, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import {
  PHASE6_FINDINGS,
  PHASE6_REMAINING_ISSUES,
} from "../data/repoAuditData";
import type {
  BenchmarkAsset,
  CanvasParityMetrics,
  PatchOptions,
} from "../types/parity";
import { buildAllArtifacts } from "../utils/patchGenerator";

interface Phase6PatchesViewProps {
  asset: BenchmarkAsset;
  metrics: CanvasParityMetrics | null;
  options: PatchOptions;
  onChangeOptions: (next: PatchOptions) => void;
}

const OPTION_CONTROLS: {
  key: keyof PatchOptions;
  label: string;
  detail: string;
}[] = [
  {
    key: "autoOrientForward",
    label: "Canonical -Y forward alignment & ped grounding",
    detail:
      "Auto-snap Z yaw via L/R bone cross-product (peds) or symmetry plane (props) to face RAGE -Y forward, and ground process_ped after rotation.",
  },
  {
    key: "fixFrontLegSpin",
    label: "Fix leg_f0-2 spin freeze (P6-R5)",
    detail:
      "Guard WARN_AUTO_SPIN_PART on articulated leg/arm chains and force leg_f0-2 to hinge in sf_buster_drone.override.json.",
  },
  {
    key: "texturedAssemblyRender",
    label: "Textured render_check + 5-frame strip (P6-R4)",
    detail:
      "Render _assembly_{pose}_textured.png (colorize=False) alongside diagnostic pastel renders for true Sketchfab comparison.",
  },
  {
    key: "sollumzPbrShaderRouting",
    label: "Sollumz PBR / Emissive / Normal shader routing",
    detail:
      "Route emissive, normal+spec, and alpha materials to matching .sps shaders instead of diffuse-only default.sps.",
  },
  {
    key: "srgbTexconvFlags",
    label: "Explicit -srgb vs. linear texconv DDS flags",
    detail:
      "Pass -srgb for albedo/emissive textures while keeping normal and roughness/spec maps linear.",
  },
  {
    key: "balanceWhipKeyframes",
    label: "Per-part keyframe budget for distal whip links (P6-R3)",
    detail:
      "Support keyframe_max_stops_by_part so leg_*7 whip tips get 64 stops without inflating proximal parts.",
  },
  {
    key: "classifyScissorByBoneHop",
    label: "Classify 41 FK_SCISSOR_CLIP + shoulder seams (P6-R1/R2)",
    detail:
      "Separate 1-hop adjacent joint overlaps from cross-limb foot clips and sub-cm armor gaps in rigid_plate_qa.py.",
  },
  {
    key: "emitParityIrGate",
    label: "Canonical Scene & Animation IR Gate (tools/parity_check.py)",
    detail:
      "Convert Source GLB + Exported Sollumz resource into parity_ir.json and emit headless parity_report.json.",
  },
];

export function Phase6PatchesView({
  asset,
  metrics,
  options,
  onChangeOptions,
}: Phase6PatchesViewProps) {
  const artifacts = useMemo(
    () => buildAllArtifacts(asset, metrics, options),
    [asset, metrics, options]
  );

  const [selectedArtifactId, setSelectedArtifactId] = useState(
    artifacts[0].id
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const activeArtifact =
    artifacts.find((a) => a.id === selectedArtifactId) ?? artifacts[0];

  function toggleOption(key: keyof PatchOptions) {
    onChangeOptions({ ...options, [key]: !options[key] });
  }

  function handleCopy(text: string, id: string) {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1600);
  }

  function handleDownload(filename: string, content: string) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.split("/").pop() || filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Remediation Controls + Phase 6 Triage */}
        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Targeted Parity & Phase 6 Fixes
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Toggle fixes to customize the generated Python patches and committed override recipe.
            </p>

            <div className="mt-4 divide-y divide-slate-800/80">
              {OPTION_CONTROLS.map((ctrl) => {
                const checked = options[ctrl.key];
                return (
                  <label
                    key={ctrl.key}
                    className="flex cursor-pointer items-start gap-3 py-3 first:pt-1 last:pb-1"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOption(ctrl.key)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-950 accent-sky-400"
                    />
                    <span className="text-xs">
                      <span className="block font-medium text-slate-200">
                        {ctrl.label}
                      </span>
                      <span className="mt-0.5 block leading-relaxed text-slate-400">
                        {ctrl.detail}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Phase 6 Open Issues ({PHASE6_REMAINING_ISSUES.length})
            </h3>
            <ul className="mt-3 divide-y divide-slate-800/80 text-xs">
              {PHASE6_REMAINING_ISSUES.map((item) => {
                const isAddressed = item.fixOptionKey
                  ? options[item.fixOptionKey]
                  : false;
                return (
                  <li key={item.id} className="py-3 first:pt-1 last:pb-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-slate-200">
                        {item.id} · {item.targetFile}
                      </span>
                      <span
                        className={`font-mono text-[11px] font-semibold ${
                          isAddressed ? "text-emerald-400" : "text-amber-400"
                        }`}
                      >
                        {isAddressed ? "PATCHED" : item.severity}
                      </span>
                    </div>
                    <p className="mt-1 leading-relaxed text-slate-300">
                      {item.issue}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        {/* Right: Patch & Recipe Code Viewer */}
        <div className="lg:col-span-7 flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {artifacts.map((art) => {
                const active = art.id === activeArtifact.id;
                return (
                  <button
                    key={art.id}
                    type="button"
                    onClick={() => setSelectedArtifactId(art.id)}
                    className={`rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                        : "bg-slate-950 text-slate-400 ring-1 ring-slate-800 hover:text-slate-200"
                    }`}
                  >
                    {art.filename}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  handleCopy(activeArtifact.content, activeArtifact.id)
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-600 whitespace-nowrap shrink-0"
              >
                {copiedId === activeArtifact.id ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Copy
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() =>
                  handleDownload(activeArtifact.filename, activeArtifact.content)
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Save File
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
            <span>{activeArtifact.summary}</span>
            <span className="font-mono text-slate-500">
              {activeArtifact.targetPath}
            </span>
          </div>

          <pre className="mt-3 max-h-[620px] flex-1 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
            {activeArtifact.content}
          </pre>
        </div>
      </div>

      {/* Verified Phase 6 Baselines */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="font-display text-sm font-semibold text-slate-100">
          Verified Phase 6 Measurements (Baseline Preserved)
        </h3>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {PHASE6_FINDINGS.map((f) => (
            <div
              key={f.id}
              className="rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs"
            >
              <div className="flex items-center justify-between font-mono text-slate-400">
                <span className="font-semibold text-sky-400">{f.id}</span>
                <span className="tabular-nums">
                  conf {Math.round(f.confidence * 100)}%
                </span>
              </div>
              <p className="mt-1.5 leading-relaxed text-slate-200">{f.claim}</p>
              <p className="mt-1.5 font-mono text-[11px] text-slate-500">
                {f.evidence}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
