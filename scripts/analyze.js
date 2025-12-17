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

async function run() {
    try {
        console.log("----------------------------------------");
        console.log("GLB Enterprise Architect v9.1");
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Load Context
        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        const context = JSON.parse(contextRaw);
        console.log(`Context Loaded: ${context.site_name}`);

        // 2. Extract Source
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Summarized: ${codeSummary.length} chars`);

        // 3. Initialize Gemini
        // IMPORTANT: Gemini 1.5 Pro requires the v1beta API version in many environments.
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-pro",
            apiVersion: "v1beta" // Explicitly force v1beta to avoid 404 on v1
        });

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
        6. **Testimonials**: Detect quotes and map to type "testimonial".
        
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

        const userMessage = `
        SITE CONTEXT: ${contextRaw}
        SOURCE CODE: ${codeSummary}
        `;

        console.log("Sending Analysis Request to Gemini (v1beta)...");
        const result = await model.generateContent([systemPrompt, userMessage]);
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
        console.log(`Generated Layout: ${data.layout.sections.length} sections.`);

        if (data.custom_plugin_php && data.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, data.custom_plugin_php);
        }

    } catch (error) {
        console.error("ARCHITECT ERROR:", error);
        // Fallback Error Layout
        const errorLayout = {
            sections: [{
                type: 'text',
                props: {},
                html: `<div style="padding:50px;background:#ffebee;color:#c62828;border:1px solid #ef9a9a;"><h3>AI Generation Failed</h3><p>${error.message}</p><p>Check GitHub Actions logs for details.</p></div>`
            }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0);
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    const MAX_CHARS = 100000;
    
    function walk(directory) {
        if (summary.length >= MAX_CHARS) return;
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
                    summary += `\n--- FILE: ${file} ---\n${content.replace(/\s+/g, ' ')}\n`;
                }
            }
        }
    }
    walk(dir);
    return summary;
}

run();
