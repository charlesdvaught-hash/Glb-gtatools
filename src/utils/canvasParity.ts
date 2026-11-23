import type {
  AlignmentTelemetry,
  CanvasParityMetrics,
  PaletteSwatch,
} from "../types/parity";

const COMPARE_W = 480;
const COMPARE_H = 270;

export interface AlignmentOptions {
  autoAlign: boolean;
  allowMirrorFlip: boolean;
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function sampleCornerRgb(img: HTMLImageElement): [number, number, number] {
  const probe = document.createElement("canvas");
  probe.width = 4;
  probe.height = 4;
  const pctx = probe.getContext("2d");
  if (!pctx) return [24, 28, 36];
  pctx.drawImage(img, 0, 0, 4, 4);
  const d = pctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function drawNormalized(
  img: HTMLImageElement,
  width = COMPARE_W,
  height = COMPARE_H
): {
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  bgRgb: [number, number, number];
} {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");

  const bgRgb = sampleCornerRgb(img);
  ctx.fillStyle = `rgb(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]})`;
  ctx.fillRect(0, 0, width, height);

  const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
  const dw = Math.round(img.naturalWidth * scale);
  const dh = Math.round(img.naturalHeight * scale);
  const dx = Math.round((width - dw) / 2);
  const dy = Math.round((height - dh) / 2);
  ctx.drawImage(img, dx, dy, dw, dh);

  return { canvas, imageData: ctx.getImageData(0, 0, width, height), bgRgb };
}

function computeLumaGradient(
  data: Uint8ClampedArray,
  w: number,
  h: number
): Float32Array {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    luma[i] =
      0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
  }
  const grad = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -luma[i - w - 1] +
        luma[i - w + 1] -
        2 * luma[i - 1] +
        2 * luma[i + 1] -
        luma[i + w - 1] +
        luma[i + w + 1];
      const gy =
        -luma[i - w - 1] -
        2 * luma[i - w] -
        luma[i - w + 1] +
        luma[i + w - 1] +
        2 * luma[i + w] +
        luma[i + w + 1];
      grad[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return grad;
}

function computeForegroundMask(
  data: Uint8ClampedArray,
  w: number,
  h: number
): Uint8Array {
  const samplePx = (x: number, y: number): [number, number, number] => {
    const idx = (y * w + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]];
  };

  const corners = [
    samplePx(3, 3),
    samplePx(w - 4, 3),
    samplePx(3, h - 4),
    samplePx(w - 4, h - 4),
  ];
  const br = corners.reduce((s, c) => s + c[0], 0) / 4;
  const bg = corners.reduce((s, c) => s + c[1], 0) / 4;
  const bb = corners.reduce((s, c) => s + c[2], 0) / 4;

  const cornerSpread = Math.max(
    ...corners.map((c) =>
      Math.sqrt((c[0] - br) ** 2 + (c[1] - bg) ** 2 + (c[2] - bb) ** 2)
    )
  );

  // Sample border regions away from center subject to detect radial spotlight vignettes
  const edgeProbes = [
    samplePx(Math.round(w * 0.15), 3),
    samplePx(Math.round(w * 0.85), 3),
    samplePx(3, Math.round(h * 0.2)),
    samplePx(w - 4, Math.round(h * 0.2)),
    samplePx(Math.round(w * 0.15), h - 4),
    samplePx(Math.round(w * 0.85), h - 4),
  ];
  const smoothFarCount = edgeProbes.filter(
    (p) =>
      Math.sqrt((p[0] - br) ** 2 + (p[1] - bg) ** 2 + (p[2] - bb) ** 2) > 28
  ).length;

  const isVignette = smoothFarCount >= 2 || cornerSpread > 18;
  const mask = new Uint8Array(w * h);

  if (!isVignette) {
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      const dr = data[idx] - br;
      const dg = data[idx + 1] - bg;
      const db = data[idx + 2] - bb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist > 22 && data[idx + 3] > 20) {
        mask[i] = 1;
      }
    }
    return mask;
  }

  // Gradient-barrier flood fill from outer border handles radial studio vignettes
  const grad = computeLumaGradient(data, w, h);
  const bgMask = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const trySeed = (idx: number) => {
    if (!bgMask[idx] && grad[idx] < 26) {
      bgMask[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < w; x++) {
    trySeed(x);
    trySeed(w + x);
    trySeed((h - 2) * w + x);
    trySeed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    trySeed(y * w);
    trySeed(y * w + 1);
    trySeed(y * w + (w - 2));
    trySeed(y * w + (w - 1));
  }

  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    const cj = cur * 4;
    const cr = data[cj];
    const cg = data[cj + 1];
    const cb = data[cj + 2];

    const neighbors = [
      cx > 0 ? cur - 1 : -1,
      cx < w - 1 ? cur + 1 : -1,
      cy > 0 ? cur - w : -1,
      cy < h - 1 ? cur + w : -1,
    ];
    for (const ni of neighbors) {
      if (ni < 0 || bgMask[ni] || grad[ni] > 28) continue;
      const nj = ni * 4;
      const step =
        Math.abs(data[nj] - cr) +
        Math.abs(data[nj + 1] - cg) +
        Math.abs(data[nj + 2] - cb);
      if (step <= 15) {
        bgMask[ni] = 1;
        queue[tail++] = ni;
      }
    }
  }

  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      const i = y * w + x;
      if (!bgMask[i] && data[i * 4 + 3] > 20) {
        mask[i] = 1;
      }
    }
  }
  return mask;
}

