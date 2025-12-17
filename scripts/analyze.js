const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

// Configuration
// gemini-1.5-flash is the most cost-effective model ($0.075/1M tokens)
const MODEL_NAME = "gemini-1.5-flash"; 
const API_VERSION = "v1beta";

async function run() {
    try {
        console.log("----------------------------------------");
        console.log(`GLB Architect v14 (Tier 1: ${MODEL_NAME})`);
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Validate Inputs
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY is missing from environment variables.");

        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        
        // 2. Extract Source
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Scanned: ${codeSummary.length} characters`);

        // 3. Prepare Prompt
        const systemPrompt = `
        YOU ARE: A Senior WordPress Architect.
        TARGET BUILDER: ${args.builder}.
        
        TASK: Map React/Angular source code to a Native WordPress Layout.
        
        RULES:
        1. **Native Modules**: Use specific types like "pricing", "accordion", "hero", "blurb_grid", "video".
        2. **Ecosystem**: If 'divi_machine' is active, use 'machine_loop'. If 'woocommerce', use 'shop_grid'.
        3. **Security**: Wrap DB writes in 'if (!defined("GLB_PREVIEW_MODE"))'.
        
        OUTPUT FORMAT (JSON ONLY):
        {
            "layout": {
                "sections": [
                    { "type": "hero|pricing|text", "props": {"title":"..."}, "html": "..." }
                ]
            },
            "custom_plugin_php": "<?php ..."
        }`;

        const userMessage = `SITE CONTEXT: ${contextRaw}\n\nSOURCE CODE:\n${codeSummary}`;

        // 4. Call Gemini API (Bare Metal REST)
        console.log(`Sending to Google (${MODEL_NAME})...`);
        
        const url = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
        
        const payload = {
            contents: [{
                parts: [{ text: systemPrompt + "\n\n" + userMessage }]
            }],
            generationConfig: {
                response_mime_type: "application/json",
                temperature: 0.2
            }
        };

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API Failed [${response.status}]: ${errText}`);
        }

        const data = await response.json();
        
        // 5. Parse Response
        let text = "";
        try {
            text = data.candidates[0].content.parts[0].text;
        } catch (e) {
            throw new Error("Unexpected API Response format: " + JSON.stringify(data));
        }

        console.log("✅ AI Response Received.");

        const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonOut = JSON.parse(clean);
        
        // 6. Save Artifacts
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(jsonOut.layout, null, 2));
        console.log(`Layout Saved: ${jsonOut.layout.sections.length} sections.`);

        if (jsonOut.custom_plugin_php && jsonOut.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, jsonOut.custom_plugin_php);
            console.log("Custom Plugin Saved.");
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        
        // Create an error layout so the user sees feedback in WP
        const errorLayout = {
            sections: [{
                type: 'text',
                props: {},
                html: `<div style="padding:20px;background:#ffebee;color:#c62828;border:1px solid red;">
                        <h3>AI Generation Failed</h3>
                        <p><strong>Error:</strong> ${error.message}</p>
                       </div>`
            }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0); // Exit 0 ensures artifacts upload despite error
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    // Flash has 1M context. We can safely send 500k chars (~125k tokens) without breaking bank.
    const MAX_CHARS = 500000; 
    
    function walk(directory) {
        if (summary.length >= MAX_CHARS) return;
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'build', 'dist', 'assets', 'images', 'vendor'].includes(file)) continue;
                walk(fullPath);
            } else {
                if (file.match(/\.(js|jsx|ts|tsx|html|php|css)$/i)) {
                    if(file.includes('lock') || file.includes('config')) continue;
                    
                    const content = fs.readFileSync(fullPath, 'utf8');
                    summary += `\n--- FILE: ${file} ---\n${content}\n`;
                }
            }
        }
    }
    walk(dir);
    return summary;
}

run();
