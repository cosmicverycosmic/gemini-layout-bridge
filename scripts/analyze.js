const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

const MODEL_NAME = "gemini-2.0-flash-lite-preview-02-05";
const API_VERSION = "v1beta";

async function run() {
    try {
        console.log("----------------------------------------");
        console.log(`GLB Architect v17 (Strict Extractor)`);
        console.log(`Target: ${args.builder}`);
        console.log("----------------------------------------");

        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context missing");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');

        // 1. Extract & Scan
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        
        // Debug: List files found
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Extracted: ${codeSummary.length} chars.`);
        
        if (codeSummary.length < 500) {
            console.warn("WARNING: Source code seems empty. Listing all files found:");
            debugFileList('extracted_source');
            throw new Error("No source code found to analyze. Check ZIP structure.");
        }

        // 2. Strict Prompt
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY missing");

        const systemPrompt = `
        ROLE: Data Extraction Engine for WordPress.
        TARGET: ${args.builder}.
        
        INPUT DATA: You will be given source code (React/Angular/HTML). 
        
        ⛔ STRICT RULE: **DO NOT HALLUCINATE.** 
        - You must ONLY use text/content found in the SOURCE CODE.
        - If the source code says "Instant Plugins", DO NOT write "NeuroFin".
        - If the source code says "$19/month", DO NOT write "$999".
        - If you cannot find content, output a text module saying "Content not found in source".
        
        TASK:
        1. Identify the actual content (Headings, Paragraphs, Pricing Data).
        2. Map it to specific Divi Modules.
        
        MODULE MAPPING:
        - **Hero**: Find H1/H2, Subtext, and CTA. -> type: "hero"
        - **Pricing**: Find lists of plans/prices. -> type: "pricing", props: { items: [{title, price, currency, frequency, features}] }
        - **Blurb Grid**: Find feature lists (icon + title + text). -> type: "blurb_grid", props: { items: [...] }
        - **Accordion**: Find FAQ lists. -> type: "accordion"
        - **Testimonials**: Find quotes. -> type: "testimonial"
        - **Forms**: Find <form> or input fields. -> type: "contact_form"
        - **Fallback**: If content is unstructured, use type: "text", props: { content: "..." } (Clean HTML).

        OUTPUT JSON:
        {
            "layout": {
                "sections": [
                    { "type": "hero", "props": { "title": "Real Title From Code", "subtitle": "Real Subtitle" } }
                ]
            },
            "custom_plugin_php": null
        }`;

        const userMessage = `CONTEXT: ${contextRaw}\n\nSOURCE CODE:\n${codeSummary}`;

        // 3. API Call
        console.log(`Sending to ${MODEL_NAME}...`);
        const url = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
        
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userMessage }] }],
                generationConfig: { response_mime_type: "application/json", temperature: 0.0 } // 0.0 temp for max accuracy
            })
        });

        if (!response.ok) throw new Error(await response.text());

        const data = await response.json();
        const raw = data.candidates[0].content.parts[0].text;
        const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        const output = JSON.parse(clean);

        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(output.layout, null, 2));
        console.log(`Generated ${output.layout.sections.length} sections based on REAL content.`);

        if (output.custom_plugin_php?.length > 50) fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);

    } catch (e) {
        console.error("ERROR:", e.message);
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify({
            sections: [{ type: 'text', props: { content: `<div style="color:red">Build Error: ${e.message}</div>` } }]
        }));
        process.exit(0);
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    const MAX = 800000;
    
    function walk(d) {
        if (summary.length >= MAX) return;
        const files = fs.readdirSync(d);
        for (const f of files) {
            const fp = path.join(d, f);
            if (fs.statSync(fp).isDirectory()) {
                if (!['node_modules', '.git', 'dist', 'build', 'bin', 'obj'].includes(f)) walk(fp);
            } else {
                // Expanded extensions list to catch content
                if (f.match(/\.(js|jsx|ts|tsx|html|php|vue|json|md|txt|css)$/i)) {
                    if (f.includes('package-lock') || f.includes('yarn.lock')) continue;
                    try {
                        const content = fs.readFileSync(fp, 'utf8');
                        // Label file paths so AI knows context
                        summary += `\n--- FILE: ${f} ---\n${content}\n`;
                    } catch(e) {}
                }
            }
        }
    }
    walk(dir);
    return summary;
}

function debugFileList(dir) {
    function walk(d) {
        fs.readdirSync(d).forEach(f => {
            const fp = path.join(d, f);
            if(fs.statSync(fp).isDirectory()) walk(fp);
            else console.log("Found:", fp);
        });
    }
    walk(dir);
}

run();