interface MaskBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  count: number;
}

function measureMaskBounds(mask: Uint8Array, w: number, h: number): MaskBounds {
  const xs: number[] = [];
  const ys: number[] = [];
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      xs.push(x);
      ys.push(y);
      sumX += x;
      sumY += y;
    }
  }
  const count = xs.length;
  if (count < 16) {
    return {
      minX: 0,
      maxX: w - 1,
      minY: 0,
      maxY: h - 1,
      cx: w / 2,
      cy: h / 2,
      width: w,
      height: h,
      count,
    };
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const lo = Math.floor(0.02 * count);
  const hi = Math.max(lo + 1, Math.floor(0.98 * count) - 1);
  const minX = xs[lo];
  const maxX = xs[hi];
  const minY = ys[lo];
  const maxY = ys[hi];
  return {
    minX,
    maxX,
    minY,
    maxY,
    cx: sumX / count,
    cy: sumY / count,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
    count,
  };
}

function scoreMaskTransform(
  refMask: Uint8Array,
  expMask: Uint8Array,
  w: number,
  h: number,
  refCx: number,
  refCy: number,
  expCx: number,
  expCy: number,
  scale: number,
  dx: number,
  dy: number,
  flipX: boolean
): number {
  let inter = 0;
  let union = 0;
  for (let y = 0; y < h; y += 2) {
    const sy = Math.round((y - refCy - dy) / scale + expCy);
    const syValid = sy >= 0 && sy < h;
    for (let x = 0; x < w; x += 2) {
      const rOn = refMask[y * w + x] === 1;
      let eOn = false;
      if (syValid) {
        const rx = (x - refCx - dx) / scale;
        const sx = Math.round((flipX ? -rx : rx) + expCx);
        if (sx >= 0 && sx < w) {
          eOn = expMask[sy * w + sx] === 1;
        }
      }
      if (rOn && eOn) inter++;
      if (rOn || eOn) union++;
    }
  }
  return union === 0 ? 0 : inter / union;
}

