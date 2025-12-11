#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const https = require("https");
const http = require("http");
const url = require("url");

/**
 * CLI args
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const val = args[i + 1];
    if (!key || !val) continue;
    if (key.startsWith("--")) {
      out[key.slice(2)] = val;
    }
  }
  return out;
}

/**
 * Simple logger
 */
function log(...msg) {
  console.log("[GLB Worker]", ...msg);
}

/**
 * Recursively list all files under a directory
 */
function walkFiles(dir) {
  const result = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(dir);
  return result;
}

/**
 * Collect CSS content from all .css files under appDir.
 */
function collectCss(appDir) {
  const files = walkFiles(appDir).filter((f) => f.endsWith(".css"));
  const chunks = [];
  for (const f of files) {
    try {
      const css = fs.readFileSync(f, "utf8");
      chunks.push(css);
    } catch (e) {
      console.error("[GLB Worker] Failed to read CSS", f, e.message);
    }
  }
  return chunks.join("\n\n");
}

/**
 * Extract <header>/<section>/<main>/<footer> blocks from HTML/JSX.
 * If none found, return the whole HTML as one section.
 */
function splitHtmlIntoSections(html) {
  const sections = [];
  const re = /<(header|section|main|footer)[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    sections.push(m[0]);
  }
  if (!sections.length) {
    sections.push(html);
  }
  return sections;
}

/**
 * Detect whether this is an Angular or React app, and obtain
 * base HTML/JSX content + an array of section strings.
 */
function analyzeApp(appDir) {
  log("Analyzing app at", appDir);

  const angularAppHtml = path.join(appDir, "src", "app", "app.component.html");
  const tsxFiles = walkFiles(appDir).filter((f) => f.endsWith(".tsx"));

  // Angular
  if (fs.existsSync(angularAppHtml)) {
    log("Detected Angular app; app.component.html found.");
    const full = fs.readFileSync(angularAppHtml, "utf8");
    const sections = splitHtmlIntoSections(full);
    return {
      framework: "angular",
      fullHtml: full,
      sections,
      appSource: full,
    };
  }

  // React / TSX
  if (tsxFiles.length > 0) {
    log("Detected React/TSX app; TSX files found.");

    // Prefer App.tsx if present
    const candidates = [
      path.join(appDir, "src", "App.tsx"),
      path.join(appDir, "App.tsx"),
      path.join(appDir, "src", "app", "App.tsx"),
    ];
    let primary = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        primary = c;
        break;
      }
    }

    let combinedHtml = "";
    let appSource = "";

    if (primary) {
      appSource = fs.readFileSync(primary, "utf8");
      combinedHtml = appSource;
      log("Using primary React entry file:", primary);
    } else {
      // Fallback: concatenate TSX fragments
      for (const f of tsxFiles) {
        const src = fs.readFileSync(f, "utf8");
        const match = src.match(
          /<(header|section|main|footer)[\s\S]*?<\/\1>/i
        );
        if (match) {
          combinedHtml += "\n" + match[0] + "\n";
        }
      }
      if (!combinedHtml.trim()) {
        combinedHtml = '<div id="root"></div>';
      }
      appSource = combinedHtml;
    }

    const sections = splitHtmlIntoSections(combinedHtml);
    return {
      framework: "react",
      fullHtml: combinedHtml,
      sections,
      appSource,
    };
  }

  // Fallback: try static index.html
  const indexHtml = path.join(appDir, "index.html");
  if (fs.existsSync(indexHtml)) {
    const full = fs.readFileSync(indexHtml, "utf8");
    const sections = splitHtmlIntoSections(full);
    return {
      framework: "static",
      fullHtml: full,
      sections,
      appSource: full,
    };
  }

  // As a last resort, create a trivial root section.
  log("No Angular/React/index.html found; using trivial root section.");
  const trivialHtml = '<div id="root"></div>';
  return {
    framework: "unknown",
    fullHtml: trivialHtml,
    sections: [trivialHtml],
    appSource: trivialHtml,
  };
}

/**
 * Call the Python classifier for a single section snippet.
 * We send a JSON payload on stdin to avoid escaping issues.
 */
function classifySection(sectionHtml, context) {
  const payload = {
    html: sectionHtml,
    context: context || "",
  };

  const env = { ...process.env };
  if (!env.GLB_LLM_MODEL) {
    // Default if not set at workflow level
    env.GLB_LLM_MODEL = "microsoft/Phi-3-mini-4k-instruct";
  }

  const res = spawnSync("python", ["scripts/llm_classifier.py"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });

  if (res.error) {
    console.error("[LLM] classifier error:", res.error);
    return null;
  }

  if (res.status !== 0) {
    console.error("[LLM] classifier non-zero exit:", res.status);
    if (res.stderr) console.error(res.stderr);
    else if (res.stdout) console.error(res.stdout);
    return null;
  }

  const stdout = (res.stdout || "").trim();
  if (!stdout) {
    console.error("[LLM] classifier returned empty output");
    return null;
  }

  try {
    const obj = JSON.parse(stdout);
    return obj;
  } catch (e) {
    console.error("[LLM] JSON parse error, stdout was:", stdout);
    return null;
  }
}

