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
 * Extract <section>...</section>-style blocks from HTML-ish strings.
 * If none found, return the whole HTML as one section.
 */
function splitHtmlIntoSections(html) {
  const sections = [];
  const re = /<(section|header|main|footer)[^>]*>[\s\S]*?<\/\1>/gi;
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
 * For React apps, try to extract sections from App.tsx / app.tsx specifically.
 */
function extractReactSectionsFromApp(tsxPath) {
  const src = fs.readFileSync(tsxPath, "utf8");
  const sections = [];
  const re = /<(header|section|main|footer)[^>]*>[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    sections.push(m[0]);
  }
  if (!sections.length) {
    sections.push('<div id="root"></div>');
  }
  return { sections, fullTsx: src };
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
      framework_source: full,
      fullHtml: full,
      sections,
    };
  }

  if (tsxFiles.length > 0) {
    // Prefer App.tsx / app.tsx as the primary entry.
    let primaryTsx = tsxFiles.find((f) =>
      /(?:^|\/)App\.tsx$/i.test(f)
    );
    if (!primaryTsx) {
      primaryTsx = tsxFiles.find((f) =>
        /(?:^|\/)index\.tsx$/i.test(f)
      ) || tsxFiles[0];
    }

    log("Detected React/TSX app; TSX files found.");
    log("Using primary React entry file:", path.relative(appDir, primaryTsx));

    const { sections, fullTsx } = extractReactSectionsFromApp(primaryTsx);
    const combinedHtml = sections.join("\n\n");

    return {
      framework: "react",
      framework_source: fullTsx,
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
      framework_source: full,
      fullHtml: full,
      sections,
    };
  }

  // As a last resort, create a trivial root section.
  log("No Angular or TSX or index.html found; using trivial root section.");
  const trivialHtml = '<div id="root"></div>';
  return {
    framework: "unknown",
    framework_source: trivialHtml,
    fullHtml: trivialHtml,
    sections: [trivialHtml],
  };
}

/**
 * Call the Python classifier for a single section HTML snippet.
 * We send a JSON payload on stdin to avoid escaping issues.
 */
function classifySection(sectionHtml, appInfo, idx, pageTitle) {
  const payload = {
    html: sectionHtml,
    context: {
      framework: appInfo.framework,
      pageTitle: pageTitle || "",
      sectionIndex: idx,
      framework_source: appInfo.framework_source || "",
    },
  };

  const env = { ...process.env };
  // Default model is now set inside the Python script,
  // but we keep a sane fallback here if needed.
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
 * Simple heuristics to veto obviously-wrong module picks.
 * e.g. don't create a contact form when there's no form / contact cues.
 */
function applyHeuristicOverrides(sectionHtml, classification, sectionId) {
  if (!classification || typeof classification !== "object") return classification;

  const updated = JSON.parse(JSON.stringify(classification));
  const divi = (updated.builder && updated.builder.divi) || {};
  const mt = (divi.module_type || "").toLowerCase();

  const lower = sectionHtml.toLowerCase();
  const hasFormTag = /<form[\s>]/i.test(sectionHtml);
  const hasInputTag = /<(input|textarea|select)[\s>]/i.test(sectionHtml);
  const hasContactWords =
    lower.includes("contact") ||
    lower.includes("get in touch") ||
    lower.includes("message us") ||
    lower.includes("send message") ||
    lower.includes("email address");

  const hasPricingWords =
    lower.includes("pricing") ||
    lower.includes("plan") ||
    lower.includes("lifetime") ||
    /\$\s*\d/.test(sectionHtml);

  const hasHeroHeading = /<h1[\s>]/i.test(sectionHtml);
  const hasList =
    /<(ul|ol)[\s>]/i.test(sectionHtml) || /<li[\s>]/i.test(sectionHtml);

  // CONTACT sanity check
  if (mt === "contact_form" || updated.type === "contact") {
    if (!(hasFormTag || hasInputTag || hasContactWords)) {
      log(
        `Section ${sectionId}: overriding contact_form -> feature_grid (no form/contact cues found)`
      );
      updated.type = hasList ? "feature_grid" : "generic";
      updated.builder = updated.builder || {};
      updated.builder.divi = updated.builder.divi || {};
      updated.builder.divi.module_type = hasList ? "feature_grid" : "code";
    }
  }

  // PRICING sanity check
  if (mt === "pricing_table" || updated.type === "pricing") {
    if (!hasPricingWords) {
      log(
        `Section ${sectionId}: overriding pricing_table -> generic (no pricing cues found)`
      );
      updated.type = "generic";
      updated.builder = updated.builder || {};
      updated.builder.divi = updated.builder.divi || {};
      updated.builder.divi.module_type = "code";
    }
  }

  // HERO sanity check
  if (mt === "hero" || updated.type === "hero") {
    if (!hasHeroHeading) {
      log(
        `Section ${sectionId}: overriding hero -> generic (no <h1> heading found)`
      );
      updated.type = "generic";
      updated.builder = updated.builder || {};
      updated.builder.divi = updated.builder.divi || {};
      updated.builder.divi.module_type = "code";
    }
  }

  return updated;
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
    // Divi (or future builders): classify each section individually
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
      appInfo.sections.forEach((rawHtml, idx) => {
        const sectionId = `section-${idx + 1}`;
        const cls = `glb-section glb-section-${sectionId} glb-type-generic`;

        const classification = classifySection(rawHtml, appInfo, idx, pageTitle);
        let type = "generic";
        let builderMap = {};

        let html = rawHtml;

        if (classification && typeof classification === "object") {
          // Use LLM-provided normalized HTML if present
          if (
            typeof classification.normalized_html === "string" &&
            classification.normalized_html.trim().length > 0
          ) {
            html = classification.normalized_html;
          }

          const adjusted = applyHeuristicOverrides(
            html,
            classification,
            sectionId
          );

          type = adjusted.type || "generic";
          builderMap = adjusted.builder || {};

          const diviModule = builderMap.divi && builderMap.divi.module_type;
          const snippet = html.replace(/\s+/g, " ").slice(0, 160);
          log(
            `Section ${sectionId}: type=${type}, divi.module_type=${diviModule || "n/a"}, snippet="${snippet}"`
          );
        } else {
          console.warn(
            `[GLB Worker] classifier returned null; using generic/code for ${sectionId}.`
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