function solveAlignment(
  refMask: Uint8Array,
  expMask: Uint8Array,
  w: number,
  h: number
) {
  const rb = measureMaskBounds(refMask, w, h);
  const eb = measureMaskBounds(expMask, w, h);
  const baseScale = Math.min(
    2.4,
    Math.max(0.45, Math.min(rb.width / eb.width, rb.height / eb.height))
  );
  const candidateScales = Array.from(
    new Set([
      baseScale * 0.9,
      baseScale * 0.95,
      baseScale,
      baseScale * 1.05,
      baseScale * 1.1,
      1.0,
    ])
  );

  const searchTransform = (flipX: boolean) => {
    let bestIoU = -1;
    let bestScale = baseScale;
    let bestDx = 0;
    let bestDy = 0;
    for (const s of candidateScales) {
      for (let dy = -16; dy <= 16; dy += 4) {
        for (let dx = -16; dx <= 16; dx += 4) {
          const iou = scoreMaskTransform(
            refMask,
            expMask,
            w,
            h,
            rb.cx,
            rb.cy,
            eb.cx,
            eb.cy,
            s,
            dx,
            dy,
            flipX
          );
          if (iou > bestIoU) {
            bestIoU = iou;
            bestScale = s;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }
    }
    return { iou: bestIoU, scale: bestScale, dx: bestDx, dy: bestDy };
  };

  const normalFit = searchTransform(false);
  const flippedFit = searchTransform(true);

  return {
    rb,
    eb,
    normalFit,
    flippedFit,
  };
}

function renderTransformedExport(
  expCanvas: HTMLCanvasElement,
  bgRgb: [number, number, number],
  rb: MaskBounds,
  eb: MaskBounds,
  scale: number,
  dx: number,
  dy: number,
  flipX: boolean
): { canvas: HTMLCanvasElement; imageData: ImageData } {
  const out = document.createElement("canvas");
  out.width = COMPARE_W;
  out.height = COMPARE_H;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = `rgb(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]})`;
  ctx.fillRect(0, 0, COMPARE_W, COMPARE_H);

  ctx.save();
  ctx.translate(rb.cx + dx, rb.cy + dy);
  ctx.scale(flipX ? -scale : scale, scale);
  ctx.translate(-eb.cx, -eb.cy);
  ctx.drawImage(expCanvas, 0, 0);
  ctx.restore();

  return {
    canvas: out,
    imageData: ctx.getImageData(0, 0, COMPARE_W, COMPARE_H),
  };
}

function computeSobelEdges(
  data: Uint8ClampedArray,
  w: number,
  h: number
): Uint8Array {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    luma[i] =
      0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
  }
  const edges = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -luma[i - w - 1] +
        luma[i - w + 1] -
        2 * luma[i - 1] +
        2 * luma[i + 1] -
        luma[i + w - 1] +
        luma[i + w + 1];
      const gy =
        -luma[i - w - 1] -
        2 * luma[i - w] -
        luma[i - w + 1] +
        luma[i + w - 1] +
        2 * luma[i + w] +
        luma[i + w + 1];
      if (Math.sqrt(gx * gx + gy * gy) > 68) {
        edges[i] = 1;
      }
    }
  }
  return edges;
}

