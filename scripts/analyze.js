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
        console.log("GLB Enterprise Architect v13.1 (Tier 1)");
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Load Context & Extract Code
        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        const context = JSON.parse(contextRaw);

        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Scanned: ${codeSummary.length} chars`);

        // 2. Prepare the AI Prompt
        const systemPrompt = `
        ROLE: Expert WordPress Architect.
        TASK: Convert the provided Frontend App into Native WordPress Layout.
        TARGET: ${args.builder}.

        MAPPING RULES:
        1. USE NATIVE MODULES: "pricing", "accordion", "hero", "blurb_grid", "video", "testimonial".
        2. DATABASE: If code fetches data (e.g., fetch('/posts')), map to 'machine_loop' if divi_machine is true, or 'blog_grid'.
        3. SECURITY: In custom PHP, wrap database operations in: if (!defined('GLB_PREVIEW_MODE')).

        OUTPUT JSON SCHEMA:
        {
            "layout": { "sections": [ { "type": "hero|pricing|text", "props": {}, "html": "..." } ] },
            "custom_plugin_php": "<?php ... (full code or null) ?>"
        }`;

        const userMessage = `SITE CONTEXT: ${contextRaw}\n\nAPP CODE:\n${codeSummary}`;

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("API Key is missing from Environment.");

        // 3. Request to Gemini 1.5 Flash (Cheapest & Fast)
        // Using the stable production path
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        
        console.log("Requesting Gemini 1.5 Flash (Production Endpoint)...");

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userMessage }] }],
                generationConfig: { 
                    response_mime_type: "application/json",
                    temperature: 0.1 
                }
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(`API Error ${response.status}: ${err.error?.message || 'Unknown'}`);
        }

        const data = await response.json();
        const text = data.candidates[0].content.parts[0].text;
        console.log("✅ AI Analysis Received.");

        // 4. Clean & Parse
        const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const output = JSON.parse(cleanJson);

        // 5. Save Artifacts
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(output.layout, null, 2));
        console.log(`Layout Saved: ${output.layout.sections.length} sections.`);

        if (output.custom_plugin_php && output.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);
            console.log("Custom Plugin Logic Saved.");
        }

    } catch (error) {
        console.error("CRITICAL ARCHITECT ERROR:", error.message);
        // Ensure WP gets an error message instead of a blank page
        const errorLayout = {
            sections: [{ type: 'text', props: {}, html: `<div style="padding:50px;border:2px solid red;color:red;"><h3>Architect Failed</h3><p>${error.message}</p></div>` }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0);
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    function walk(directory) {
        if (summary.length > 400000) return;
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'dist'].includes(file)) continue;
                walk(fullPath);
            } else if (file.match(/\.(js|jsx|ts|tsx|html|php)$/i)) {
                if (file.includes('lock') || file.includes('config')) continue;
                summary += `\n--- ${file} ---\n${fs.readFileSync(fullPath, 'utf8').replace(/\s+/g, ' ')}\n`;
            }
        }
    }
    walk(dir);
    return summary;
}

run();
