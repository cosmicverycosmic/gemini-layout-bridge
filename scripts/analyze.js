const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

// Model Configuration
// Using the specific 2.0 Flash Lite Preview endpoint
const MODEL_NAME = "gemini-2.0-flash-lite-preview-02-05";
const API_VERSION = "v1beta"; 

async function run() {
    try {
        console.log("----------------------------------------");
        console.log(`GLB Architect (Model: ${MODEL_NAME})`);
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Validate Inputs
        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        
        // 2. Extract Source Code
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Scanned: ${codeSummary.length} chars`);

        // 3. Prepare AI Request
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");

        const systemPrompt = `
        ROLE: Expert WordPress Architect.
        TARGET BUILDER: ${args.builder}.
        TASK: Convert React/Angular App to Native WordPress Layouts.

        RULES:
        1. **Modules**: Use native modules where possible (e.g., "pricing", "accordion", "hero", "blurb_grid", "video").
        2. **Ecosystem**: If 'divi_machine' is active, use 'machine_loop'. If 'woocommerce', use 'shop_grid'.
        3. **Security**: Wrap DB writes in 'if (!defined("GLB_PREVIEW_MODE"))'.

        OUTPUT JSON SCHEMA:
        {
            "layout": { "sections": [ { "type": "hero|pricing|text", "props": {}, "html": "..." } ] },
            "custom_plugin_php": "<?php ... (full code or null) ?>"
        }`;

        const userMessage = `CONTEXT: ${contextRaw}\n\nCODE:\n${codeSummary}`;

        // 4. Raw REST Fetch (Bypassing SDK issues)
        const url = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
        
        console.log(`Sending request to ${MODEL_NAME}...`);

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
            const errBody = await response.text();
            throw new Error(`Gemini API Error (${response.status}): ${errBody}`);
        }

        const data = await response.json();
        
        // 5. Parse Response
        if (!data.candidates || !data.candidates[0].content) {
            throw new Error("Empty response from AI model.");
        }

        const rawText = data.candidates[0].content.parts[0].text;
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        let output;
        try {
            output = JSON.parse(cleanJson);
        } catch (e) {
            throw new Error("Failed to parse JSON from AI response: " + rawText.substring(0, 100));
        }

        // 6. Save Artifacts
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(output.layout, null, 2));
        console.log(`Layout Saved: ${output.layout.sections.length} sections.`);

        if (output.custom_plugin_php && output.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);
            console.log("Custom Plugin Saved.");
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error.message);
        const errorLayout = {
            sections: [{ 
                type: 'text', 
                props: {}, 
                html: `<div style="padding:20px;border:1px solid red;color:red;"><h3>AI Error</h3><p>${error.message}</p></div>` 
            }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0);
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    // Flash Lite has 1M context, we can be generous
    const MAX_CHARS = 500000; 
    
    function walk(directory) {
        if (summary.length >= MAX_CHARS) return;
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'dist', 'build'].includes(file)) continue;
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