function extractForegroundPalette(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  count = 4
): PaletteSwatch[] {
  const bins = new Map<
    string,
    { r: number; g: number; b: number; n: number }
  >();
  let total = 0;
  for (let i = 0; i < mask.length; i += 2) {
    if (!mask[i]) continue;
    const idx = i * 4;
    const qr = Math.round(data[idx] / 32) * 32;
    const qg = Math.round(data[idx + 1] / 32) * 32;
    const qb = Math.round(data[idx + 2] / 32) * 32;
    const key = `${qr},${qg},${qb}`;
    const entry = bins.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    entry.r += data[idx];
    entry.g += data[idx + 1];
    entry.b += data[idx + 2];
    entry.n += 1;
    bins.set(key, entry);
    total += 1;
  }
  if (total === 0) return [];
  return [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, count)
    .map((b) => {
      const r = Math.min(255, Math.round(b.r / b.n));
      const g = Math.min(255, Math.round(b.g / b.n));
      const bl = Math.min(255, Math.round(b.b / b.n));
      const hex =
        "#" +
        [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
      return {
        hex,
        pct: Math.round((b.n / total) * 1000) / 10,
      };
    });
}

function evaluatePairStats(
  refData: Uint8ClampedArray,
  expData: Uint8ClampedArray,
  refMask: Uint8Array,
  expMask: Uint8Array
) {
  const n = COMPARE_W * COMPARE_H;
  let absErrSum = 0;
  let sqErrSum = 0;
  let fgPixels = 0;
  let maskInter = 0;
  let maskUnion = 0;
  let refLumaSum = 0;
  let expLumaSum = 0;

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const inUnion = refMask[i] === 1 || expMask[i] === 1;
    if (refMask[i] === 1 && expMask[i] === 1) maskInter++;
    if (inUnion) maskUnion++;
    if (!inUnion) continue;

    fgPixels++;
    const dr = Math.abs(refData[idx] - expData[idx]);
    const dg = Math.abs(refData[idx + 1] - expData[idx + 1]);
    const db = Math.abs(refData[idx + 2] - expData[idx + 2]);
    const meanDelta = (dr + dg + db) / (3 * 255);
    absErrSum += meanDelta;
    sqErrSum += meanDelta * meanDelta;
    refLumaSum +=
      (0.2126 * refData[idx] +
        0.7152 * refData[idx + 1] +
        0.0722 * refData[idx + 2]) /
      255;
    expLumaSum +=
      (0.2126 * expData[idx] +
        0.7152 * expData[idx + 1] +
        0.0722 * expData[idx + 2]) /
      255;
  }

  const denom = Math.max(1, fgPixels);
  return {
    maePct: Math.round((absErrSum / denom) * 1000) / 10,
    rmsePct: Math.round(Math.sqrt(sqErrSum / denom) * 1000) / 10,
    silhouetteIoUPct:
      maskUnion === 0 ? 0 : Math.round((maskInter / maskUnion) * 1000) / 10,
    lumaDelta: Math.round(((expLumaSum - refLumaSum) / denom) * 1000) / 1000,
  };
}

export interface ComputedDiffResult {
  metrics: CanvasParityMetrics;
  refDataUrl: string;
  expDataUrl: string;
  heatmapDataUrl: string;
  edgeOverlayDataUrl: string;
}

