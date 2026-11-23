import { useEffect, useState } from "react";
import { TopBar, type WorkspaceTab } from "./components/TopBar";
import { ParityGateView } from "./components/ParityGateView";
import { AnimationIrView } from "./components/AnimationIrView";
import { Phase6PatchesView } from "./components/Phase6PatchesView";
import {
  BENCHMARK_ASSETS,
  DEFAULT_PATCH_OPTIONS,
} from "./data/repoAuditData";
import type {
  BenchmarkAsset,
  CanvasParityMetrics,
  PatchOptions,
} from "./types/parity";
import { buildAllArtifacts } from "./utils/patchGenerator";

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("parity");
  const [selectedAsset, setSelectedAsset] = useState<BenchmarkAsset>(
    BENCHMARK_ASSETS[0]
  );
  const [selectedPoseId, setSelectedPoseId] = useState<string>(
    BENCHMARK_ASSETS[0].exportRenders[0].id
  );
  const [customRefFrames, setCustomRefFrames] = useState<string[]>([]);
  const [customExpFrames, setCustomExpFrames] = useState<string[]>([]);
  const [latestMetrics, setLatestMetrics] =
    useState<CanvasParityMetrics | null>(null);
  const [patchOptions, setPatchOptions] = useState<PatchOptions>(
    DEFAULT_PATCH_OPTIONS
  );
  const [liveAuditStatus, setLiveAuditStatus] = useState<string>(
    "Loaded Phase 6 audit"
  );

  useEffect(() => {
    fetch("/api/repo-audit")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.phase6?.commit) {
          setLiveAuditStatus(
            `Synced live with charlesdvaught-hash/sketchfab-to-fivem (${data.phase6.commit})`
          );
        }
      })
      .catch(() => {
        // Fallback snapshot already active
      });
  }, []);

  function handleSelectAsset(asset: BenchmarkAsset) {
    setSelectedAsset(asset);
    setSelectedPoseId(asset.exportRenders[0].id);
    setCustomRefFrames([]);
    setCustomExpFrames([]);
  }

  function handleDownloadBundle() {
    const artifacts = buildAllArtifacts(
      selectedAsset,
      latestMetrics,
      patchOptions
    );
    const bundlePayload = {
      generated_at: new Date().toISOString(),
      asset: selectedAsset.name,
      apply_instructions:
        "Save each file to its targetPath in sketchfab-to-fivem, apply .patch files with git apply, and run tools/parity_check.py.",
      files: artifacts.map((a) => ({
        targetPath: a.targetPath,
        summary: a.summary,
        content: a.content,
      })),
    };
    const blob = new Blob([JSON.stringify(bundlePayload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sketchfab_parity_bundle_${selectedAsset.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onDownloadBundle={handleDownloadBundle}
      />

      <main className="mx-auto max-w-[1440px] px-6 py-8">
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100 text-balance">
              Sketchfab Preview Parity & Phase 6 Remediation
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Code-based Canonical IR and visual frame comparison against{" "}
              <span className="font-mono text-slate-300">
                testing/REFERENCE_*.jpg
              </span>{" "}
              with headless agent output and repo patches.
            </p>
          </div>
          <div className="text-xs text-slate-500">
            <span>{liveAuditStatus}</span>
            <span aria-hidden="true"> · </span>
            <span className="font-mono">PIPELINE_SPEC v1.4.0</span>
          </div>
        </div>

        {activeTab === "parity" && (
          <ParityGateView
            assets={BENCHMARK_ASSETS}
            selectedAsset={selectedAsset}
            onSelectAsset={handleSelectAsset}
            selectedPoseId={selectedPoseId}
            onSelectPoseId={setSelectedPoseId}
            customRefFrames={customRefFrames}
            customExpFrames={customExpFrames}
            onSetCustomRefFrames={setCustomRefFrames}
            onSetCustomExpFrames={setCustomExpFrames}
            onClearCustomFrames={() => {
              setCustomRefFrames([]);
              setCustomExpFrames([]);
            }}
            metrics={latestMetrics}
            onMetricsComputed={setLatestMetrics}
            onJumpToPatches={() => setActiveTab("patches")}
          />
        )}

        {activeTab === "animation" && (
          <AnimationIrView
            asset={selectedAsset}
            customRefFrames={customRefFrames}
            customExpFrames={customExpFrames}
            patchOptions={patchOptions}
            latestMetrics={latestMetrics}
          />
        )}

        {activeTab === "patches" && (
          <Phase6PatchesView
            asset={selectedAsset}
            metrics={latestMetrics}
            options={patchOptions}
            onChangeOptions={setPatchOptions}
          />
        )}
      </main>
    </div>
  );
}
