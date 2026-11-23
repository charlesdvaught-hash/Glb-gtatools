import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_RAW_BASE =
  "https://raw.githubusercontent.com/charlesdvaught-hash/sketchfab-to-fivem/main";

const ALLOWED_PATH_RE =
  /^(?:(?:testing|reference|tools|\.devin)\/[A-Za-z0-9_.\-\/]+|README\.md|PIPELINE_SPEC\.json|MOTION_SPEC\.md|AGENTS\.md)$/;

interface CacheEntry {
  contentType: string;
  body: Buffer;
  fetchedAt: number;
}

const assetCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000;

function guessContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".py")) return "text/x-python; charset=utf-8";
  return "application/octet-stream";
}

function hasValidGeminiKey(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key !== "MY_GEMINI_API_KEY");
}

async function fetchRepoAsset(assetPath: string): Promise<CacheEntry> {
  if (!ALLOWED_PATH_RE.test(assetPath) || assetPath.includes("..")) {
    throw new Error("Invalid repository asset path");
  }
  const now = Date.now();
  const cached = assetCache.get(assetPath);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  const response = await fetch(`${REPO_RAW_BASE}/${assetPath}`);
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${assetPath}`);
  }
  const arrayBuf = await response.arrayBuffer();
  const entry: CacheEntry = {
    contentType: guessContentType(assetPath),
    body: Buffer.from(arrayBuf),
    fetchedAt: now,
  };
  assetCache.set(assetPath, entry);
  return entry;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/github-asset", async (req, res) => {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!rawPath) {
      res.status(400).json({ error: "Missing ?path= query parameter" });
      return;
    }
    try {
      const entry = await fetchRepoAsset(rawPath);
      res.setHeader("Content-Type", entry.contentType);
      res.setHeader("Cache-Control", "public, max-age=900");
      res.send(entry.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Asset fetch failed";
      const status = message.includes("Invalid") ? 400 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.get("/api/repo-audit", async (_req, res) => {
    try {
      const [phase6Entry, phase5Entry] = await Promise.all([
        fetchRepoAsset("testing/PHASE6_SPLITS.json"),
        fetchRepoAsset("testing/PHASE5_RESIDUALS.json"),
      ]);
      res.json({
        source: "live",
        phase6: JSON.parse(phase6Entry.body.toString("utf-8")),
        phase5: JSON.parse(phase5Entry.body.toString("utf-8")),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load audit";
      res.status(502).json({ source: "unavailable", error: message });
    }
  });

  app.get("/api/parity/ai-status", (_req, res) => {
    res.json({
      configured: hasValidGeminiKey(),
      model: "gemini-4-hydrogen",
    });
  });

  app.post("/api/parity/ai-check", async (req, res) => {
    if (!hasValidGeminiKey()) {
      res.json({
        configured: false,
        message:
          "GEMINI_API_KEY is not configured. Code-based Canonical IR parity checks remain active; configure GEMINI_API_KEY in Settings > Secrets to enable optional Gemini Vision review.",
      });
      return;
    }

    const {
      assetName,
      poseLabel,
      referenceBase64,
      referenceMime,
      exportBase64,
      exportMime,
      canvasMetrics,
      notes,
    } = req.body ?? {};

    if (!referenceBase64 || !exportBase64) {
      res.status(400).json({
        error: "Both referenceBase64 and exportBase64 images are required.",
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const prompt = [
        `Compare these two renders for asset "${assetName || "unknown"}" (pose: ${poseLabel || "default"}).`,
        `Image 1 is the Sketchfab Reference Preview. Image 2 is the FiveM / Sollumz Export Render.`,
        canvasMetrics
          ? `Measured code-based Canvas metrics: Silhouette IoU=${canvasMetrics.silhouetteIoUPct}%, Pixel RMSE=${canvasMetrics.rmsePct}%, Luma Delta=${canvasMetrics.lumaDelta}.`
          : "",
        notes ? `Pipeline notes: ${notes}` : "",
        `Note if Image 2 uses flat pastel diagnostic colors (colorize=True in render_check.py) instead of real textures/emissives, and check whether articulated legs/limbs, proportions, decals, and lighting match Image 1.`,
      ]
        .filter(Boolean)
        .join("\n");

      let response;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: referenceMime || "image/jpeg",
                    data: referenceBase64,
                  },
                },
                {
                  inlineData: {
                    mimeType: exportMime || "image/png",
                    data: exportBase64,
                  },
                },
                { text: prompt },
              ],
            },
            config: {
              systemInstruction:
                "You are a 3D look-development and RAGE/Sollumz FiveM export QA specialist. Judge strictly whether the FiveM export render achieves visual parity with the Sketchfab reference preview across facing direction, pose/articulation, silhouette, PBR materials, emissives, and color accuracy. Keep findings concrete and actionable.",
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  verdict: {
                    type: Type.STRING,
                    description: "PASS, NEEDS_FIX, or FAIL",
                  },
                  summary: {
                    type: Type.STRING,
                    description:
                      "Concise 1-2 sentence assessment of Sketchfab parity.",
                  },
                  poseDeltas: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  materialDeltas: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  lightingDeltas: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  recommendedFixes: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  "verdict",
                  "summary",
                  "poseDeltas",
                  "materialDeltas",
                  "lightingDeltas",
                  "recommendedFixes",
                ],
              },
            },
          });
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("503") && attempt < 2) {
            await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
      if (!response) {
        throw lastErr instanceof Error ? lastErr : new Error("Gemini call failed");
      }

      const parsed = JSON.parse((response.text ?? "{}").trim());
      res.json({
        configured: true,
        model: "gemini-4-hydrogen",
        result: parsed,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Gemini Vision parity call failed";
      const isQuota = message.includes("429") || message.includes("RESOURCE_EXHAUSTED");
      res.status(isQuota ? 429 : 502).json({
        configured: true,
        error: isQuota
          ? "Gemini free-tier RPM limit reached (5 req/min). Wait ~20s before re-running optional AI Vision review; code-based checks remain instant."
          : message,
      });
    }
  });

  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    }
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.log(`Parity Gate server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