export async function runCanvasParityComparison(
  refSrc: string,
  expSrc: string,
  alignOpts: AlignmentOptions = { autoAlign: true, allowMirrorFlip: false }
): Promise<ComputedDiffResult> {
  const [refImg, expImg] = await Promise.all([
    loadHtmlImage(refSrc),
    loadHtmlImage(expSrc),
  ]);

  const normRef = drawNormalized(refImg);
  const normExp = drawNormalized(expImg);
  const refData = normRef.imageData.data;
  const rawExpData = normExp.imageData.data;

  const refMask = computeForegroundMask(refData, COMPARE_W, COMPARE_H);
  const rawExpMask = computeForegroundMask(rawExpData, COMPARE_W, COMPARE_H);

  const rawStats = evaluatePairStats(refData, rawExpData, refMask, rawExpMask);
  const solver = solveAlignment(refMask, rawExpMask, COMPARE_W, COMPARE_H);

  const flipGainPct =
    Math.round((solver.flippedFit.iou - solver.normalFit.iou) * 1000) / 10;
  const oppositeViewDetected = flipGainPct >= 4.5;
  const useFlip = Boolean(alignOpts.autoAlign && alignOpts.allowMirrorFlip && oppositeViewDetected);
  const chosenFit = useFlip ? solver.flippedFit : solver.normalFit;

  let activeExpCanvas = normExp.canvas;
  let activeExpData = rawExpData;
  let activeExpMask = rawExpMask;

  if (alignOpts.autoAlign) {
    const transformed = renderTransformedExport(
      normExp.canvas,
      normExp.bgRgb,
      solver.rb,
      solver.eb,
      chosenFit.scale,
      chosenFit.dx,
      chosenFit.dy,
      useFlip
    );
    activeExpCanvas = transformed.canvas;
    activeExpData = transformed.imageData.data;
    activeExpMask = computeForegroundMask(activeExpData, COMPARE_W, COMPARE_H);
  }

  const activeStats = evaluatePairStats(
    refData,
    activeExpData,
    refMask,
    activeExpMask
  );

  const refEdges = computeSobelEdges(refData, COMPARE_W, COMPARE_H);
  const expEdges = computeSobelEdges(activeExpData, COMPARE_W, COMPARE_H);

  let edgeInter = 0;
  let edgeUnion = 0;

  const heatCanvas = document.createElement("canvas");
  heatCanvas.width = COMPARE_W;
  heatCanvas.height = COMPARE_H;
  const heatCtx = heatCanvas.getContext("2d")!;
  const heatImg = heatCtx.createImageData(COMPARE_W, COMPARE_H);

  const edgeCanvas = document.createElement("canvas");
  edgeCanvas.width = COMPARE_W;
  edgeCanvas.height = COMPARE_H;
  const edgeCtx = edgeCanvas.getContext("2d")!;
  const edgeImg = edgeCtx.createImageData(COMPARE_W, COMPARE_H);

  const n = COMPARE_W * COMPARE_H;
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    if (refEdges[i] === 1 && expEdges[i] === 1) edgeInter++;
    if (refEdges[i] === 1 || expEdges[i] === 1) edgeUnion++;

    const dr = Math.abs(refData[idx] - activeExpData[idx]);
    const dg = Math.abs(refData[idx + 1] - activeExpData[idx + 1]);
    const db = Math.abs(refData[idx + 2] - activeExpData[idx + 2]);
    const meanDelta = (dr + dg + db) / (3 * 255);

    const intensity = Math.min(1, meanDelta * 2.4);
    heatImg.data[idx] = Math.round(15 + intensity * 225);
    heatImg.data[idx + 1] = Math.round(
      23 + (1 - Math.abs(intensity - 0.5) * 2) * 140 * intensity
    );
    heatImg.data[idx + 2] = Math.round(42 * (1 - intensity));
    heatImg.data[idx + 3] = 255;

    if (refEdges[i] && expEdges[i]) {
      edgeImg.data[idx] = 34;
      edgeImg.data[idx + 1] = 197;
      edgeImg.data[idx + 2] = 94;
      edgeImg.data[idx + 3] = 255;
    } else if (refEdges[i]) {
      edgeImg.data[idx] = 56;
      edgeImg.data[idx + 1] = 189;
      edgeImg.data[idx + 2] = 248;
      edgeImg.data[idx + 3] = 255;
    } else if (expEdges[i]) {
      edgeImg.data[idx] = 245;
      edgeImg.data[idx + 1] = 158;
      edgeImg.data[idx + 2] = 11;
      edgeImg.data[idx + 3] = 255;
    } else {
      edgeImg.data[idx] = 15;
      edgeImg.data[idx + 1] = 23;
      edgeImg.data[idx + 2] = 42;
      edgeImg.data[idx + 3] = 255;
    }
  }

  heatCtx.putImageData(heatImg, 0, 0);
  edgeCtx.putImageData(edgeImg, 0, 0);

  const edgeOverlapPct =
    edgeUnion === 0 ? 0 : Math.round((edgeInter / edgeUnion) * 1000) / 10;

  const refPalette = extractForegroundPalette(refData, refMask);
  const expPalette = extractForegroundPalette(activeExpData, activeExpMask);

  const shiftX = Math.round(solver.rb.cx + chosenFit.dx - solver.eb.cx);
  const shiftY = Math.round(solver.rb.cy + chosenFit.dy - solver.eb.cy);
  const scaleFactor = Math.round(chosenFit.scale * 100) / 100;

  let diagnosticNote = `Framing aligned (${scaleFactor}x scale, ${shiftX >= 0 ? "+" : ""}${shiftX}px X, ${shiftY >= 0 ? "+" : ""}${shiftY}px Y).`;
  if (oppositeViewDetected) {
    diagnosticNote = `Opposite-side view detected (+${flipGainPct}% silhouette IoU when mirrored horizontally) — check 3D yaw or camera azimuth.`;
  }

  const alignment: AlignmentTelemetry = {
    applied: alignOpts.autoAlign,
    scaleFactor,
    shiftX,
    shiftY,
    oppositeViewDetected,
    flipXApplied: useFlip,
    flipIoUGainPct: flipGainPct,
    rawSilhouetteIoUPct: rawStats.silhouetteIoUPct,
    rawRmsePct: rawStats.rmsePct,
    diagnosticNote,
  };

  let verdict: "PASS" | "REVIEW" | "FAIL" = "PASS";
  let verdictReason =
    "Silhouette and surface appearance closely track the Sketchfab preview.";
  if (activeStats.silhouetteIoUPct < 50 || activeStats.rmsePct > 28) {
    verdict = "FAIL";
    verdictReason =
      "High pixel/silhouette divergence — likely yaw/pose mismatch or flat diagnostic shader coloring.";
  } else if (activeStats.silhouetteIoUPct < 78 || activeStats.rmsePct > 16) {
    verdict = "REVIEW";
    verdictReason =
      "Moderate visual delta after framing alignment — inspect pose, yaw, or PBR/emissive lighting.";
  }

  return {
    metrics: {
      width: COMPARE_W,
      height: COMPARE_H,
      maePct: activeStats.maePct,
      rmsePct: activeStats.rmsePct,
      silhouetteIoUPct: activeStats.silhouetteIoUPct,
      edgeOverlapPct,
      lumaDelta: activeStats.lumaDelta,
      refPalette,
      expPalette,
      alignment,
      verdict,
      verdictReason,
    },
    refDataUrl: normRef.canvas.toDataURL("image/png"),
    expDataUrl: activeExpCanvas.toDataURL("image/png"),
    heatmapDataUrl: heatCanvas.toDataURL("image/png"),
    edgeOverlayDataUrl: edgeCanvas.toDataURL("image/png"),
  };
}

