#!/usr/bin/env node

/**
 * Gemini Layout Worker
 *
 * Responsibilities:
 *  - Inspect the React/Angular app folder (from Gemini ZIP)
 *  - Build a "section map" from TSX components (Hero, Services, Pricing, etc.)
 *  - Call the Python LLM classifier to pick appropriate Divi modules + params
 *  - Build a layout JSON with:
 *      sections: [{ id, class, type, html, builder: { divi: { module_type, params } } }]
 *  - POST that layout JSON back to WordPress via the callback URL
 *
 * IMPORTANT CHANGES:
 *  - NO MORE "Divi Implementation Guide" synthetic overlay.
 *  - We now create one section per TSX component (skipping any file that looks like a Divi guide).
 *  - Even if the LLM fails, you get one Divi Code module per TSX section (not a single root module).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Use node-fetch v2 style if present, otherwise basic https
let fetch;
try {
  // eslint-disable-next-line global-require
  fetch = require("node-fetch");
} catch (e) {
  fetch = null;
  // We'll fall back to https if needed
}
const https = require("https");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
      args[key] = val;
    }
  }
  return args;
}

function log(...msg) {
  console.log("[GLB Worker]", ...msg);
}

/**
 * Recursively find all .tsx files under a directory.
 */
function findTsxFiles(rootDir) {
  const result = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && full.toLowerCase().endsWith(".tsx")) {
        result.push(full);
      }
    }
  }
  walk(rootDir);
  return result;
}

/**
 * Very rough text extraction from TSX/JSX:
 *  - Strip JSX tags
 *  - Strip JS expressions { } and template literals
 *  - Collapse whitespace
 */
function extractTextFromTsx(source) {
  let s = source;

  // Remove block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Remove line comments
  s = s.replace(/\/\/[^\n\r]*/g, " ");
  // Remove JSX tags
  s = s.replace(/<\/?[\w\d\-\.:]+[^>]*>/g, " ");
  // Remove { ... } expressions
  s = s.replace(/\{[^}]*\}/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

function inferSectionTypeFromName(name) {
  const low = name.toLowerCase();
  if (low.includes("hero") || low.includes("header")) return "hero";
  if (low.includes("about")) return "about";
  if (low.includes("service")) return "services";
  if (low.includes("pricing") || low.includes("plans")) return "pricing";
  if (low.includes("faq")) return "faq";
  if (low.includes("testimonials") || low.includes("testimonial")) return "testimonials";
  if (low.includes("contact") || low.includes("form")) return "contact";
  if (low.includes("map") || low.includes("region")) return "map";
  if (low.includes("process") || low.includes("steps") || low.includes("checklist")) return "process";
  return "generic";
}

/**
 * Decide whether a TSX file is clearly just a Divi implementation guide
 * (we do NOT want that as a content section).
 */
function looksLikeDiviGuide(source) {
  const low = source.toLowerCase();
  if (low.includes("divi implementation guide")) return true;
  if (low.includes("follow these steps to build") && low.includes("divi")) return true;
  if (low.includes("theme builder layouts") && low.includes("global header") && low.includes("global footer")) {
    return true;
  }
  return false;
}

/**
 * Build raw section list from the app directory based purely on TSX components.
 * Each section:
 *  - id: kebab-case from filename
 *  - type: inferred from filename
 *  - html: a TSX snippet (to be used as code-module content or for reference)
 *  - text: extracted plain text (for the LLM to reason about)
 */
function analyzeAppToSections(appDir) {
  const tsxFiles = findTsxFiles(appDir);

  if (!tsxFiles.length) {
    log("No TSX files found in app dir, returning single generic section.");
    return [
      {
        id: "root",
        type: "generic",
        html: "<div id=\"root\"></div>",
        text: "",
      },
    ];
  }

  const sections = [];

  for (const filePath of tsxFiles) {
    const basename = path.basename(filePath, ".tsx");
    const rawSource = fs.readFileSync(filePath, "utf8");

    // Skip obvious Divi implementation guide components
    if (looksLikeDiviGuide(rawSource)) {
      log("Skipping Divi guide-like component:", basename);
      continue;
    }

    // Skip index.tsx (ReactDOM render bootstrap)
    if (basename.toLowerCase() === "index") {
      continue;
    }

    const id = basename
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[\s_]+/g, "-")
      .toLowerCase();

    const type = inferSectionTypeFromName(basename);
    const text = extractTextFromTsx(rawSource);
    const htmlSnippet = rawSource.slice(0, 4000);

    sections.push({
      id,
      type,
      html: htmlSnippet,
      text,
      sourcePath: filePath,
    });
  }

  if (!sections.length) {
    log("All TSX files looked like guides or boilerplate; falling back to root section.");
    return [
      {
        id: "root",
        type: "generic",
        html: "<div id=\"root\"></div>",
        text: "",
      },
    ];
  }

  log(`Found ${sections.length} content sections from TSX files.`);
  return sections;
}

