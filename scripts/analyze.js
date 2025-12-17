const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

// The "Ladder" - The script will try these in order until one works.
const MODEL_LADDER = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro",
    "gemini-1.5-pro-latest",
    "gemini-pro" // The "Old Reliable" fallback (v1.0)
];

async function run() {
    try {
        console.log("----------------------------------------");
        console.log("GLB Enterprise Architect v9.3 (Ladder)");
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Load Context
        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        const context = JSON.parse(contextRaw);
        console.log(`Context Loaded: ${context.site_name || 'WP Site'}`);

        // 2. Extract Source
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        
        // 3. Initialize Gemini Client
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        // 4. Construct Engineering Prompt
        const systemPrompt = `
        YOU ARE: A Senior WordPress Layout Architect.
        TARGET BUILDER: ${args.builder}.
        
        TASK: Convert React/Angular Code to Native WordPress Builder Modules.
        
        CRITICAL RULES FOR DIVI/ELEMENTOR:
        1. **AVOID RAW HTML**. Use specific module types whenever possible.
        2. **Pricing Tables**: Detect pricing lists and map to type "pricing".
        3. **FAQs/Toggles**: Detect question/answer lists and map to type "accordion".
        4. **Feature Grids**: Detect icons+text grids and map to type "blurb_grid".
        5. **Video**: Detect youtube/vimeo iframes and map to type "video".
        
        ECOSYSTEM RULES:
        - If 'divi_machine' is true in context: Use 'machine_loop' for dynamic data.
        - If 'woocommerce' is true: Use 'shop_grid' for products.
        
        OUTPUT FORMAT (Strict JSON):
        {
            "layout": {
                "sections": [
                    { 
                        "type": "hero|pricing|accordion|blurb_grid|video|testimonial|shop_grid|contact_form|text", 
                        "props": { 
                            "title": "...", 
                            "items": [ {"title":"Basic", "price":"$10", "features":["A","B"]} ]
                        }, 
                        "html": "fallback html only if complex" 
                    }
                ]
            },
            "custom_plugin_php": "<?php ... ?>"
        }
        `;

        // 5. Try Models in Sequence
        let result = null;
        let usedModel = "";

        for (const modelName of MODEL_LADDER) {
            console.log(`Attempting Model: ${modelName}...`);
            try {
                // Adjust context size based on model capability
                // 1.5 models = 1M tokens (huge)
                // gemini-pro (1.0) = 30k tokens (small)
                const isLegacy = modelName.includes("gemini-pro") && !modelName.includes("1.5");
                const maxChars = isLegacy ? 25000 : 300000;
                
                const codeSummary = generateCodeSummary('extracted_source', maxChars);
                if(isLegacy) console.log(`Legacy Model detected. Truncated source to ${maxChars} chars.`);

                const userMessage = `
                SITE CONTEXT: ${contextRaw}
                SOURCE CODE: ${codeSummary}
                `;

                const model = genAI.getGenerativeModel({ model: modelName });
                result = await model.generateContent([systemPrompt, userMessage]);
                usedModel = modelName;
                console.log("✅ Success!");
                break; // Stop loop on success

            } catch (e) {
                console.warn(`❌ ${modelName} Failed: ${e.message.split(':')[0]} (404/400)`);
                // Continue to next model
            }
        }

        if (!result) {
            throw new Error("All AI Models failed. Check API Key permissions.");
        }

        const response = result.response;
        let text = response.text();

        // Clean Markdown
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        // Parse
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error("JSON Parse Error. Raw text:", text);
            throw new Error("Invalid JSON from AI");
        }

        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(data.layout, null, 2));
        console.log(`Generated Layout using ${usedModel}: ${data.layout.sections.length} sections.`);

        if (data.custom_plugin_php && data.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, data.custom_plugin_php);
            console.log("Custom Plugin PHP generated.");
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        const errorLayout = {
            sections: [{
                type: 'text',
                props: {},
                html: `<div style="padding:50px;background:#ffebee;color:#c62828;border:1px solid #ef9a9a;"><h3>AI Generation Failed</h3><p>${error.message}</p></div>`
            }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0);
    }
}

function generateCodeSummary(dir, maxChars) {
    let summary = "";
    
    function walk(directory) {
        if (summary.length >= maxChars) return;
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'build', 'dist', 'assets', 'images'].includes(file)) continue;
                walk(fullPath);
            } else {
                if (file.match(/\.(js|jsx|ts|tsx|html|vue|php)$/i)) {
                    if (file.includes('test') || file.includes('spec')) continue;
                    const content = fs.readFileSync(fullPath, 'utf8');
                    // Aggressive minification to fit legacy models
                    const clean = content.replace(/\s+/g, ' ').substring(0, 5000); 
                    summary += `\n--- ${file} ---\n${clean}\n`;
                }
            }
        }
    }
    walk(dir);
    return summary;
}

run();