export async function extractFramesFromFile(
  file: File,
  maxFrames = 6
): Promise<string[]> {
  if (file.type.startsWith("video/")) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;

      video.onloadedmetadata = async () => {
        try {
          const duration = Math.max(0.1, video.duration || 1);
          const frames: string[] = [];
          const canvas = document.createElement("canvas");
          canvas.width = COMPARE_W;
          canvas.height = COMPARE_H;
          const ctx = canvas.getContext("2d")!;

          for (let i = 0; i < maxFrames; i++) {
            const t = (duration * i) / Math.max(1, maxFrames - 1);
            await new Promise<void>((res) => {
              video.onseeked = () => res();
              video.currentTime = Math.min(duration - 0.01, t);
            });
            ctx.fillStyle = "#0f172a";
            ctx.fillRect(0, 0, COMPARE_W, COMPARE_H);
            const scale = Math.min(
              COMPARE_W / video.videoWidth,
              COMPARE_H / video.videoHeight
            );
            const dw = video.videoWidth * scale;
            const dh = video.videoHeight * scale;
            ctx.drawImage(
              video,
              (COMPARE_W - dw) / 2,
              (COMPARE_H - dh) / 2,
              dw,
              dh
            );
            frames.push(canvas.toDataURL("image/png"));
          }
          URL.revokeObjectURL(url);
          resolve(frames);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not decode uploaded video clip"));
      };
    });
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read uploaded file"));
    reader.readAsDataURL(file);
  });

  const img = await loadHtmlImage(dataUrl);
  const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
  if (ratio > 2.6) {
    const count = Math.min(maxFrames, Math.max(2, Math.round(ratio / (16 / 9))));
    const sliceW = img.naturalWidth / count;
    const frames: string[] = [];
    for (let i = 0; i < count; i++) {
      const c = document.createElement("canvas");
      c.width = Math.round(sliceW);
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(
        img,
        i * sliceW,
        0,
        sliceW,
        img.naturalHeight,
        0,
        0,
        c.width,
        c.height
      );
      frames.push(c.toDataURL("image/png"));
    }
    return frames;
  }

  return [dataUrl];
}
