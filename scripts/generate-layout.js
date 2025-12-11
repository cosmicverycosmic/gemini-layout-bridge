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
 * Extract <section>...</section> blocks from HTML.
 * If none found, return the whole HTML as one section.
 */
function splitHtmlIntoSections(html) {
  const sections = [];
  const re = /<section[\s\S]*?<\/section>/gi;
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
 * base HTML content + an array of section HTML strings.
 */
function analyzeApp(appDir) {
  log("Analyzing app at", appDir);

  const angularAppHtml = path.join(appDir, "src", "app", "app.component.html");
  const tsxFiles = walkFiles(appDir).filter((f) => f.endsWith(".tsx"));

  if (fs.existsSync(angularAppHtml)) {
    log("Detected Angular app; app.component.html found.");
    const full = fs.readFileSync(angularAppHtml, "utf8");
    const sections = splitHtmlIntoSections(full);
    return {
      framework: "angular",
      fullHtml: full,
      sections,
    };
  }

  if (tsxFiles.length > 0) {
    log("Detected React/TSX app; TSX files found.");
    // For now, treat the main visual app as the concatenation of all TSX
    // rendered fragments. This is heuristic but works better than nothing.
    let combinedHtml = "";
    for (const f of tsxFiles) {
      const src = fs.readFileSync(f, "utf8");
      // Very naive extraction: look for JSX fragments containing <section or <main
      const match = src.match(/(<(section|main)[\s\S]*?<\/(section|main)>)/i);
      if (match) {
        combinedHtml += "\n" + match[1] + "\n";
      }
    }
    if (!combinedHtml.trim()) {
      // If we couldn't find subsections, just fall back to a root div
      combinedHtml = '<div id="root"></div>';
    }
    const sections = splitHtmlIntoSections(combinedHtml);
    return {
      framework: "react",
      fullHtml: combinedHtml,
      sections,
    };
  }

  // Fallback: try index.html
  const indexHtml = path.join(appDir, "index.html");
  if (fs.existsSync(indexHtml)) {
    const full = fs.readFileSync(indexHtml, "utf8");
    const sections = splitHtmlIntoSections(full);
    return {
      framework: "static",
      fullHtml: full,
      sections,
    };
  }

  // As a last resort, create a trivial root section.
  log("No Angular or TSX or index.html found; using trivial root section.");
  const trivialHtml = '<div id="root"></div>';
  return {
    framework: "unknown",
    fullHtml: trivialHtml,
    sections: [trivialHtml],
  };
}

/**
 * Call the Python classifier for a single section HTML snippet.
 * We send a JSON payload on stdin to avoid escaping issues.
 */
function classifySection(sectionHtml, context) {
  const payload = {
    html: sectionHtml,
    context: context || "",
  };

  const env = { ...process.env };
  // Make sure the model env variable is passed through.
  // Default has been changed in the Python script itself.
  if (!env.GLB_LLM_MODEL) {
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
    console.error(res.stderr || res.stdout);
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

  log(
    `Starting job ${jobId}, builder=${builder}, appDir=${appDir}`
  );

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
        const context = `app=${appInfo.framework}, index=${idx}, pageTitle=${pageTitle}`;
        const cls = `glb-section glb-section-${sectionId} glb-type-generic`;

        const classification = classifySection(html, context);
        let type = "generic";
        let builderMap = {};

        if (classification && typeof classification === "object") {
          type = classification.type || "generic";
          builderMap = classification.builder || {};
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
        }

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
