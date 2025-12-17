const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

async function run() {
    try {
        console.log("----------------------------------------");
        console.log("GLB Enterprise Architect v14.0 (Tier 1)");
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');

        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Scanned: ${codeSummary.length} chars`);

        // Prompt
        const systemPrompt = `
        ROLE: Expert WordPress Architect.
        TARGET: ${args.builder}.
        TASK: Convert React/Angular App to Native WordPress.

        RULES:
        1. Use Native Modules: "pricing", "accordion", "hero", "blurb_grid", "video".
        2. Database: If data fetch detected, use 'machine_loop' (if divi_machine active) or 'blog_grid'.
        3. Security: Wrap DB writes in 'if (!defined("GLB_PREVIEW_MODE"))'.

        OUTPUT JSON SCHEMA:
        {
            "layout": { "sections": [ { "type": "hero|pricing|text", "props": {}, "html": "..." } ] },
            "custom_plugin_php": "<?php ... (full code or null) ?>"
        }`;

        const userMessage = `CONTEXT: ${contextRaw}\n\nCODE:\n${codeSummary}`;

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");

        // DIRECT FETCH to Gemini 1.5 Flash (Stable v1)
        // This avoids SDK versioning errors completely
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        
        console.log("Requesting Gemini 1.5 Flash...");

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userMessage }] }],
                generationConfig: { response_mime_type: "application/json", temperature: 0.1 }
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(`API Error ${response.status}: ${JSON.stringify(err)}`);
        }

        const data = await response.json();
        const text = data.candidates[0].content.parts[0].text;
        
        // Parse
        const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const output = JSON.parse(clean);

        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(output.layout, null, 2));
        console.log(`Layout Saved: ${output.layout.sections.length} sections.`);

        if (output.custom_plugin_php && output.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);
            console.log("Custom Plugin Saved.");
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error.message);
        const errJson = {
            sections: [{ type: 'text', props: {}, html: `<div style="color:red;padding:20px;"><h3>Architect Failed</h3><p>${error.message}</p></div>` }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errJson));
        process.exit(0);
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    function walk(directory) {
        if (summary.length > 500000) return; // 1M Token Limit allows large context
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'dist'].includes(file)) continue;
                walk(fullPath);
            } else if (file.match(/\.(js|jsx|ts|tsx|html|php|css)$/i)) {
                if (file.includes('lock') || file.includes('config')) continue;
                summary += `\n--- ${file} ---\n${fs.readFileSync(fullPath, 'utf8')}\n`;
            }
        }
    }
    walk(dir);
    return summary;
}

run();