/**
 * Call the Python classifier.
 * If it fails for ANY reason, return null (we'll fall back to "code" modules).
 */
function classifyWithLLM(sectionMap) {
  // Prepare JSON input
  const input = {
    sections: sectionMap.map((sec) => ({
      id: sec.id,
      type: sec.type,
      html: sec.html,
      text: sec.text,
    })),
  };

  const proc = spawnSync("python", ["scripts/llm_classifier.py"], {
    encoding: "utf8",
    input: JSON.stringify(input),
    maxBuffer: 10 * 1024 * 1024,
  });

  if (proc.error) {
    console.error("[LLM] classifier spawn error:", proc.error);
    return null;
  }

  if (proc.status !== 0) {
    console.error("[LLM] classifier failed:", proc.stderr || proc.stdout);
    return null;
  }

  const stdout = proc.stdout.trim();
  if (!stdout) {
    console.error("[LLM] classifier returned empty output");
    return null;
  }

  try {
    const result = JSON.parse(stdout);
    if (!result || !Array.isArray(result.sections)) {
      console.error("[LLM] classifier output missing sections");
      return null;
    }
    return result;
  } catch (e) {
    console.error("[LLM] classifier JSON parse error:", e);
    console.error("Raw output:", stdout.slice(0, 2000));
    return null;
  }
}

/**
 * Build final layout JSON:
 *  - Merge LLM classification (if available) into `builder.divi`
 *  - Keep original `html` from TSX snippets (for code module fallback)
 *  - Set simple body class; head_html left empty for now
 */
function buildLayoutJson(sectionMap, classifierResult, builder) {
  const sectionsOut = [];

  for (const sec of sectionMap) {
    const base = {
      id: sec.id,
      class: "",
      type: sec.type || "generic",
      html: sec.html || "",
      builder: {},
    };

    if (classifierResult && Array.isArray(classifierResult.sections)) {
      const match =
        classifierResult.sections.find((s) => s.id === sec.id) ||
        classifierResult.sections[sectionMap.indexOf(sec)] ||
        null;

      if (match && match.divi && typeof match.divi === "object") {
        base.builder.divi = {
          module_type: match.divi.module_type || "code",
          params: match.divi.params || {},
        };
      }
    }

    // If no LLM mapping, we still want a code module per section,
    // so Classic/Divi can at least show each TSX chunk separately.
    if (!base.builder.divi) {
      base.builder.divi = {
        module_type: "code",
        params: {
          html_summary: sec.text || "",
        },
      };
    }

    sectionsOut.push(base);
  }

  const bodyClass =
    builder === "divi"
      ? "gemini-layout gemini-layout-divi"
      : "gemini-layout gemini-layout-classic";

  return {
    head_html: "",
    body_class: bodyClass,
    sections: sectionsOut,
  };
}

/**
 * POST layout JSON back to WordPress.
 */
async function postLayout(callbackUrl, jobId, jobSecret, layout) {
  const payload = {
    job_id: jobId,
    secret: jobSecret,
    layout,
  };

  const body = JSON.stringify(payload);

  if (fetch) {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Callback HTTP ${res.status}: ${text.slice(0, 2000)}`
      );
    }
    return text;
  }

  // Fallback: basic https
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(callbackUrl);
      const opts = {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `Callback HTTP ${res.statusCode}: ${data.slice(0, 2000)}`
              )
            );
          } else {
            resolve(data);
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);

  const jobId = args["job-id"] || "";
  const jobSecret = args["job-secret"] || "";
  const builder = args["builder"] || "divi";
  const appDir = args["app-dir"] || "./app";
  const callbackUrl = args["callback-url"] || "";
  const pageTitle = args["page-title"] || "";
  const slug = args["slug"] || "";

  if (!jobId || !jobSecret || !callbackUrl) {
    console.error(
      "Missing required arguments: --job-id, --job-secret, --callback-url"
    );
    process.exit(1);
  }

  log(`Starting job ${jobId}, builder=${builder}`);

  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    console.error("App directory does not exist:", appDir);
    process.exit(1);
  }

  // 1) Build section map from TSX components
  const sectionMap = analyzeAppToSections(appDir);

  // 2) Ask the on-repo LLM for module classification
  const classifierResult = classifyWithLLM(sectionMap);
  if (!classifierResult) {
    log("LLM classification failed or produced invalid output; falling back to code modules per section.");
  }

  // 3) Build final layout JSON
  const layout = buildLayoutJson(sectionMap, classifierResult, builder);

  // 4) Attach page meta in the layout object (optional, but WP plugin can ignore or use it)
  layout.meta = {
    page_title: pageTitle,
    slug,
    builder,
  };

  // 5) POST layout to WordPress
  try {
    log("Posting layout back to WordPress callback …");
    const resText = await postLayout(callbackUrl, jobId, jobSecret, layout);
    log("Done.");
    // For debugging:
    // console.log("WP response:", resText.slice(0, 2000));
  } catch (err) {
    console.error("Failed to POST layout to WordPress:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error in generate-layout:", err);
  process.exit(1);
});