/**
 * Post layout JSON back to WordPress callback.
 */
function postToWordPress(callbackUrl, payload) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(callbackUrl);
    const isHttps = parsed.protocol === "https:";
    const client = isHttps ? https : http;

    const body = JSON.stringify(payload);

    const req = client.request(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => (chunks += d.toString("utf8")));
        res.on("end", () => {
          log("WP callback status:", res.statusCode);
          log("WP callback response body:", chunks);
          resolve({ statusCode: res.statusCode, body: chunks });
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs();

  const jobId = args["job-id"] || process.env.JOB_ID;
  const jobSecret = args["job-secret"] || process.env.JOB_SECRET;
  const builder = (args["builder"] || process.env.BUILDER || "divi").toLowerCase();
  const appDir = args["app-dir"] || process.env.APP_DIR || "./app";
  const callbackUrl = args["callback-url"] || process.env.CALLBACK_URL;
  const pageTitle = args["page-title"] || process.env.PAGE_TITLE || "Gemini Layout";
  const slug = args["slug"] || process.env.SLUG || "gemini-layout";

  if (!jobId || !jobSecret || !callbackUrl) {
    console.error(
      "[GLB Worker] Missing required args/job env (job-id, job-secret, callback-url)."
    );
    process.exit(1);
  }

  log(`Starting job ${jobId}, builder=${builder}, appDir=${appDir}`);

  // 1) Analyze the app structure & sections
  const appInfo = analyzeApp(appDir);
  const cssBundle = collectCss(appDir);

  // 2) Build layout object
  const layout = {
    head_html: cssBundle, // injected into <head> by the WP plugin
    body_class: "",
    sections: [],
  };

  if (builder === "classic") {
    // Classic builder: treat the entire HTML as one coherent section.
    const fullHtml =
      appInfo.fullHtml ||
      '<div class="glb-section glb-section-root glb-type-generic"><div id="root"></div></div>';

    layout.sections.push({
      id: "root",
      class: "glb-section glb-section-root glb-type-generic",
      html: fullHtml,
      type: "generic",
      builder: {},
    });
  } else {
    // Divi (or other future builders): classify each section individually
    if (!appInfo.sections || appInfo.sections.length === 0) {
      console.warn(
        "[GLB Worker] No sections found; falling back to one root section."
      );
      const html =
        appInfo.fullHtml ||
        '<div class="glb-section glb-section-root glb-type-generic"><div id="root"></div></div>';
      layout.sections.push({
        id: "root",
        class: "glb-section glb-section-root glb-type-generic",
        html,
        type: "generic",
        builder: {},
      });
    } else {
      appInfo.sections.forEach((html, idx) => {
        const sectionId = `section-${idx + 1}`;
        const cls = `glb-section glb-section-${sectionId} glb-type-generic`;

        const context = [
          `framework=${appInfo.framework}`,
          `index=${idx}`,
          `pageTitle=${pageTitle}`,
          `slug=${slug}`,
        ].join("; ");

        const classification = classifySection(html, context);
        let type = "generic";
        let builderMap = {};
        let moduleType = "unknown";
        let source = "none";

        if (classification && typeof classification === "object") {
          type = classification.type || "generic";
          builderMap = classification.builder || {};
          source = classification.source || "unknown";
          if (
            builderMap &&
            builderMap.divi &&
            typeof builderMap.divi.module_type === "string"
          ) {
            moduleType = builderMap.divi.module_type;
          }
        } else {
          console.warn(
            "[GLB Worker] classifier returned null; using generic/code."
          );
          builderMap = {
            divi: {
              module_type: "code",
              params: {},
            },
          };
          moduleType = "code";
          source = "fallback";
        }

        const previewSnippet = html
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);

        log(
          `Section ${sectionId}: type=${type}, divi.module_type=${moduleType}, source=${source}, snippet="${previewSnippet}"`
        );

        layout.sections.push({
          id: sectionId,
          class: cls,
          html,
          type,
          builder: builderMap,
        });
      });
    }
  }

  // 3) Post back to WordPress
  const payload = {
    job_id: jobId,
    secret: jobSecret,
    layout,
  };

  log("Posting layout back to WordPress callback …");
  try {
    await postToWordPress(callbackUrl, payload);
  } catch (err) {
    console.error("[GLB Worker] Error posting to WordPress:", err);
    process.exit(1);
  }

  log("Done.");
}

main().catch((err) => {
  console.error("[GLB Worker] Fatal error:", err);
  process.exit(1);
});
